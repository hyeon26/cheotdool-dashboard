import http from 'node:http';
import { URL } from 'node:url';
import { openFollowerStore } from './follower-store.js';

const CHANNEL_ID = process.env.CHZZK_CHANNEL_ID || '48070f8882233efa7aee52519fee8fca';
const SITE_URL = trimTrailingSlash(process.env.PUBLIC_SITE_URL || 'https://firstandsecond.vercel.app');
const PORT = Number(process.env.FOLLOWER_SYNC_PORT || process.env.PORT || 8788);
const TOKEN = process.env.FOLLOWER_SYNC_TOKEN || process.env.CHAT_API_TOKEN || '';
const INTERVAL_MS = Math.max(60_000, Number(process.env.FOLLOWER_SYNC_INTERVAL_MS || 600_000));
const PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.FOLLOWER_SYNC_PAGE_SIZE || 100)));
const PAGE_DELAY_MS = Math.max(0, Number(process.env.FOLLOWER_SYNC_PAGE_DELAY_MS || 150));
const BOOT_DELAY_MS = Math.max(0, Number(process.env.FOLLOWER_SYNC_BOOT_DELAY_MS || 15_000));
const COOKIE_CACHE_MS = Math.max(30_000, Number(process.env.FOLLOWER_COOKIE_CACHE_MS || 300_000));
const AUTO_SYNC = process.env.FOLLOWER_SYNC_DISABLED !== '1';

const store = openFollowerStore();
let cachedNidCookie = '';
let cachedNidCookieAt = 0;
const syncState = {
  running: false,
  lastStartedAt: '',
  lastFinishedAt: '',
  lastError: '',
  lastReason: '',
  lastResult: null,
  nextRunAt: AUTO_SYNC ? isoAfter(BOOT_DELAY_MS) : ''
};

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (TOKEN && req.headers['x-chat-api-token'] !== TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'follower-sync' });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, getStatus());
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      return sendJson(res, 200, { ...getStatus(), events: store.listFollowerEvents(url.searchParams.get('limit') || 100) });
    }

    if (req.method === 'GET' && url.pathname === '/followers') {
      return sendJson(res, 200, {
        code: 200,
        message: null,
        content: store.listFollowers({
          page: url.searchParams.get('page') || 0,
          size: url.searchParams.get('size') || 50,
          query: url.searchParams.get('userNickname') || url.searchParams.get('nickname') || ''
        })
      });
    }

    if (req.method === 'POST' && url.pathname === '/sync') {
      runSync('manual');
      return sendJson(res, 202, { accepted: true, ...getStatus() });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on ${PORT}`);
  if (AUTO_SYNC) setTimeout(() => runSync('boot'), BOOT_DELAY_MS);
});

if (AUTO_SYNC) {
  setInterval(() => runSync('interval'), INTERVAL_MS);
}

function runSync(reason = 'manual') {
  if (syncState.running) return false;
  syncState.running = true;
  syncState.lastStartedAt = new Date().toISOString();
  syncState.lastReason = reason;
  syncState.lastError = '';
  syncState.nextRunAt = AUTO_SYNC ? isoAfter(INTERVAL_MS) : '';

  (async () => {
    try {
      log(`sync started: ${reason}`);
      const followers = await fetchAllFollowers();
      const result = store.syncFollowers(followers);
      syncState.lastResult = result;
      syncState.lastFinishedAt = new Date().toISOString();
      log(`sync finished: total=${result.total}, added=${result.added}, removed=${result.removed}, skipped=${Boolean(result.skipped)}`);
    } catch (error) {
      syncState.lastError = error.message;
      syncState.lastFinishedAt = new Date().toISOString();
      log(`sync failed: ${error.message}`);
    } finally {
      syncState.running = false;
    }
  })();

  return true;
}

async function fetchAllFollowers() {
  const first = await fetchFollowerPage(0);
  const content = first?.content || {};
  const totalPages = Math.max(1, Number(content.totalPages || Math.ceil(Number(content.totalCount || 0) / PAGE_SIZE) || 1));
  const followers = Array.isArray(content.data) ? [...content.data] : [];

  for (let page = 1; page < totalPages; page += 1) {
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    const data = await fetchFollowerPage(page);
    const rows = data?.content?.data;
    if (Array.isArray(rows)) followers.push(...rows);
  }

  return followers;
}

async function fetchFollowerPage(page) {
  const cookie = await getNidCookie();
  if (!cookie) throw new Error('CHZZK cookie missing');
  const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), userNickname: '' });
  return fetchJson(`https://api.chzzk.naver.com/manage/v1/channels/${CHANNEL_ID}/followers?${params.toString()}`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': `https://studio.chzzk.naver.com/${CHANNEL_ID}/follower`,
    'Origin': 'https://studio.chzzk.naver.com',
    'Cookie': cookie
  });
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { data = { error: text || response.statusText }; }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || response.statusText);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function getNidCookie() {
  const envCookie = [
    process.env.CHZZK_NID_AUT ? `NID_AUT=${process.env.CHZZK_NID_AUT}` : '',
    process.env.CHZZK_NID_SES ? `NID_SES=${process.env.CHZZK_NID_SES}` : ''
  ].filter(Boolean).join('; ');
  if (envCookie) return envCookie;

  const now = Date.now();
  if (cachedNidCookie && now - cachedNidCookieAt < COOKIE_CACHE_MS) return cachedNidCookie;

  try {
    const data = await fetchJson(`${SITE_URL}/api/get-cookies`, {
      'Accept': 'application/json',
      'User-Agent': 'cheotdool-follower-sync/1.0'
    });
    cachedNidCookie = [
      data?.nidAut ? `NID_AUT=${data.nidAut}` : '',
      data?.nidSes ? `NID_SES=${data.nidSes}` : ''
    ].filter(Boolean).join('; ');
    cachedNidCookieAt = Date.now();
    return cachedNidCookie;
  } catch (error) {
    log(`cookie sync failed: ${error.message}`);
    return '';
  }
}

function getStatus() {
  return {
    service: 'follower-sync',
    intervalMs: INTERVAL_MS,
    running: syncState.running,
    lastStartedAt: syncState.lastStartedAt,
    lastFinishedAt: syncState.lastFinishedAt,
    lastError: syncState.lastError,
    lastReason: syncState.lastReason,
    lastResult: syncState.lastResult,
    nextRunAt: syncState.nextRunAt,
    stats: store.getFollowerStats(),
    dailyStats: store.getFollowerDailyStats()
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Chat-Api-Token');
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(status === 204 ? '' : JSON.stringify(data));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}