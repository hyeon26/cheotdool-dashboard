export default async function handler(req, res) {
  const { code, state } = req.query;

  // state 검증
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent))
  );
  if (!code || !state || state !== cookies.naver_state) {
    return res.status(400).send('Invalid state');
  }

  try {
    // 액세스 토큰 발급
    const tokenRes = await fetch('https://nid.naver.com/oauth2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.NAVER_CLIENT_ID,
        client_secret: process.env.NAVER_CLIENT_SECRET,
        redirect_uri: process.env.NAVER_REDIRECT_URI,
        code,
        state,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(400).json({ error: 'token_failed', detail: tokenData });
    }

    const maxAge = 60 * 60 * 24 * 30; // 30일
    res.setHeader('Set-Cookie', [
      `naver_access_token=${tokenData.access_token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      `naver_refresh_token=${tokenData.refresh_token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      `naver_state=; Path=/; HttpOnly; Max-Age=0`, // state 삭제
    ]);

    // 로그인 완료 후 대시보드로 이동
    res.redirect(302, '/schedule');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
