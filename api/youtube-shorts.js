export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { pageToken } = req.query;
  const CHANNEL_ID = 'UCxxxxxxx'; // 채널 ID 필요
  const API_KEY = process.env.YOUTUBE_API_KEY;

  try {
    // 1) 채널 ID 가져오기 (핸들로)
    const handleRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=_brother-siste&key=${API_KEY}`
    );
    const handleData = await handleRes.json();
    const channelId = handleData?.items?.[0]?.id;
    if (!channelId) return res.status(200).json({ items: [], nextPageToken: null });

    // 2) Shorts 검색 (videoDuration=short + 채널)
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('channelId', channelId);
    url.searchParams.set('type', 'video');
    url.searchParams.set('videoDuration', 'short');
    url.searchParams.set('order', 'date');
    url.searchParams.set('maxResults', '20');
    url.searchParams.set('key', API_KEY);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url.toString());
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
