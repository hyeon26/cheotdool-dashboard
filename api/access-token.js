// Vercel 서버리스 함수 - 채팅 액세스 토큰 발급
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { channelId } = req.query;
  
  if (!channelId) {
    return res.status(400).json({ error: 'channelId required' });
  }
  
  try {
    const response = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${channelId}&chatType=STREAMING`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
