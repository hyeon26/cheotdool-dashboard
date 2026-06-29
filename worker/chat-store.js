import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

export function openChatStore(dbPath = process.env.CHAT_DB_PATH || DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      startedAt TEXT NOT NULL,
      endedAt TEXT,
      liveTitle TEXT DEFAULT '',
      chatChannelId TEXT DEFAULT '',
      collector TEXT DEFAULT '',
      endReason TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      time TEXT DEFAULT '',
      nick TEXT DEFAULT '',
      msg TEXT DEFAULT '',
      chatType TEXT DEFAULT '',
      missionLabel TEXT DEFAULT '',
      amount REAL,
      missionTitle TEXT DEFAULT '',
      dataJson TEXT DEFAULT '{}',
      createdAt TEXT NOT NULL,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chats_session_created ON chats(sessionId, createdAt);
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      time TEXT DEFAULT '',
      nick TEXT DEFAULT '',
      type TEXT DEFAULT '',
      amt REAL,
      message TEXT DEFAULT '',
      dataJson TEXT DEFAULT '{}',
      createdAt TEXT NOT NULL,
      FOREIGN KEY(sessionId) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_donations_session_created ON donations(sessionId, createdAt);
    CREATE TABLE IF NOT EXISTS followers (
      userId TEXT PRIMARY KEY,
      nickname TEXT DEFAULT '',
      profileImageUrl TEXT DEFAULT '',
      followDate TEXT DEFAULT '',
      notification INTEGER DEFAULT 0,
      following INTEGER DEFAULT 1,
      firstSeenAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL,
      unfollowedAt TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_followers_following_seen ON followers(following, lastSeenAt);
    CREATE TABLE IF NOT EXISTS follower_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      profileImageUrl TEXT DEFAULT '',
      type TEXT NOT NULL,
      followDate TEXT DEFAULT '',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_follower_events_created ON follower_events(createdAt DESC, id DESC);
  `);

  const createSessionStmt = db.prepare(`
    INSERT INTO sessions (id, startedAt, liveTitle, chatChannelId, collector)
    VALUES (?, ?, ?, ?, ?)
  `);
  const finishSessionStmt = db.prepare(`
    UPDATE sessions SET endedAt = ?, endReason = ? WHERE id = ?
  `);
  const insertChatStmt = db.prepare(`
    INSERT INTO chats (sessionId, time, nick, msg, chatType, missionLabel, amount, missionTitle, dataJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertDonationStmt = db.prepare(`
    INSERT INTO donations (id, sessionId, time, nick, type, amt, message, dataJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      time = excluded.time,
      nick = excluded.nick,
      type = excluded.type,
      amt = excluded.amt,
      message = excluded.message,
      dataJson = excluded.dataJson,
      createdAt = excluded.createdAt
  `);
  const listSessionsStmt = db.prepare(`
    SELECT
      s.*,
      (SELECT COUNT(*) FROM chats c WHERE c.sessionId = s.id) AS chatCount,
      (SELECT COUNT(*) FROM donations d WHERE d.sessionId = s.id) AS donationCount
    FROM sessions s
    ORDER BY s.startedAt DESC
    LIMIT ?
  `);
  const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const listChatsStmt = db.prepare('SELECT * FROM chats WHERE sessionId = ? ORDER BY createdAt ASC, id ASC');
  const listDonationsStmt = db.prepare('SELECT * FROM donations WHERE sessionId = ? ORDER BY createdAt ASC, id ASC');
  const monthlyDonationStatsStmt = db.prepare(`
    SELECT
      substr(createdAt, 1, 7) AS month,
      COALESCE(SUM(amt), 0) AS total,
      COALESCE(SUM(CASE WHEN type = 'mission' THEN amt ELSE 0 END), 0) AS mission,
      COALESCE(SUM(CASE WHEN type = 'mission' THEN 0 ELSE amt END), 0) AS donation,
      COUNT(*) AS count
    FROM donations
    WHERE createdAt >= ? AND createdAt < ? AND COALESCE(amt, 0) > 0
    GROUP BY month
    ORDER BY month DESC
  `);
  const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const listAllFollowersStmt = db.prepare('SELECT * FROM followers');
  const upsertFollowerStmt = db.prepare(`
    INSERT INTO followers (userId, nickname, profileImageUrl, followDate, notification, following, firstSeenAt, lastSeenAt, unfollowedAt)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, '')
    ON CONFLICT(userId) DO UPDATE SET
      nickname = excluded.nickname,
      profileImageUrl = excluded.profileImageUrl,
      followDate = excluded.followDate,
      notification = excluded.notification,
      following = 1,
      lastSeenAt = excluded.lastSeenAt,
      unfollowedAt = ''
  `);
  const markFollowerUnfollowedStmt = db.prepare(`
    UPDATE followers
    SET following = 0, lastSeenAt = ?, unfollowedAt = ?
    WHERE userId = ?
  `);
  const insertFollowerEventStmt = db.prepare(`
    INSERT INTO follower_events (userId, nickname, profileImageUrl, type, followDate, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listFollowerEventsStmt = db.prepare(`
    SELECT * FROM follower_events
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `);

  function createSession(data = {}) {
    const id = data.id || randomUUID();
    const startedAt = normalizeDate(data.startedAt) || kstISOString();
    createSessionStmt.run(
      id,
      startedAt,
      stringValue(data.liveTitle),
      stringValue(data.chatChannelId),
      stringValue(data.collector)
    );
    return getSession(id);
  }

  function finishSession(id, reason = 'stopped') {
    finishSessionStmt.run(kstISOString(), stringValue(reason), id);
    return getSession(id);
  }

  function addChat(sessionId, data = {}) {
    const createdAt = normalizeDate(data.createdAt) || kstISOString();
    insertChatStmt.run(
      sessionId,
      stringValue(data.time),
      stringValue(data.nick || '익명'),
      stringValue(data.msg),
      stringValue(data.chatType),
      stringValue(data.missionLabel),
      numberOrNull(data.amount),
      stringValue(data.missionTitle),
      JSON.stringify(data),
      createdAt
    );
  }

  function addDonation(sessionId, data = {}) {
    const id = data.id || data.documentId || randomUUID();
    const createdAt = normalizeDate(data.createdAt) || kstISOString();
    const nick = normalizeDonorNick(data.nick);
    upsertDonationStmt.run(
      id,
      sessionId,
      stringValue(data.time),
      stringValue(nick),
      stringValue(data.type),
      numberOrNull(data.amt),
      stringValue(data.message || data.msg),
      JSON.stringify({ ...data, id, nick }),
      createdAt
    );
  }

  function listSessions(limit = 50) {
    return listSessionsStmt.all(Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  function getSession(id) {
    return getSessionStmt.get(id);
  }

  function getSessionDetail(id) {
    const session = getSession(id);
    if (!session) return null;
    return {
      session,
      chats: listChatsStmt.all(id).map(row => ({ ...parseJson(row.dataJson), ...row })),
      donations: listDonationsStmt.all(id).map(row => ({ ...parseJson(row.dataJson), ...row }))
    };
  }

  function deleteSession(id) {
    const result = deleteSessionStmt.run(id);
    return result.changes || 0;
  }

  function getMonthlyDonationStats(year = new Date().getFullYear()) {
    const y = String(year || new Date().getFullYear()).replace(/[^0-9]/g, '').slice(0, 4);
    const targetYear = y || String(new Date().getFullYear());
    return monthlyDonationStatsStmt.all(`${targetYear}-01-01`, `${Number(targetYear) + 1}-01-01`);
  }

  function syncFollowers(items = []) {
    const now = kstISOString();
    const incoming = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const follower = normalizeFollowerItem(item);
      if (follower.userId) incoming.set(follower.userId, follower);
    }

    const existingRows = listAllFollowersStmt.all();
    if (incoming.size === 0 && existingRows.length > 0) {
      return {
        total: 0,
        added: 0,
        removed: 0,
        changes: 0,
        skipped: true,
        events: listFollowerEvents(100)
      };
    }
    const existing = new Map(existingRows.map(row => [row.userId, row]));
    const isInitialSync = existingRows.length === 0;
    const events = [];
    let added = 0;
    let removed = 0;

    for (const follower of incoming.values()) {
      const previous = existing.get(follower.userId);
      const notification = follower.notification ? 1 : 0;
      if (!isInitialSync && (!previous || Number(previous.following) === 0)) {
        insertFollowerEventStmt.run(
          follower.userId,
          follower.nickname,
          follower.profileImageUrl,
          'follow',
          follower.followDate,
          now
        );
        events.push({ ...follower, type: 'follow', createdAt: now });
        added += 1;
      }
      upsertFollowerStmt.run(
        follower.userId,
        follower.nickname,
        follower.profileImageUrl,
        follower.followDate,
        notification,
        now,
        now
      );
    }

    if (!isInitialSync) {
      for (const row of existingRows) {
        if (Number(row.following) !== 1 || incoming.has(row.userId)) continue;
        markFollowerUnfollowedStmt.run(now, now, row.userId);
        insertFollowerEventStmt.run(
          row.userId,
          stringValue(row.nickname),
          stringValue(row.profileImageUrl),
          'unfollow',
          stringValue(row.followDate),
          now
        );
        events.push({
          userId: row.userId,
          nickname: row.nickname,
          profileImageUrl: row.profileImageUrl,
          followDate: row.followDate,
          type: 'unfollow',
          createdAt: now
        });
        removed += 1;
      }
    }

    return {
      total: incoming.size,
      added,
      removed,
      changes: added + removed,
      events: listFollowerEvents(100)
    };
  }

  function listFollowerEvents(limit = 100) {
    const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
    return listFollowerEventsStmt.all(safeLimit);
  }

  return {
    db,
    createSession,
    finishSession,
    addChat,
    addDonation,
    listSessions,
    getSession,
    getSessionDetail,
    getMonthlyDonationStats,
    syncFollowers,
    listFollowerEvents,
    deleteSession
  };
}

function stringValue(value) {
  return value == null ? '' : String(value);
}

function normalizeFollowerItem(item = {}) {
  const user = item.user || item;
  const following = item.following || item;
  return {
    userId: stringValue(user.userIdHash || user.userId || item.userIdHash || item.userId),
    nickname: stringValue(user.nickname || item.nickname),
    profileImageUrl: stringValue(user.profileImageUrl || item.profileImageUrl),
    followDate: stringValue(following.followDate || item.followDate),
    notification: Boolean(following.notification ?? item.notification)
  };
}

function normalizeDonorNick(nick) {
  const text = String(nick || '').trim();
  if (!text || /^anonymous donor$/i.test(text) || /^anonymous$/i.test(text)) return '익명의 후원자';
  return text;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function kstISOString(date = new Date()) {
  const parts = Object.fromEntries(KST_DATE_FORMATTER.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
}

function normalizeDate(value) {
  if (!value) return '';
  if (value instanceof Date) return kstISOString(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.seconds) return kstISOString(new Date(value.seconds * 1000));
  return '';
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}
