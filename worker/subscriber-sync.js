import http from 'node:http';
import { URL } from 'node:url';
import { openSubscriberStore } from './subscriber-store.js';

const CHANNEL_ID = process.env.CHZZK_CHANNEL_ID || '48070f8882233efa7aee52519fee8fca';
const SITE_URL = trimTrailingSlash(process.env.PUBLIC_SITE_URL || 'https://firstandsecond.vercel.app');
const PORT = Number(process.env.SUBSCRIBER_SYNC_PORT || process.env.PORT || 8789);
const TOKEN = process.env.SUBSCRIBER_SYNC_TOKEN || process.env.CHAT_API_TOKEN || '';
const PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.SUBSCRIBER_SYNC_PAGE_SIZE || 100)));
const PAGE_DELAY_MS = Math.max(0, Number(process.env.SUBSCRIBER_SYNC_PAGE_DELAY_MS || 150));
const RUN_HOUR_KST = clamp(Number(process.env.SUBSCRIBER_SYNC_RUN_HOUR_KST || 12), 0, 23);
const RUN_MINUTE_KST = clamp(Number(process.env.SUBSCRIBER_SYNC_RUN_MINUTE_KST || 0), 0, 59);
const COOKIE_CACHE_MS = Math.max(30_000, Number(process.env.SUBSCRIBER_COOKIE_CACHE_MS || 300_000));
const AUTO_SYNC = process.env.SUBSCRIBER_SYNC_DISABLED !== '1';
const BOOT_SYNC = process.env.SUBSCRIBER_SYNC_BOOT === '1';

const store = openSubscriberStore();
let cachedNidCookie = '';
let cachedNidCookieAt = 0;
let syncTimer = null;
const syncState = {
  running: false,
  lastStartedAt: '',
  lastFinishedAt: '',
  lastError: '',
  lastReason: '',
  lastResult: null,
  nextRunAt: AUTO_SYNC ? nextScheduledKstIso() : ''
};

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (TOKEN && req.headers['x-chat-api-token'] !== TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, service: 'subscriber-sync' });
    if (req.method === 'GET' && url.pathname === '/status') return sendJson(res, 200, getStatus());
    if (req.method === 'GET' && url.pathname === '/events') return sendJson(res, 200, { ...getStatus(), events: store.listSubscriberEvents(url.searchParams.get('limit') || 100) });
    if (req.method === 'GET' && url.pathname === '/subscribers') {
      return sendJson(res, 200, {
        code: 200,
        message: null,
        content: store.listSubscribers({
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
  if (BOOT_SYNC) runSync('boot');
  if (AUTO_SYNC) scheduleNextSync();
});

function runSync(reason = 'manual') {
  if (syncState.running) return false;
  syncState.running = true;
  syncState.lastStartedAt = new Date().toISOString();
  syncState.lastReason = reason;
  syncState.lastError = '';

  (async () => {
    try {
      log(`sync started: ${reason}`);
      const subscribers = await fetchAllSubscribers();
      const result = store.syncSubscribers(subscribers);
      syncState.lastResult = result;
      syncState.lastFinishedAt = new Date().toISOString();
      log(`sync finished: total=${result.total}, added=${result.added}, removed=${result.removed}, skipped=${Boolean(result.skipped)}`);
    } catch (error) {
      syncState.lastError = error.message;
      syncState.lastFinishedAt = new Date().toISOString();
      log(`sync failed: ${error.message}`);
    } finally {
      syncState.running = false;
      if (AUTO_SYNC) scheduleNextSync();
    }
  })();

  return true;
}

function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncState.nextRunAt = nextScheduledKstIso();
  const delay = Math.max(1_000, new Date(syncState.nextRunAt).getTime() - Date.now());
  syncTimer = setTimeout(() => runSync('daily'), delay);
}

async function fetchAllSubscribers() {
  const first = await fetchSubscriberPage(0);
  const content = first?.content || {};
  const rows = extractRows(content);
  const totalCount = Number(content.totalCount ?? content.total ?? rows.length ?? 0);
  const totalPages = Math.max(1, Number(content.totalPages || Math.ceil(totalCount / PAGE_SIZE) || 1));
  const subscribers = [...rows];

  for (let page = 1; page < totalPages; page += 1) {
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
    const data = await fetchSubscriberPage(page);
    subscribers.push(...extractRows(data?.content || {}));
  }

  return subscribers;
}

async function fetchSubscriberPage(page) {
  const cookie = await getNidCookie();
  if (!cookie) throw new Error('CHZZK cookie missing');
  const params = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE), userNickname: '' });
  const customPath = process.env.SUBSCRIBER_SYNC_PATH;
  const urls = customPath
    ? [buildSubscriberUrl(customPath, params)]
    : [
        `https://api.chzzk.naver.com/manage/v1/channels/${CHANNEL_ID}/subscribers?${params.toString()}`,
        `https://api.chzzk.naver.com/manage/v1/channels/${CHANNEL_ID}/subscriber?${params.toString()}`
      ];
  let lastError;
  for (const target of urls) {
    try {
      return await fetchJson(target, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': `https://studio.chzzk.naver.com/${CHANNEL_ID}/subscriber`,
        'Origin': 'https://studio.chzzk.naver.com',
        'Cookie': cookie
      });
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 404) break;
    }
  }
  throw lastError || new Error('subscriber endpoint failed');
}

function buildSubscriberUrl(customPath, params) {
  const replaced = customPath.replace('{channelId}', CHANNEL_ID);
  const base = replaced.startsWith('http') ? replaced : `https://api.chzzk.naver.com${replaced.startsWith('/') ? '' : '/'}${replaced}`;
  const url = new URL(base);
  params.forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

function extractRows(content = {}) {
  if (Array.isArray(content)) return content;
  if (Array.isArray(content.data)) return content.data;
  if (Array.isArray(content.subscribers)) return content.subscribers;
  if (Array.isArray(content.list)) return content.list;
  if (Array.isArray(content.items)) return content.items;
  return [];
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
      'User-Agent': 'cheotdool-subscriber-sync/1.0'
    });
    cachedNidCookie = [data?.nidAut ? `NID_AUT=${data.nidAut}` : '', data?.nidSes ? `NID_SES=${data.nidSes}` : ''].filter(Boolean).join('; ');
    cachedNidCookieAt = Date.now();
    return cachedNidCookie;
  } catch (error) {
    log(`cookie sync failed: ${error.message}`);
    return '';
  }
}

function getStatus() {
  return {
    service: 'subscriber-sync',
    runHourKst: RUN_HOUR_KST,
    runMinuteKst: RUN_MINUTE_KST,
    running: syncState.running,
    lastStartedAt: syncState.lastStartedAt,
    lastFinishedAt: syncState.lastFinishedAt,
    lastError: syncState.lastError,
    lastReason: syncState.lastReason,
    lastResult: syncState.lastResult,
    nextRunAt: syncState.nextRunAt,
    stats: store.getSubscriberStats(),
    dailyStats: store.getSubscriberDailyStats()
  };
}

function nextScheduledKstIso(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let targetKstMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), RUN_HOUR_KST, RUN_MINUTE_KST, 0, 0);
  if (targetKstMs <= kst.getTime()) targetKstMs += 24 * 60 * 60 * 1000;
  return new Date(targetKstMs - 9 * 60 * 60 * 1000).toISOString();
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

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
