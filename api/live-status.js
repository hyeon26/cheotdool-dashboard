// Vercel 서버리스 함수 - 치지직 라이브 상태 확인
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  
  try {
    const response = await fetch(
      `https://api.chzzk.naver.com/polling/v1/channels/${CHANNEL_ID}/live-status`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
