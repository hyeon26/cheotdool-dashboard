export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  
  try {
    // comm-api 쪽으로 채널 정보 가져오기 시도
    const response = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${CHANNEL_ID}&chatType=STREAMING`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://chzzk.naver.com/',
          'Origin': 'https://chzzk.naver.com',
        }
      }
    );
    const tokenData = await response.json();
    
    // accessToken이 있으면 방송 중 + chatChannelId = CHANNEL_ID
    if(tokenData?.content?.accessToken) {
      res.status(200).json({
        content: {
          status: 'OPEN',
          chatChannelId: CHANNEL_ID,
          accessToken: tokenData.content.accessToken
        }
      });
    } else {
      res.status(200).json({
        content: {
          status: 'CLOSED',
          chatChannelId: CHANNEL_ID,
          accessToken: ''
        }
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
