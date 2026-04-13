export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  const API_KEY = process.env.YOUTUBE_API_KEY;
  const FIREBASE_PROJECT = 'firstandsecond-b449c';
  const FIREBASE_API_KEY = 'AIzaSyCe3izM-r1ljlhO5YKyBe_3jEHvXxHy7Yw';

  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
  };

  try {
    // 치지직 전체 클립 수집
    const chzzkClips = [];
    let nextUID = null;
    do {
      const url = nextUID
        ? `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&size=50&clipUID=${nextUID}`
        : `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?orderType=RECENT&size=50`;
      const data = await fetch(url, { headers }).then(r => r.json());
      (data?.content?.data || []).forEach(c => chzzkClips.push({
        type: 'chzzk', id: c.clipUID, title: c.clipTitle,
        thumb: c.thumbnailImageUrl || null, duration: c.duration,
        views: c.readCount, date: c.createdDate, adult: c.adult || false
      }));
      nextUID = data?.content?.page?.next?.clipUID || null;
    } while (nextUID);

    // 유튜브 채널 ID
    const chRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=_brother-siste&key=${API_KEY}`
    ).then(r => r.json());
    const ytChannelId = chRes?.items?.[0]?.id;

    // 유튜브 쇼츠 수집
    const ytRaw = [];
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
        ytRaw.push(...(data?.items || []));
        pageToken = data?.nextPageToken || null;
      } while (pageToken);
    }

    // 유튜브 조회수
    const viewsMap = {};
    for (let i = 0; i < ytRaw.length; i += 50) {
      const ids = ytRaw.slice(i, i + 50).map(v => v.id.videoId).join(',');
      const statsData = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${API_KEY}`
      ).then(r => r.json());
      (statsData?.items || []).forEach(v => {
        viewsMap[v.id] = parseInt(v.statistics?.viewCount || 0);
      });
    }

    const ytItems = ytRaw.map(v => ({
      type: 'youtube', id: v.id.videoId, title: v.snippet.title,
      thumb: v.snippet.thumbnails?.medium?.url || null,
      duration: null, views: viewsMap[v.id.videoId] || 0,
      date: v.snippet.publishedAt, adult: false
    }));

    // 날짜순 정렬
    const all = [...chzzkClips, ...ytItems].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Firestore REST API로 저장
    const CHUNK_SIZE = 500;
    const chunks = [];
    for (let i = 0; i < all.length; i += CHUNK_SIZE) {
      chunks.push(all.slice(i, i + CHUNK_SIZE));
    }

    const firestoreBase = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

    // 청크 저장
    for (let i = 0; i < chunks.length; i++) {
      const docData = {
        fields: {
          clips: {
            arrayValue: {
              values: chunks[i].map(clip => ({
                mapValue: {
                  fields: {
                    type: { stringValue: clip.type },
                    id: { stringValue: clip.id },
                    title: { stringValue: clip.title },
                    thumb: clip.thumb ? { stringValue: clip.thumb } : { nullValue: null },
                    duration: clip.duration != null ? { integerValue: clip.duration } : { nullValue: null },
                    views: { integerValue: clip.views || 0 },
                    date: { stringValue: clip.date },
                    adult: { booleanValue: clip.adult || false }
                  }
                }
              }))
            }
          },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      };

      await fetch(`${firestoreBase}/clipCache/chunk_${i}?key=${FIREBASE_API_KEY}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(docData)
      });
    }

    // 메타 저장
    await fetch(`${firestoreBase}/clipCache/meta?key=${FIREBASE_API_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          total: { integerValue: all.length },
          chunks: { integerValue: chunks.length },
          updatedAt: { stringValue: new Date().toISOString() }
        }
      })
    });

    res.status(200).json({ success: true, total: all.length, chunks: chunks.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
