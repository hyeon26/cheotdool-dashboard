export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  const API_KEY = process.env.YOUTUBE_API_KEY;

  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://chzzk.naver.com/',
  };

  try {
    const [clipRes, ytRes] = await Promise.all([
      fetch(`https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&size=5`, { headers }).then(r=>r.json()),
      fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=UC73LrMO5EoAFJS_G7YsKRSw&type=video&videoDuration=short&order=date&maxResults=5&key=${API_KEY}`).then(r=>r.json())
    ]);

    const chzzk = (clipRes?.content?.data||[]).map(c=>({ title: c.clipTitle, date: c.createdDate }));
    const yt = (ytRes?.items||[]).map(v=>({ title: v.snippet.title, date: v.snippet.publishedAt }));

    res.status(200).json({ chzzk, yt });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
