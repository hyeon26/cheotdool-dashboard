export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';

  // 쿠키에서 네이버 OAuth 토큰 읽기
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [decodeURIComponent(k.trim()), v.join('=')];
    })
  );

  let naverToken = cookies.naver_access_token || '';
  const refreshToken = cookies.naver_refresh_token || '';

  // 액세스 토큰 없고 리프레시 토큰 있으면 갱신
  if (!naverToken && refreshToken) {
    try {
      const refreshRes = await fetch('https://nid.naver.com/oauth2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.NAVER_CLIENT_ID,
          client_secret: process.env.NAVER_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      const refreshData = await refreshRes.json();
      if (refreshData.access_token) {
        naverToken = refreshData.access_token;
        res.setHeader('Set-Cookie', `naver_access_token=${naverToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*30}`);
      }
    } catch (e) {}
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
    ...(naverToken ? { 'Authorization': `Bearer ${naverToken}` } : {}),
  };

  try {
    const detailRes = await fetch(
      `https://api.chzzk.naver.com/service/v3/channels/${CHANNEL_ID}/live-detail`,
      { headers }
    );
    const detail = await detailRes.json();

    const chatChannelId = detail?.content?.chatChannelId;
    const status = detail?.content?.status;
    const liveTitle = detail?.content?.liveTitle || '';

    if (!chatChannelId) {
      return res.status(200).json({
        content: { status: 'CLOSED', chatChannelId: CHANNEL_ID, accessToken: '', liveTitle: '' },
        needLogin: !naverToken,
      });
    }

    const tokenRes = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
      { headers }
    );
    const tokenData = await tokenRes.json();
    const chatToken = tokenData?.content?.accessToken || '';

    res.status(200).json({
      content: { status, chatChannelId, accessToken: chatToken, liveTitle },
      needLogin: !naverToken,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
