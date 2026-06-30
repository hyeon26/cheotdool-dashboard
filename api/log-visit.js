export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const body = req.method === 'POST' ? parseBody(req.body) : {};
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown';
    const country = req.headers['x-vercel-ip-country'] || 'unknown';
    const city = req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    const referer = req.headers.referer || '';
    const page = safeText(body.page || req.query.page || '/', 200);
    const action = safeText(body.action || req.query.action || 'visit', 80);
    const target = safeText(body.target || req.query.target || '', 120);
    const detail = safeDetail(body.detail || req.query.detail || '');

    const FIREBASE_PROJECT = 'firstandsecond-b449c';
    const FIREBASE_API_KEY = 'AIzaSyCe3izM-r1ljlhO5YKyBe_3jEHvXxHy7Yw';

    const now = new Date();
    const fields = {
      ip:        { stringValue: ip },
      country:   { stringValue: country },
      city:      { stringValue: city },
      userAgent: { stringValue: userAgent },
      page:      { stringValue: page },
      referer:   { stringValue: referer },
      action:    { stringValue: action },
      target:    { stringValue: target },
      time:      { stringValue: now.toISOString() },
      createdAt: { timestampValue: now.toISOString() }
    };
    if (detail) fields.detail = { stringValue: detail };

    await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/visitLogs?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }
    );

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); }
  catch { return {}; }
}

function safeText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
}

function safeDetail(value) {
  if (value == null || value === '') return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return safeText(text, 1000);
}
