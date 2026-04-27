export default function handler(req, res) {
  const state = Math.random().toString(36).substring(2);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.NAVER_CLIENT_ID,
    redirect_uri: process.env.NAVER_REDIRECT_URI,
    state,
  });
  res.setHeader('Set-Cookie', `naver_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.redirect(302, `https://nid.naver.com/oauth2.0/authorize?${params}`);
}
