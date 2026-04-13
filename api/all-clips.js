export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  const API_KEY = process.env.YOUTUBE_API_KEY;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
  };

  try {
    // 치지직 전체 클립
    const chzzkClips = [];
    let nextUID = null;
    do {
      const url = nextUID
        ? `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&size=50&clipUID=${nextUID}`
        : `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&size=50`;
      const data = await fetch(url, { headers }).then(r => r.json());
      (data?.content?.data || []).forEach(c => chzzkClips.push({
        type: 'chzzk', id: c.clipUID, title: c.clipTitle,
        thumb: c.thumbnailImageUrl, duration: c.duration,
        views: c.readCount, date: c.createdDate, adult: c.adult
      }));
      nextUID = data?.content?.page?.next?.clipUID || null;
    } while (nextUID);

    // 유튜브 채널 ID
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=_brother-siste&key=${API_KEY}`
    ).then(r => r.json());
    const ytChannelId = chRes?.items?.[0]?.id;

    // 유튜브 쇼츠 목록
    const ytShorts = [];
    let pageToken = null;
    if (ytChannelId) {
      do {
        const url = new URL('https://www.googleapis.com/youtube/v3/search');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('channelId', ytChannelId);
        url.searchParams.set('type', 'video');
        url.searchParams.set('videoDuration', 'short');
        url.searchParams.set('order', 'date');
        url.searchParams.set('maxResults', '50');
        url.searchParams.set('key', API_KEY);
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const data = await fetch(url.toString()).then(r => r.json());
        (data?.items || []).forEach(v => ytShorts.push({
          id: v.id.videoId,
          title: v.snippet.title,
          thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
          date: v.snippet.publishedAt
        }));
        pageToken = data?.nextPageToken || null;
      } while (pageToken);
    }

    // 유튜브 조회수 가져오기 (50개씩 배치)
    const videoIds = ytShorts.map(v => v.id);
    const viewsMap = {};
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50).join(',');
      const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch}&key=${API_KEY}`;
      const statsData = await fetch(statsUrl).then(r => r.json());
      (statsData?.items || []).forEach(v => {
        viewsMap[v.id] = parseInt(v.statistics?.viewCount || 0);
      });
    }

    // 유튜브 쇼츠에 조회수 합치기
    const ytWithViews = ytShorts.map(v => ({
      type: 'youtube', id: v.id, title: v.title,
      thumb: v.thumb, duration: null,
      views: viewsMap[v.id] || 0, date: v.date
    }));

    // 날짜순 정렬
    const all = [...chzzkClips, ...ytWithViews].sort((a, b) => new Date(b.date) - new Date(a.date));
    res.status(200).json({ items: all, total: all.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
