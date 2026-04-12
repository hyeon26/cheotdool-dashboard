export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { channelId } = req.query;
  
  if (!channelId) {
    return res.status(400).json({ error: 'channelId required' });
  }
  
  try {
    const response = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${channelId}&chatType=STREAMING`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://chzzk.naver.com/',
          'Origin': 'https://chzzk.naver.com',
        }
      }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
