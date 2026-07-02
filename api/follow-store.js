export default async function handler(req, res) {
  const service = Array.isArray(req.query.service) ? req.query.service[0] : (req.query.service || 'follower');
  const serviceConfig = getServiceConfig(service);
  if (!serviceConfig) return res.status(400).json({ error: 'invalid service' });

  const origin = serviceConfig.origin;
  if (!origin) return res.status(500).json({ error: `${serviceConfig.envName} is not set` });

  const path = Array.isArray(req.query.path) ? req.query.path[0] : (req.query.path || '/health');
  if (!String(path).startsWith('/')) return res.status(400).json({ error: 'invalid path' });

  let target;
  try {
    target = buildTargetUrl(origin, path);
  } catch {
    return res.status(500).json({ error: `invalid ${serviceConfig.envName}` });
  }

  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || key === 'service') continue;
    if (Array.isArray(value)) value.forEach(item => target.searchParams.append(key, item));
    else if (value != null) target.searchParams.set(key, value);
  }

  const headers = { 'Accept': 'application/json' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (serviceConfig.token) headers['X-Chat-Api-Token'] = serviceConfig.token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      signal: controller.signal,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });

    const text = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
    res.send(text);
  } catch (error) {
    const message = error.name === 'AbortError'
      ? `${serviceConfig.name} request timed out`
      : `${serviceConfig.name} request failed: ${error.message}`;
    res.status(502).json({ error: message, service: serviceConfig.name, origin });
  } finally {
    clearTimeout(timeout);
  }
}

function getServiceConfig(service) {
  if (service === 'follower') {
    return {
      name: 'follower-sync',
      envName: 'FOLLOWER_SYNC_ORIGIN',
      origin: process.env.FOLLOWER_SYNC_ORIGIN,
      token: process.env.FOLLOWER_SYNC_TOKEN || process.env.CHAT_API_TOKEN
    };
  }
  if (service === 'subscriber') {
    return {
      name: 'subscriber-sync',
      envName: 'SUBSCRIBER_SYNC_ORIGIN',
      origin: process.env.SUBSCRIBER_SYNC_ORIGIN,
      token: process.env.SUBSCRIBER_SYNC_TOKEN || process.env.CHAT_API_TOKEN
    };
  }
  return null;
}

function buildTargetUrl(origin, path) {
  const target = new URL(origin);
  const basePath = target.pathname.replace(/\/+$/, '');
  const next = new URL(String(path), 'http://local');
  const nextPath = next.pathname.replace(/^\/+/, '');
  target.pathname = [basePath, nextPath].filter(Boolean).join('/') || '/';
  next.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target;
}
