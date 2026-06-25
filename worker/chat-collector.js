import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { openChatStore } from './chat-store.js';

const store = openChatStore();

const SITE_URL = trimTrailingSlash(process.env.PUBLIC_SITE_URL || 'https://firstandsecond.vercel.app');
const CHANNEL_ID = process.env.CHZZK_CHANNEL_ID || '48070f8882233efa7aee52519fee8fca';
const POLL_INTERVAL_MS = numberEnv('POLL_INTERVAL_MS', 3000);
const OFFLINE_IDLE_MS = numberEnv('OFFLINE_IDLE_MS', 60000);
const OFFLINE_RECONNECT_LIMIT = numberEnv('OFFLINE_RECONNECT_LIMIT', 3);
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

const ANON_DONOR = 'Anonymous donor';
const recentDonationEventMap = new Map();
const missionRecords = new Map();
const DONATION_DEDUPE_MS = 2500;
const DONATION_DEDUPE_TTL_MS = 60000;
const CHAT_TIME_ZONE = 'Asia/Seoul';

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
    timeZone: CHAT_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatKstDateTime(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: CHAT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function toDonationAmount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') return Number(value.replace(/[^0-9.-]/g, '')) || 0;
  return Number(value) || 0;
}

function getAmountFromKeys(source, keys) {
  for (const key of keys) {
    const amount = toDonationAmount(source?.[key]);
    if (amount > 0) return amount;
  }
  return 0;
}

function getDonationAmount(extras, donation) {
  return getAmountFromKeys(extras, ['payAmount', 'totalPayAmount', 'amt'])
    || getAmountFromKeys(donation, ['payAmount', 'totalPayAmount', 'amt']);
}

function getMissionSettlementAmount(extras, donation) {
  return getAmountFromKeys(extras, ['settlementPayAmount', 'missionSettlementAmount', 'realPayAmount', 'rewardPayAmount', 'missionFailPayAmount'])
    || getAmountFromKeys(donation, ['settlementPayAmount', 'missionSettlementAmount', 'realPayAmount', 'rewardPayAmount', 'missionFailPayAmount']);
}

function firstTextValue(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function getPayloadType(extras, donation) {
  return String(extras?.type || donation?.type || extras?.eventType || donation?.eventType || '').toUpperCase();
}

function getBaseMissionId(extras, donation) {
  return firstTextValue(extras?.relatedMissionDonationId, donation?.relatedMissionDonationId, extras?.missionDonationId, extras?.missionId, extras?.missionDonationNo, extras?.missionNo, extras?.missionTargetId, donation?.missionDonationId, donation?.missionId, donation?.missionDonationNo, donation?.missionNo, donation?.missionTargetId);
}

function getMissionEventId(extras, donation) {
  const type = getPayloadType(extras, donation);
  const dtype = String(extras?.donationType || donation?.donationType || '').toUpperCase();
  const participationMissionId = (dtype === 'MISSION_PARTICIPATION' || type === 'DONATION_MISSION_PARTICIPATION') ? firstTextValue(extras?.missionDonationId, donation?.missionDonationId) : '';
  return firstTextValue(participationMissionId, extras?.donationId, extras?.payId, extras?.historyId, extras?.missionParticipationId, extras?.participationId, extras?.missionHistoryId, extras?.donationUniqueId, donation?.donationId, donation?.payId, donation?.historyId, donation?.missionParticipationId, donation?.participationId, donation?.missionHistoryId, donation?.donationUniqueId);
}

function getMissionStatusInfo(extras, donation = {}) {
  const status = String(extras?.status ?? donation?.status ?? extras?.missionStatus ?? donation?.missionStatus ?? '').toUpperCase();
  const successValue = extras?.success ?? donation?.success ?? extras?.missionSuccess ?? donation?.missionSuccess ?? extras?.isSuccess ?? donation?.isSuccess;
  const successStatuses = ['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE'];
  const failStatuses = ['FAIL', 'FAILED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'];
  const pendingStatuses = ['PENDING', 'WAITING', 'OPEN', 'IN_PROGRESS', 'ONGOING', 'APPROVED', 'ACCEPTED', 'STARTED', 'RUNNING'];
  const explicitSuccess = successValue === true || successValue === 'true' || successValue === 'Y' || successValue === 1 || successValue === '1';
  const explicitFail = successValue === false || successValue === 'false' || successValue === 'N' || successValue === 0 || successValue === '0';
  const statusIsSuccess = successStatuses.includes(status);
  const statusIsFailed = failStatuses.includes(status);
  const statusIsPending = pendingStatuses.includes(status);
  const success = (explicitSuccess || statusIsSuccess) && !explicitFail && !statusIsPending;
  const failed = (explicitFail && !statusIsPending) || statusIsFailed;
  const pending = statusIsPending || (!success && !failed);
  const proposal = ['PENDING', 'WAITING', 'OPEN'].includes(status) || (!status && !success && !failed);
  const label = proposal ? 'proposal' : pending ? 'pending' : success ? 'success' : failed ? 'failed' : 'unknown';
  return { status, success, failed, pending, proposal, label };
}

function isMissionProgressEvent(extras, donation) {
  const type = getPayloadType(extras, donation);
  return type === 'DONATION_MISSION_IN_PROGRESS' || type === 'MISSION_IN_PROGRESS' || type === 'MISSION_STATUS';
}

function isMissionAdditionType(dtype, extras, donation) {
  const type = getPayloadType(extras, donation);
  return String(dtype || '').toUpperCase() === 'MISSION_PARTICIPATION' || type === 'DONATION_MISSION_PARTICIPATION' || !!extras?.missionParticipationId || !!extras?.participationId;
}

function getFailedMissionAmount(targetAmount) {
  const target = toDonationAmount(targetAmount);
  if (target <= 0) return 0;
  return Math.max(1000, Math.floor(target * 0.1));
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function hashPayload(value) {
  return createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value || {})).digest('hex');
}

function rememberMissionRecord(missionKey, { nick, amount, msg, eventId, isAddition, extras, donation }) {
  if (!missionKey) return null;
  const normalizedAmount = toDonationAmount(amount);
  const prev = missionRecords.get(missionKey) || { additions: {}, eventIds: {}, rawAmt: 0, nick: nick || ANON_DONOR, msg: '' };
  const next = { ...prev, additions: { ...(prev.additions || {}) }, eventIds: { ...(prev.eventIds || {}) }, nick: isAddition ? (prev.nick || nick || ANON_DONOR) : (nick || prev.nick || ANON_DONOR), msg: msg || prev.msg || '', extras: extras || prev.extras, donation: donation || prev.donation, updatedAt: Date.now() };
  [missionKey, eventId, getBaseMissionId(extras || {}, donation || {})].filter(Boolean).forEach(id => { next.eventIds[id] = true; });
  if (normalizedAmount > 0) {
    if (isAddition) {
      const additionKey = eventId || hashPayload({ missionKey, nick, amount: normalizedAmount, msg });
      if (!next.additions[additionKey]) {
        next.additions[additionKey] = { key: additionKey, nick: nick || ANON_DONOR, amount: normalizedAmount };
        next.rawAmt = toDonationAmount(next.rawAmt) + normalizedAmount;
      }
    } else {
      next.baseAmount = Math.max(toDonationAmount(next.baseAmount), normalizedAmount);
      next.baseNick = nick || next.baseNick || next.nick || ANON_DONOR;
      next.rawAmt = Math.max(toDonationAmount(next.rawAmt), normalizedAmount);
    }
  }
  missionRecords.set(missionKey, next);
  return next;
}

function resolveMissionRecord(missionKey, eventId, nick, msg) {
  if (missionKey && missionRecords.has(missionKey)) return { key: missionKey, record: missionRecords.get(missionKey) };
  if (eventId && missionRecords.has(eventId)) return { key: eventId, record: missionRecords.get(eventId) };
  for (const [key, record] of missionRecords.entries()) {
    if ((missionKey && record.eventIds?.[missionKey]) || (eventId && record.eventIds?.[eventId])) return { key, record };
  }
  const targetNick = String(nick || '').trim();
  const targetMsg = String(msg || '').trim();
  for (const [key, record] of missionRecords.entries()) {
    if (targetMsg && record.msg === targetMsg && (!targetNick || record.nick === targetNick || record.baseNick === targetNick)) return { key, record };
  }
  return { key: missionKey || eventId || '', record: null };
}

function getMissionEntries(record, fallbackNick, fallbackAmount, missionStatus) {
  const additions = Object.entries(record?.additions || {}).map(([key, value]) => {
    const rawAmount = toDonationAmount(value?.amount);
    return { key, nick: value?.nick || ANON_DONOR, rawAmount, amount: missionStatus?.failed ? getFailedMissionAmount(rawAmount) : rawAmount };
  }).filter(item => item.amount > 0);
  const additionsTotal = additions.reduce((sum, item) => sum + item.rawAmount, 0);
  const baseAmount = toDonationAmount(record?.baseAmount) || Math.max(0, toDonationAmount(record?.rawAmt) - additionsTotal) || toDonationAmount(fallbackAmount);
  const base = baseAmount > 0 ? [{ key: 'base', nick: record?.baseNick || record?.nick || fallbackNick || ANON_DONOR, rawAmount: baseAmount, amount: missionStatus?.failed ? getFailedMissionAmount(baseAmount) : baseAmount }] : [];
  const entries = [...base, ...additions].filter(item => item.amount > 0);
  if (entries.length) return entries;
  const amount = toDonationAmount(fallbackAmount);
  return amount > 0 ? [{ key: 'single', nick: fallbackNick || ANON_DONOR, rawAmount: amount, amount }] : [];
}

function collectDonationCandidates(payload, bucket = []) {
  payload = parseMaybeJson(payload);
  if (!payload) return bucket;
  if (Array.isArray(payload)) {
    payload.forEach(item => collectDonationCandidates(item, bucket));
    return bucket;
  }
  if (typeof payload !== 'object') return bucket;
  const candidate = parseMaybeJson(payload.donation || payload);
  if (candidate && typeof candidate === 'object') {
    const extrasObj = parseMaybeJson(candidate.extras);
    const dtype = String(extrasObj?.donationType || candidate.donationType || '').toUpperCase();
    const eventType = getPayloadType(extrasObj || candidate, candidate);
    const hasMissionShape = !!(getBaseMissionId(extrasObj || {}, candidate) || dtype === 'MISSION' || dtype === 'MISSION_PARTICIPATION' || eventType === 'DONATION_MISSION_IN_PROGRESS' || eventType === 'DONATION_MISSION_PARTICIPATION' || extrasObj?.status || candidate.status || candidate.success != null);
    const hasAmountShape = candidate.payAmount != null || candidate.totalPayAmount != null || candidate.amt != null || extrasObj?.payAmount != null || extrasObj?.totalPayAmount != null;
    const hasExtrasObject = typeof candidate.extras === 'object' && candidate.extras !== null;
    const hasExtrasString = typeof candidate.extras === 'string' && candidate.extras.trim().startsWith('{');
    if ((hasExtrasObject || hasExtrasString) && (hasMissionShape || hasAmountShape)) bucket.push(candidate);
  }
  Object.values(payload).forEach(value => {
    if (value && (typeof value === 'object' || typeof value === 'string')) collectDonationCandidates(value, bucket);
  });
  return bucket;
}

function collectMissionStatusCandidates(payload, bucket = []) {
  payload = parseMaybeJson(payload);
  if (!payload) return bucket;
  if (Array.isArray(payload)) {
    payload.forEach(item => collectMissionStatusCandidates(item, bucket));
    return bucket;
  }
  if (typeof payload !== 'object') return bucket;
  const candidate = parseMaybeJson(payload.mission || payload.event || payload);
  if (candidate && typeof candidate === 'object') {
    const eventType = getPayloadType(candidate, candidate);
    const hasMissionId = !!(getBaseMissionId(candidate, candidate) || getMissionEventId(candidate, candidate));
    const hasMissionStatus = candidate.status != null || candidate.success != null || candidate.missionStatus != null || candidate.missionSuccess != null || candidate.isSuccess != null;
    const isMissionEvent = eventType === 'DONATION_MISSION_IN_PROGRESS' || eventType === 'DONATION_MISSION_PARTICIPATION' || eventType === 'MISSION_IN_PROGRESS' || eventType === 'MISSION_STATUS';
    if ((hasMissionId && hasMissionStatus) || isMissionEvent) bucket.push(candidate);
  }
  Object.values(payload).forEach(value => {
    if (value && (typeof value === 'object' || typeof value === 'string')) collectMissionStatusCandidates(value, bucket);
  });
  return bucket;
}

function isRecentDonationDuplicate(key) {
  const now = Date.now();
  for (const [storedKey, time] of recentDonationEventMap.entries()) {
    if (now - time > DONATION_DEDUPE_TTL_MS) recentDonationEventMap.delete(storedKey);
  }
  const previous = recentDonationEventMap.get(key) || 0;
  if (now - previous < DONATION_DEDUPE_MS) return true;
  recentDonationEventMap.set(key, now);
  return false;
}

function getCandidateNick(donation, extras) {
  const profile = parseMaybeJson(donation?.profile) || {};
  return firstTextValue(profile.nickname, donation?.nickname, extras?.nickname, extras?.userNickname, ANON_DONOR);
}

function saveDonationRow(data) {
  if (!sessionId) return;
  lastRecordAt = Date.now();
  reconnectAttemptsAfterOffline = 0;
  store.addDonation(sessionId, { time: data.time || formatChatTime(), nick: data.nick || ANON_DONOR, type: data.type || 'donation', amt: toDonationAmount(data.amt), message: data.message || '', documentId: data.documentId, createdAt: formatKstDateTime(), ...data });
  log(`${data.type === 'mission' ? 'mission' : 'donation'} saved: ${data.nick || ANON_DONOR}: ${toDonationAmount(data.amt).toLocaleString()}원`);
}

function handleDonationCandidate(donation) {
  const extras = parseMaybeJson(donation?.extras) || {};
  const dtype = String(extras?.donationType || donation?.donationType || '').toUpperCase();
  const eventType = getPayloadType(extras, donation);
  const nick = getCandidateNick(donation, extras);
  const msg = firstTextValue(donation?.msg, donation?.message, extras?.missionText, extras?.donationText, extras?.message);
  const baseMissionId = getBaseMissionId(extras, donation);
  const missionEventId = getMissionEventId(extras, donation);
  const isMissionAddition = isMissionAdditionType(dtype, extras, donation);
  const isMission = dtype === 'MISSION' || dtype === 'MISSION_PARTICIPATION' || isMissionProgressEvent(extras, donation) || !!baseMissionId || !!donation?.missionDonationId || !!donation?.missionId;
  const incomingAmount = getDonationAmount(extras, donation);
  const settlementAmount = isMission ? getMissionSettlementAmount(extras, donation) : 0;
  const missionStatus = isMission ? getMissionStatusInfo(extras, donation) : null;
  const payloadHash = hashPayload({ donation, extras });
  const eventId = missionEventId || firstTextValue(extras?.donationId, donation?.donationId, donation?.payId, payloadHash);

  if (!isMission) {
    if (!incomingAmount) return;
    const dedupeKey = `donation:${eventId}:${incomingAmount}:${nick}`;
    if (isRecentDonationDuplicate(dedupeKey)) return;
    saveDonationRow({ documentId: `donation_${safeId(eventId || payloadHash)}`, time: formatChatTime(), nick, type: 'donation', amt: incomingAmount, message: msg, donationType: dtype, extras });
    return;
  }

  const missionKey = baseMissionId || missionEventId || hashPayload({ nick, msg, dtype, eventType });
  const resolved = resolveMissionRecord(missionKey, missionEventId, nick, msg);
  let record = resolved.record;
  if (incomingAmount > 0) record = rememberMissionRecord(resolved.key || missionKey, { nick, amount: incomingAmount, msg, eventId: missionEventId, isAddition: isMissionAddition, extras, donation }) || record;

  const shouldCountMission = !missionStatus.pending && missionStatus.status !== 'REJECTED';
  if (!shouldCountMission && !settlementAmount) return;

  const amountForSettlement = settlementAmount || incomingAmount || toDonationAmount(record?.rawAmt);
  if (!amountForSettlement && !record) return;
  const finalStatus = settlementAmount && missionStatus.pending ? { ...missionStatus, pending: false, proposal: false, success: true, failed: false, label: 'success' } : missionStatus;
  const entries = getMissionEntries(record, nick, amountForSettlement, finalStatus);
  if (!entries.length) return;

  entries.forEach(entry => {
    const documentId = `mission_${safeId(resolved.key || missionKey)}_${safeId(entry.key || missionEventId || payloadHash)}`;
    const dedupeKey = `${documentId}:${entry.amount}:${finalStatus.status}:${finalStatus.success}`;
    if (isRecentDonationDuplicate(dedupeKey)) return;
    saveDonationRow({ documentId, time: formatChatTime(), nick: entry.nick || nick || ANON_DONOR, type: 'mission', amt: entry.amount, rawAmt: entry.rawAmount || entry.amount, message: msg || record?.msg || '', missionTitle: record?.msg || msg || '', donationType: dtype, missionDonationId: resolved.key || missionKey, missionEventId, missionContributionKey: entry.key, missionStatus: finalStatus.status, missionSuccess: finalStatus.success, missionFailed: finalStatus.failed, missionStatusLabel: finalStatus.label, extras });
  });
}

async function processDonationEvents(message) {
  const eventPayload = message?.bdy ?? message?.body ?? message;
  const donationCandidates = collectDonationCandidates(eventPayload);
  const missionStatusCandidates = donationCandidates.length ? [] : collectMissionStatusCandidates(eventPayload);
  const seen = new Set();
  for (const donation of donationCandidates) {
    const extras = parseMaybeJson(donation?.extras) || {};
    const key = `${getBaseMissionId(extras, donation)}_${getMissionEventId(extras, donation)}_${extras?.status || ''}_${extras?.success}_${getDonationAmount(extras, donation)}_${getCandidateNick(donation, extras)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    handleDonationCandidate(donation);
  }
  for (const mission of missionStatusCandidates) {
    const key = `${getBaseMissionId(mission, mission)}_${getMissionEventId(mission, mission)}_${mission?.status || ''}_${mission?.success}_${getDonationAmount(mission, mission)}_${mission?.nickname || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    handleDonationCandidate({ profile: { nickname: mission?.nickname || '' }, extras: mission, msg: mission?.missionText || mission?.message || '' });
  }
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
    createdAt: formatKstDateTime()
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

  try {
    await processDonationEvents(message);
  } catch (error) {
    log(`failed to process donation event: ${error.message}`);
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
