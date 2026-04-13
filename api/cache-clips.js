import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, setDoc, collection, writeBatch } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCe3izM-r1ljlhO5YKyBe_3jEHvXxHy7Yw",
  projectId: "firstandsecond-b449c",
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const CHANNEL_ID = '48070f8882233efa7aee52519fee8fca';
  const API_KEY = process.env.YOUTUBE_API_KEY;

  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
  };

  try {
    // Firebase 초기화
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const db = getFirestore(app);

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
        ytShorts.push(...(data?.items || []).map(v => ({ id: v.id.videoId, snippet: v.snippet })));
        pageToken = data?.nextPageToken || null;
      } while (pageToken);
    }

    // 유튜브 조회수
    const viewsMap = {};
    for (let i = 0; i < ytShorts.length; i += 50) {
      const batch = ytShorts.slice(i, i + 50).map(v => v.id).join(',');
      const statsData = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch}&key=${API_KEY}`
      ).then(r => r.json());
      (statsData?.items || []).forEach(v => {
        viewsMap[v.id] = parseInt(v.statistics?.viewCount || 0);
      });
    }

    const ytItems = ytShorts.map(v => ({
      type: 'youtube', id: v.id, title: v.snippet.title,
      thumb: v.snippet.thumbnails?.medium?.url || null,
      duration: null, views: viewsMap[v.id] || 0,
      date: v.snippet.publishedAt, adult: false
    }));

    // 날짜순 정렬
    const all = [...chzzkClips, ...ytItems].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Firebase에 저장 - 메타 문서 + 50개씩 청크
    const CHUNK_SIZE = 500;
    for (let i = 0; i < all.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = all.slice(i, i + CHUNK_SIZE);
      const chunkIndex = Math.floor(i / CHUNK_SIZE);
      batch.set(doc(db, 'clipCache', `chunk_${chunkIndex}`), {
        clips: chunk,
        updatedAt: new Date().toISOString()
      });
      await batch.commit();
    }

    // 메타 정보 저장
    await setDoc(doc(db, 'clipCache', 'meta'), {
      total: all.length,
      chunks: Math.ceil(all.length / CHUNK_SIZE),
      updatedAt: new Date().toISOString()
    });

    res.status(200).json({ success: true, total: all.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
