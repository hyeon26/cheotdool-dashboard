export default async function handler(req, res) {
  const service = Array.isArray(req.query.service) ? req.query.service[0] : (req.query.service || 'chat');
  const isFollowerService = service === 'follower';
  const origin = isFollowerService ? process.env.FOLLOWER_SYNC_ORIGIN : process.env.CHAT_STORE_ORIGIN;
  if (!origin) {
    const name = isFollowerService ? 'FOLLOWER_SYNC_ORIGIN' : 'CHAT_STORE_ORIGIN';
    return res.status(500).json({ error: `${name} is not set` });
  }

  const path = Array.isArray(req.query.path) ? req.query.path[0] : (req.query.path || '/health');
  if (!String(path).startsWith('/')) return res.status(400).json({ error: 'invalid path' });

  let target;
  try {
    target = buildTargetUrl(origin, path);
  } catch {
    return res.status(500).json({ error: `invalid ${isFollowerService ? 'FOLLOWER_SYNC_ORIGIN' : 'CHAT_STORE_ORIGIN'}` });
  }

  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || key === 'service') continue;
    if (Array.isArray(value)) value.forEach(item => target.searchParams.append(key, item));
    else if (value != null) target.searchParams.set(key, value);
  }

  const headers = { 'Accept': 'application/json' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const token = isFollowerService
    ? (process.env.FOLLOWER_SYNC_TOKEN || process.env.CHAT_API_TOKEN)
    : process.env.CHAT_API_TOKEN;
  if (token) headers['X-Chat-Api-Token'] = token;

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
    const serviceName = isFollowerService ? 'follower-sync' : 'chat-api';
    const message = error.name === 'AbortError'
      ? `${serviceName} request timed out`
      : `${serviceName} request failed: ${error.message}`;
    res.status(502).json({ error: message, service: serviceName, origin });
  } finally {
    clearTimeout(timeout);
  }
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
