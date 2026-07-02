import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'chat.db');
const KST_TIME_ZONE = 'Asia/Seoul';
const KST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: KST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

export function openSubscriberStore(dbPath = process.env.SUBSCRIBER_DB_PATH || process.env.CHAT_DB_PATH || DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      userId TEXT PRIMARY KEY,
      nickname TEXT DEFAULT '',
      profileImageUrl TEXT DEFAULT '',
      subscribeDate TEXT DEFAULT '',
      recentSubscribeDate TEXT DEFAULT '',
      duration TEXT DEFAULT '',
      tier TEXT DEFAULT '',
      subscribing INTEGER DEFAULT 1,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      unsubscribedAt TEXT DEFAULT '',
      rawJson TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_subscribers_subscribing_seen ON subscribers(subscribing, lastSeenAt);
    CREATE TABLE IF NOT EXISTS subscriber_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      profileImageUrl TEXT DEFAULT '',
      type TEXT NOT NULL,
      subscribeDate TEXT DEFAULT '',
      recentSubscribeDate TEXT DEFAULT '',
      tier TEXT DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subscriber_events_created ON subscriber_events(createdAt DESC, id DESC);
  `);
  addColumnIfMissing(db, 'subscribers', 'recentSubscribeDate TEXT DEFAULT \'\'');
  addColumnIfMissing(db, 'subscribers', 'duration TEXT DEFAULT \'\'');
  addColumnIfMissing(db, 'subscriber_events', 'recentSubscribeDate TEXT DEFAULT \'\'');

  const listAllSubscribersStmt = db.prepare('SELECT * FROM subscribers');
  const upsertSubscriberStmt = db.prepare(`
    INSERT INTO subscribers (userId, nickname, profileImageUrl, subscribeDate, recentSubscribeDate, duration, tier, subscribing, firstSeenAt, lastSeenAt, unsubscribedAt, rawJson)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '', ?)
    ON CONFLICT(userId) DO UPDATE SET
      nickname = excluded.nickname,
      profileImageUrl = excluded.profileImageUrl,
      subscribeDate = excluded.subscribeDate,
      recentSubscribeDate = excluded.recentSubscribeDate,
      duration = excluded.duration,
      tier = excluded.tier,
      subscribing = 1,
      lastSeenAt = excluded.lastSeenAt,
      unsubscribedAt = '',
      rawJson = excluded.rawJson
  `);
  const markSubscriberUnsubscribedStmt = db.prepare(`
    UPDATE subscribers
    SET subscribing = 0, lastSeenAt = ?, unsubscribedAt = ?
    WHERE userId = ?
  `);
  const insertSubscriberEventStmt = db.prepare(`
    INSERT INTO subscriber_events (userId, nickname, profileImageUrl, type, subscribeDate, recentSubscribeDate, tier, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listSubscriberEventsStmt = db.prepare(`
    SELECT * FROM subscriber_events
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `);
  const subscriberDailyStatsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'subscribe' THEN 1 ELSE 0 END), 0) AS added,
      COALESCE(SUM(CASE WHEN type = 'unsubscribe' THEN 1 ELSE 0 END), 0) AS removed,
      COUNT(*) AS changes
    FROM subscriber_events
    WHERE createdAt >= ?
  `);
  const subscriberStatsStmt = db.prepare(`
    SELECT
      COUNT(*) AS knownTotal,
      COALESCE(SUM(CASE WHEN subscribing = 1 THEN 1 ELSE 0 END), 0) AS subscribingTotal,
      COALESCE(SUM(CASE WHEN subscribing = 0 THEN 1 ELSE 0 END), 0) AS unsubscribedTotal
    FROM subscribers
  `);
  const listCurrentSubscribersStmt = db.prepare(`
    SELECT * FROM subscribers
    WHERE subscribing = 1
    ORDER BY subscribeDate DESC, lastSeenAt DESC, nickname ASC
  `);

  function syncSubscribers(items = []) {
    const now = kstISOString();
    const incoming = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const subscriber = normalizeSubscriberItem(item);
      if (subscriber.userId) incoming.set(subscriber.userId, subscriber);
    }

    const existingRows = listAllSubscribersStmt.all();
    if (incoming.size === 0 && existingRows.length > 0) {
      return {
        total: 0,
        added: 0,
        removed: 0,
        changes: 0,
        skipped: true,
        events: listSubscriberEvents(100),
        dailyStats: getSubscriberDailyStats()
      };
    }

    const existing = new Map(existingRows.map(row => [row.userId, row]));
    const isInitialSync = existingRows.length === 0;
    let added = 0;
    let removed = 0;

    for (const subscriber of incoming.values()) {
      const previous = existing.get(subscriber.userId);
      if (!isInitialSync && (!previous || Number(previous.subscribing) === 0)) {
        insertSubscriberEventStmt.run(subscriber.userId, subscriber.nickname, subscriber.profileImageUrl, 'subscribe', subscriber.subscribeDate, subscriber.recentSubscribeDate, subscriber.tier, now);
        added += 1;
      }
      upsertSubscriberStmt.run(subscriber.userId, subscriber.nickname, subscriber.profileImageUrl, subscriber.subscribeDate, subscriber.recentSubscribeDate, subscriber.duration, subscriber.tier, now, now, subscriber.rawJson);
    }

    if (!isInitialSync) {
      for (const row of existingRows) {
        if (Number(row.subscribing) !== 1 || incoming.has(row.userId)) continue;
        markSubscriberUnsubscribedStmt.run(now, now, row.userId);
        insertSubscriberEventStmt.run(row.userId, stringValue(row.nickname), stringValue(row.profileImageUrl), 'unsubscribe', stringValue(row.subscribeDate), stringValue(row.recentSubscribeDate), stringValue(row.tier), now);
        removed += 1;
      }
    }

    return {
      total: incoming.size,
      added,
      removed,
      changes: added + removed,
      events: listSubscriberEvents(100),
      dailyStats: getSubscriberDailyStats()
    };
  }

  function listSubscriberEvents(limit = 100) {
    const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
    return listSubscriberEventsStmt.all(safeLimit);
  }

  function listSubscribers({ page = 0, size = 50, query = '' } = {}) {
    const safePage = Math.max(0, Number(page) || 0);
    const safeSize = Math.max(1, Math.min(100, Number(size) || 50));
    const keyword = normalizeSearchText(query);
    const rows = listCurrentSubscribersStmt.all();
    const filtered = keyword ? rows.filter(row => normalizeSearchText(row.nickname).includes(keyword)) : rows;
    const start = safePage * safeSize;
    return {
      page: safePage,
      size: safeSize,
      totalCount: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / safeSize)),
      data: filtered.slice(start, start + safeSize).map(row => {
        const subscribeDate = row.subscribeDate || extractSubscriberDateFromRaw(row.rawJson);
        const recentSubscribeDate = row.recentSubscribeDate || extractRecentSubscriberDateFromRaw(row.rawJson);
        const duration = row.duration || extractSubscriberDurationFromRaw(row.rawJson);
        return {
          user: { userIdHash: row.userId, nickname: row.nickname, profileImageUrl: row.profileImageUrl },
          userIdHash: row.userId,
          nickname: row.nickname,
          profileImageUrl: row.profileImageUrl,
          subscribeDate,
          recentSubscribeDate,
          duration,
          tier: row.tier
        };
      })
    };
  }

  function getSubscriberStats() {
    return subscriberStatsStmt.get();
  }

  function getSubscriberDailyStats(date = new Date()) {
    const since = kstDateStartISOString(date);
    const row = subscriberDailyStatsStmt.get(since) || {};
    return { since, added: Number(row.added || 0), removed: Number(row.removed || 0), changes: Number(row.changes || 0) };
  }

  return { db, syncSubscribers, listSubscribers, listSubscriberEvents, getSubscriberStats, getSubscriberDailyStats };
}

function normalizeSubscriberItem(item = {}) {
  const user = item.user || item.member || item.channel || item.profile || item;
  const subscription = item.subscription || item.subscriber || item;
  return {
    userId: firstString(user.userIdHash, item.userIdHash, user.userId, item.userId, user.memberNo, item.memberNo, user.channelId, item.channelId, user.id, item.id),
    nickname: firstString(user.nickname, user.nickName, item.nickname, item.nickName, user.channelName, item.channelName),
    profileImageUrl: firstString(user.profileImageUrl, item.profileImageUrl, user.profileImage, item.profileImage, user.imageUrl, item.imageUrl),
    subscribeDate: firstString(
      subscription.subscribeDate,
      item.subscribeDate,
      subscription.subscriptionDate,
      item.subscriptionDate,
      subscription.createdAt,
      item.createdAt,
      subscription.createdDate,
      item.createdDate,
      subscription.startDate,
      item.startDate,
      findSubscriberDate(item)
    ),
    recentSubscribeDate: firstString(
      subscription.recentSubscribeAt,
      item.recentSubscribeAt,
      subscription.recentSubscribedAt,
      item.recentSubscribedAt,
      subscription.latestSubscribeAt,
      item.latestSubscribeAt,
      subscription.lastSubscribeAt,
      item.lastSubscribeAt,
      subscription.lastSubscribedAt,
      item.lastSubscribedAt,
      subscription.recentSubscribeDate,
      item.recentSubscribeDate,
      subscription.recentSubscriptionDate,
      item.recentSubscriptionDate,
      subscription.latestSubscribeDate,
      item.latestSubscribeDate,
      subscription.lastSubscribeDate,
      item.lastSubscribeDate,
      subscription.lastSubscriptionDate,
      item.lastSubscriptionDate,
      subscription.renewalDate,
      item.renewalDate,
      subscription.renewedAt,
      item.renewedAt,
      subscription.lastPaymentDate,
      item.lastPaymentDate,
      findRecentSubscriberDate(item)
    ),
    duration: firstString(
      normalizeDurationValue(subscription.duration),
      normalizeDurationValue(item.duration),
      normalizeDurationValue(subscription.period),
      normalizeDurationValue(item.period),
      normalizeDurationValue(subscription.subscribePeriod),
      normalizeDurationValue(item.subscribePeriod),
      normalizeDurationValue(subscription.subscriptionPeriod),
      normalizeDurationValue(item.subscriptionPeriod),
      normalizeDurationValue(subscription.subscribeMonth),
      normalizeDurationValue(item.subscribeMonth),
      normalizeDurationValue(subscription.subscriptionMonth),
      normalizeDurationValue(item.subscriptionMonth),
      normalizeDurationValue(subscription.month),
      normalizeDurationValue(item.month),
      normalizeDurationValue(subscription.months),
      normalizeDurationValue(item.months),
      normalizeDurationValue(subscription.totalMonth),
      normalizeDurationValue(item.totalMonth),
      normalizeDurationValue(subscription.accumulatedMonth),
      normalizeDurationValue(item.accumulatedMonth),
      normalizeDurationValue(subscription.consecutiveMonth),
      normalizeDurationValue(item.consecutiveMonth),
      extractSubscriberDurationFromRaw(safeJson(item))
    ),
    tier: firstString(subscription.tier, item.tier, subscription.grade, item.grade, subscription.productName, item.productName, subscription.name, item.name),
    rawJson: safeJson(item)
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function safeJson(value) {
  try { return JSON.stringify(value).slice(0, 8000); }
  catch { return ''; }
}

function extractSubscriberDateFromRaw(rawJson) {
  if (!rawJson) return '';
  try { return findSubscriberDate(JSON.parse(rawJson)); }
  catch { return ''; }
}

function extractRecentSubscriberDateFromRaw(rawJson) {
  if (!rawJson) return '';
  try { return findRecentSubscriberDate(JSON.parse(rawJson)); }
  catch { return ''; }
}

function extractSubscriberDurationFromRaw(rawJson) {
  if (!rawJson) return '';
  try { return findSubscriberDuration(JSON.parse(rawJson)); }
  catch { return ''; }
}

function findSubscriberDate(value) {
  const candidates = [];
  visitDateCandidates(value, '', candidates, 0, isLikelySubscriberDateKey);
  return firstString(...candidates);
}

function findRecentSubscriberDate(value) {
  const candidates = [];
  visitDateCandidates(value, '', candidates, 0, isLikelyRecentSubscriberDateKey);
  return firstString(...candidates);
}

function findSubscriberDuration(value) {
  const candidates = [];
  visitDurationCandidates(value, '', candidates, 0);
  return firstString(...candidates);
}

function visitDateCandidates(value, keyPath, candidates, depth, matcher) {
  if (value == null || depth > 8 || candidates.length > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) visitDateCandidates(item, keyPath, candidates, depth + 1, matcher);
    return;
  }
  if (typeof value !== 'object') {
    const normalized = matcher(keyPath) ? normalizeDateValue(value) : '';
    if (normalized) candidates.push(normalized);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = keyPath ? `${keyPath}.${key}` : key;
    const normalized = matcher(nextPath) ? normalizeDateValue(child) : '';
    if (normalized) candidates.push(normalized);
    visitDateCandidates(child, nextPath, candidates, depth + 1, matcher);
  }
}

function isLikelySubscriberDateKey(keyPath) {
  const key = String(keyPath).toLowerCase();
  const domainHint = /subscribe|subscription|membership|member|sponsor|support|created|registered|joined|start/.test(key);
  const dateHint = /date|time|created|registered|joined|start|at$/.test(key);
  return domainHint && dateHint;
}

function isLikelyRecentSubscriberDateKey(keyPath) {
  const key = String(keyPath).toLowerCase();
  const recencyHint = /recent|latest|last|renew|renewal|payment|paid|billing|subscribeat|subscribedat/.test(key);
  const domainHint = /subscribe|subscription|membership|member|sponsor|support|fan|payment|paid|billing/.test(key);
  const dateHint = /date|time|created|registered|joined|start|at$/.test(key);
  return recencyHint && domainHint && dateHint;
}

function addColumnIfMissing(db, table, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (error) {
    if (!/duplicate column name/i.test(String(error.message))) throw error;
  }
}

function visitDurationCandidates(value, keyPath, candidates, depth) {
  if (value == null || depth > 8 || candidates.length > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) visitDurationCandidates(item, keyPath, candidates, depth + 1);
    return;
  }
  if (typeof value !== 'object') {
    if (isLikelySubscriberDurationKey(keyPath)) {
      const normalized = normalizeDurationValue(value);
      if (normalized) candidates.push(normalized);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = keyPath ? `${keyPath}.${key}` : key;
    if (isLikelySubscriberDurationKey(nextPath)) {
      const normalized = normalizeDurationValue(child);
      if (normalized) candidates.push(normalized);
    }
    visitDurationCandidates(child, nextPath, candidates, depth + 1);
  }
}

function isLikelySubscriberDurationKey(keyPath) {
  const key = String(keyPath).toLowerCase();
  const domainHint = /subscribe|subscription|membership|member|sponsor|support|fan/.test(key);
  const durationHint = /duration|period|month|months|term|count|round|cycle/.test(key);
  return domainHint && durationHint;
}

function normalizeDurationValue(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1000 ? `${Math.trunc(value)}\uac1c\uc6d4` : '';
  }
  const text = String(value).trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    return num > 0 && num < 1000 ? `${num}\uac1c\uc6d4` : '';
  }
  return text;
}

function normalizeDateValue(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return kstISOString(new Date(value));
    if (value > 1_000_000_000) return kstISOString(new Date(value * 1000));
    return '';
  }
  const text = String(value).trim();
  if (!text || text.length < 8) return '';
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /\d{4}|\d{13}/.test(text)) return kstISOString(parsed);
  return '';
}

function stringValue(value) {
  return value == null ? '' : String(value);
}

function normalizeSearchText(value) {
  return stringValue(value).trim().toLocaleLowerCase('ko-KR').replace(/\s+/g, '');
}

function kstDateStartISOString(date = new Date()) {
  const parts = Object.fromEntries(KST_DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T00:00:00+09:00`;
}

function kstISOString(date = new Date()) {
  const parts = Object.fromEntries(KST_DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}
