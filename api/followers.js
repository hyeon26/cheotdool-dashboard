const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const nidCookie = [
    process.env.CHZZK_NID_AUT ? `NID_AUT=${process.env.CHZZK_NID_AUT}` : '',
    process.env.CHZZK_NID_SES ? `NID_SES=${process.env.CHZZK_NID_SES}` : '',
  ].filter(Boolean).join('; ');

  if (!nidCookie) return res.status(401).json({ error: 'cookie missing' });

  const page = toInt(req.query.page, 0, 0, 10000);
  const size = toInt(req.query.size, 50, 1, 100);
  const userNickname = String(req.query.userNickname || req.query.nickname || '').trim();
  const params = new URLSearchParams({ page: String(page), size: String(size), userNickname });
  const url = `https://api.chzzk.naver.com/manage/v1/channels/${CHANNEL_ID}/followers?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': `https://studio.chzzk.naver.com/${CHANNEL_ID}/follower`,
        'Origin': 'https://studio.chzzk.naver.com',
        'Cookie': nidCookie,
      },
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: text || r.statusText }; }

    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || data?.error || r.statusText, detail: data });
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}