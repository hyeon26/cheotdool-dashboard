export default async function handler(req, res) {
  const origin = process.env.CHAT_STORE_ORIGIN;
  if (!origin) return res.status(500).json({ error: 'CHAT_STORE_ORIGIN is not set' });

  const path = Array.isArray(req.query.path) ? req.query.path[0] : (req.query.path || '/health');
  if (!String(path).startsWith('/')) return res.status(400).json({ error: 'invalid path' });

  const target = new URL(path, origin);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path') continue;
    if (Array.isArray(value)) value.forEach(item => target.searchParams.append(key, item));
    else if (value != null) target.searchParams.set(key, value);
  }

  const headers = { 'Accept': 'application/json' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (process.env.CHAT_API_TOKEN) headers['X-Chat-Api-Token'] = process.env.CHAT_API_TOKEN;

  const response = await fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
  });

  const text = await response.text();
  res.status(response.status);
  res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json; charset=utf-8');
  res.send(text);
}
