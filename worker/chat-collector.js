import WebSocket from 'ws';
import { openChatStore } from './chat-store.js';

const store = openChatStore();

const SITE_URL = trimTrailingSlash(process.env.PUBLIC_SITE_URL || 'https://firstandsecond.vercel.app');
const CHANNEL_ID = process.env.CHZZK_CHANNEL_ID || '48070f8882233efa7aee52519fee8fca';
const POLL_INTERVAL_MS = numberEnv('POLL_INTERVAL_MS', 3000);
const OFFLINE_IDLE_MS = numberEnv('OFFLINE_IDLE_MS', 60000);
const OFFLINE_RECONNECT_LIMIT = numberEnv('OFFLINE_RECONNECT_LIMIT', 5);
const HEARTBEAT_MS = numberEnv('HEARTBEAT_MS', 20000);

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let pollTimer = null;
let sessionId = null;
let sessionStartedAt = null;
let currentLiveTitle = '';
let currentChatChannelId = '';
let lastLiveState = false;
let offlineSince = null;
let lastRecordAt = 0;
let reconnectAttemptsAfterOffline = 0;
let connecting = false;
let stopped = false;

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function log(message, data) {
  const time = new Date().toISOString();
  if (data === undefined) console.log(`[${time}] ${message}`);
  else console.log(`[${time}] ${message}`, data);
}

function isLiveStatus(status) {
  return status === 'OPEN' || status === 'STARTED';
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'cheotdool-chat-collector/1.0'
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function chzzkHeaders() {
  const cookie = [
    process.env.CHZZK_NID_AUT ? `NID_AUT=${process.env.CHZZK_NID_AUT}` : '',
    process.env.CHZZK_NID_SES ? `NID_SES=${process.env.CHZZK_NID_SES}` : ''
  ].filter(Boolean).join('; ');

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': 'https://chzzk.naver.com/',
    'Origin': 'https://chzzk.naver.com',
    ...(cookie ? { Cookie: cookie } : {})
  };
}

async function fetchChzzkLiveStatus() {
  const detail = await fetchJsonWithHeaders(
    `https://api.chzzk.naver.com/service/v3/channels/${CHANNEL_ID}/live-detail`,
    chzzkHeaders()
  );
  const chatChannelId = detail?.content?.chatChannelId;
  const status = detail?.content?.status;
  const liveTitle = detail?.content?.liveTitle || '';

  if (!chatChannelId) {
    return {
      content: {
        status: 'CLOSED',
        chatChannelId: CHANNEL_ID,
        accessToken: '',
        liveTitle: ''
      }
    };
  }

  const tokenData = await fetchChzzkAccessToken(chatChannelId);
  return {
    content: {
      status,
      chatChannelId,
      accessToken: tokenData?.content?.accessToken || '',
      liveTitle
    }
  };
}

async function fetchChzzkAccessToken(channelId) {
  return fetchJsonWithHeaders(
    `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${encodeURIComponent(channelId)}&chatType=STREAMING`,
    chzzkHeaders()
  );
}

async function fetchJsonWithHeaders(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchLiveStatus() {
  try {
    return await fetchJson(`${SITE_URL}/api/live-status`);
  } catch (error) {
    log(`site live-status failed (${error.message}), falling back to CHZZK`);
    return fetchChzzkLiveStatus();
  }
}

async function fetchAccessToken(channelId) {
  try {
    return await fetchJson(`${SITE_URL}/api/access-token?channelId=${encodeURIComponent(channelId)}`);
  } catch (error) {
    log(`site access-token failed (${error.message}), falling back to CHZZK`);
    return fetchChzzkAccessToken(channelId);
  }
}

async function createSession({ liveTitle, chatChannelId }) {
  if (sessionId) return;
  const session = store.createSession({
    liveTitle: liveTitle || '',
    chatChannelId: chatChannelId || '',
    collector: 'oracle-worker'
  });
  sessionId = session.id;
  sessionStartedAt = new Date();
  log(`created chat session ${sessionId}`);
}

async function finishSession(reason) {
  if (!sessionId) return;
  const id = sessionId;
  try {
    store.finishSession(id, reason || 'stopped');
  } catch (error) {
    log(`failed to update session ${id}: ${error.message}`);
  }
  sessionId = null;
  sessionStartedAt = null;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !'[{'.includes(trimmed[0])) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function formatChatTime(date = new Date()) {
  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

async function saveChat(chat) {
  if (!sessionId || !chat?.msg || !chat?.profile) return;
  const profile = parseMaybeJson(chat.profile) || {};
  const nick = profile.nickname || '익명';
  const msg = String(chat.msg || '').trim();
  if (!msg) return;

  lastRecordAt = Date.now();
  reconnectAttemptsAfterOffline = 0;

  store.addChat(sessionId, {
    time: formatChatTime(),
    nick,
    msg,
    createdAt: new Date().toISOString()
  });

  log(`chat saved: ${nick}: ${msg.slice(0, 80)}`);
}

async function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (message.cmd === 0 && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ver: '2', cmd: 10000 }));
    return;
  }

  if (message.cmd !== 93101 || !message.bdy) return;
  const chats = Array.isArray(message.bdy) ? message.bdy : [message.bdy];
  for (const chat of chats) {
    try {
      await saveChat(chat);
    } catch (error) {
      log(`failed to save chat: ${error.message}`);
    }
  }
}

function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function closeSocket() {
  clearHeartbeat();
  const socket = ws;
  ws = null;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    try {
      socket.close();
    } catch {}
  }
}

function scheduleReconnect(delayMs = 5000) {
  if (stopped || reconnectTimer || !currentChatChannelId) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectChat().catch(error => {
      log(`reconnect failed: ${error.message}`);
      scheduleReconnect(10000);
    });
  }, delayMs);
}

async function stopCollection(reason) {
  closeSocket();
  clearReconnect();
  currentChatChannelId = '';
  reconnectAttemptsAfterOffline = 0;
  offlineSince = null;
  await finishSession(reason);
  log(`collector stopped: ${reason}`);
}

async function connectChat() {
  if (connecting || stopped || !currentChatChannelId) return;
  connecting = true;
  clearReconnect();

  try {
    const tokenData = await fetchAccessToken(currentChatChannelId);
    const accessToken = tokenData?.content?.accessToken || '';

    closeSocket();
    ws = new WebSocket('wss://kr-ss1.chat.naver.com/chat');

    ws.on('open', async () => {
      connecting = false;
      lastRecordAt = Date.now();
      await createSession({
        liveTitle: currentLiveTitle,
        chatChannelId: currentChatChannelId
      });
      ws.send(JSON.stringify({
        ver: '2',
        cmd: 100,
        svcid: 'game',
        cid: currentChatChannelId,
        bdy: {
          uid: null,
          devType: 2001,
          accTkn: accessToken,
          auth: 'READ'
        },
        tid: 1
      }));
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ ver: '2', cmd: 10000 }));
        }
      }, HEARTBEAT_MS);
      log(`chat connected: ${currentChatChannelId}`);
    });

    ws.on('message', data => {
      handleMessage(data).catch(error => log(`message handler failed: ${error.message}`));
    });

    ws.on('close', () => {
      clearHeartbeat();
      connecting = false;
      if (!stopped && currentChatChannelId) scheduleReconnect();
    });

    ws.on('error', error => {
      connecting = false;
      log(`websocket error: ${error.message}`);
    });
  } catch (error) {
    connecting = false;
    throw error;
  }
}

async function checkLive() {
  if (stopped) return;

  try {
    const data = await fetchLiveStatus();
    const content = data?.content || {};
    const isLive = isLiveStatus(content.status);
    const wasLive = lastLiveState;

    if (isLive) {
      currentLiveTitle = content.liveTitle || currentLiveTitle || '';
      currentChatChannelId = content.chatChannelId || currentChatChannelId || CHANNEL_ID;
      offlineSince = null;
      reconnectAttemptsAfterOffline = 0;

      if (!wasLive) log(`live started: ${currentLiveTitle || '(no title)'}`);
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
        await connectChat();
      }
    } else if (wasLive) {
      offlineSince = Date.now();
      lastRecordAt = Date.now();
      log('live ended, waiting for quiet chat reconnects');
    }

    lastLiveState = isLive;
  } catch (error) {
    log(`live check failed: ${error.message}`);
  }
}

async function checkOfflineIdle() {
  if (stopped || lastLiveState || !offlineSince || !currentChatChannelId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastRecordAt < OFFLINE_IDLE_MS) return;

  reconnectAttemptsAfterOffline += 1;
  log(`offline quiet reconnect attempt ${reconnectAttemptsAfterOffline}/${OFFLINE_RECONNECT_LIMIT}`);

  if (reconnectAttemptsAfterOffline > OFFLINE_RECONNECT_LIMIT) {
    await stopCollection('offline quiet reconnect limit reached');
    return;
  }

  closeSocket();
  scheduleReconnect(1000);
}

async function start() {
  log(`collector booting against ${SITE_URL}`);
  await checkLive();
  pollTimer = setInterval(() => {
    checkLive().catch(error => log(`poll failed: ${error.message}`));
  }, POLL_INTERVAL_MS);
  setInterval(() => {
    checkOfflineIdle().catch(error => log(`offline idle check failed: ${error.message}`));
  }, 30000);
}

async function shutdown(signal) {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  await stopCollection(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(error => {
  log(`fatal: ${error.stack || error.message}`);
  process.exit(1);
});
