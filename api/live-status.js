export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
  };

  try {
    // 1단계: live-detail로 실제 chatChannelId 가져오기
    const detailRes = await fetch(
      `https://api.chzzk.naver.com/service/v3/channels/${CHANNEL_ID}/live-detail`,
      { headers }
    );
    const detail = await detailRes.json();
    
    // 응답 그대로 반환 (디버깅용)
    const chatChannelId = detail?.content?.chatChannelId;
    const status = detail?.content?.status;
    
    if (!chatChannelId) {
      return res.status(200).json({ 
        debug: detail,
        content: { status: 'CLOSED', chatChannelId: CHANNEL_ID, accessToken: '' }
      });
    }

    // 2단계: 실제 chatChannelId로 accessToken 가져오기
    const tokenRes = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers }
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData?.content?.accessToken || '';

    res.status(200).json({
      content: { status, chatChannelId, accessToken }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
