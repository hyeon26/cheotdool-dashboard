export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { year = new Date().getFullYear() } = req.query;

  const nidCookie = [
    process.env.CHZZK_NID_AUT ? `NID_AUT=${process.env.CHZZK_NID_AUT}` : '',
    process.env.CHZZK_NID_SES ? `NID_SES=${process.env.CHZZK_NID_SES}` : '',
  ].filter(Boolean).join('; ');

  if (!nidCookie) return res.status(401).json({ error: '쿠키 없음' });

  try {
    const r = await fetch(
      `https://api.chzzk.naver.com/commercial/v1/product/purchase/history?page=0&size=10000&searchYear=${year}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://chzzk.naver.com/',
          'Origin': 'https://chzzk.naver.com',
          'Cookie': nidCookie,
        }
      }
    );
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
