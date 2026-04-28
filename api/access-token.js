const FIREBASE_PROJECT = 'firstandsecond-b449c';
const FIREBASE_API_KEY = 'AIzaSyCe3izM-r1ljlhO5YKyBe_3jEHvXxHy7Yw';

async function getNidCookie() {
  try {
    const r = await fetch(
      `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/config/chzzkCookies?key=${FIREBASE_API_KEY}`
    );
    const data = await r.json();
    const aut = data?.fields?.NID_AUT?.stringValue || '';
    const ses = data?.fields?.NID_SES?.stringValue || '';
    if(!aut || !ses) return '';
    return `NID_AUT=${aut}; NID_SES=${ses}`;
  } catch(e) { return ''; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { channelId } = req.query;

  if (!channelId) {
    return res.status(400).json({ error: 'channelId required' });
  }

  const nidCookie = await getNidCookie();

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
          ...(nidCookie ? { 'Cookie': nidCookie } : {}),
        }
      }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
