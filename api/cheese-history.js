const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';

function getNidCookie() {
  return [
    process.env.CHZZK_NID_AUT ? `NID_AUT=${process.env.CHZZK_NID_AUT}` : '',
    process.env.CHZZK_NID_SES ? `NID_SES=${process.env.CHZZK_NID_SES}` : '',
  ].filter(Boolean).join('; ');
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { error: text || r.statusText }; }
  if (!r.ok) {
    const err = new Error(data?.message || data?.error || r.statusText);
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const { year = new Date().getFullYear() } = req.query;
  const nidCookie = getNidCookie();

  if (!nidCookie) return res.status(401).json({ error: 'cookie missing' });

  try {
    const data = await fetchJson(
      `https://api.chzzk.naver.com/commercial/v1/product/purchase/history?page=0&size=10000&searchYear=${year}`,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://chzzk.naver.com/',
        'Origin': 'https://chzzk.naver.com',
        'Cookie': nidCookie,
      }
    );
    return res.status(200).json(data);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message, detail: e.detail });
  }
}