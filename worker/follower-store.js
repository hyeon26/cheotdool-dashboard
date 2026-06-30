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

export function openFollowerStore(dbPath = process.env.FOLLOWER_DB_PATH || process.env.CHAT_DB_PATH || DEFAULT_DB_PATH) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
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
  const followerDailyStatsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'follow' THEN 1 ELSE 0 END), 0) AS added,
      COALESCE(SUM(CASE WHEN type = 'unfollow' THEN 1 ELSE 0 END), 0) AS removed,
      COUNT(*) AS changes
    FROM follower_events
    WHERE createdAt >= ?
  `);
  const followerStatsStmt = db.prepare(`
    SELECT
      COUNT(*) AS knownTotal,
      COALESCE(SUM(CASE WHEN following = 1 THEN 1 ELSE 0 END), 0) AS followingTotal,
      COALESCE(SUM(CASE WHEN following = 0 THEN 1 ELSE 0 END), 0) AS unfollowedTotal
    FROM followers
  `);
  const listCurrentFollowersStmt = db.prepare(`
    SELECT * FROM followers
    WHERE following = 1
    ORDER BY followDate DESC, lastSeenAt DESC, nickname ASC
  `);

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
        events: listFollowerEvents(100),
        dailyStats: getFollowerDailyStats()
      };
    }

    const existing = new Map(existingRows.map(row => [row.userId, row]));
    const isInitialSync = existingRows.length === 0;
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
        removed += 1;
      }
    }

    return {
      total: incoming.size,
      added,
      removed,
      changes: added + removed,
      events: listFollowerEvents(100),
      dailyStats: getFollowerDailyStats()
    };
  }

  function listFollowerEvents(limit = 100) {
    const safeLimit = Math.max(1, Math.min(300, Number(limit) || 100));
    return listFollowerEventsStmt.all(safeLimit);
  }

  function listFollowers({ page = 0, size = 50, query = '' } = {}) {
    const safePage = Math.max(0, Number(page) || 0);
    const safeSize = Math.max(1, Math.min(100, Number(size) || 50));
    const keyword = normalizeSearchText(query);
    const rows = listCurrentFollowersStmt.all();
    const filtered = keyword
      ? rows.filter(row => normalizeSearchText(row.nickname).includes(keyword))
      : rows;
    const start = safePage * safeSize;
    return {
      page: safePage,
      size: safeSize,
      totalCount: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / safeSize)),
      data: filtered.slice(start, start + safeSize).map(row => ({
        user: {
          userIdHash: row.userId,
          nickname: row.nickname,
          profileImageUrl: row.profileImageUrl
        },
        userIdHash: row.userId,
        nickname: row.nickname,
        profileImageUrl: row.profileImageUrl,
        followDate: row.followDate,
        notification: Boolean(row.notification)
      }))
    };
  }

  function getFollowerStats() {
    return followerStatsStmt.get();
  }

  function getFollowerDailyStats(date = new Date()) {
    const since = kstDateStartISOString(date);
    const row = followerDailyStatsStmt.get(since) || {};
    return {
      since,
      added: Number(row.added || 0),
      removed: Number(row.removed || 0),
      changes: Number(row.changes || 0)
    };
  }

  return {
    db,
    syncFollowers,
    listFollowers,
    listFollowerEvents,
    getFollowerStats,
    getFollowerDailyStats
  };
}

function normalizeFollowerItem(item = {}) {
  const user = item.user || item;
  const following = item.following || item;
  return {
    userId: stringValue(user.userIdHash || item.userIdHash || user.userId || item.userId),
    nickname: stringValue(user.nickname || item.nickname),
    profileImageUrl: stringValue(user.profileImageUrl || item.profileImageUrl),
    followDate: stringValue(following.followDate || item.followDate),
    notification: Boolean(following.notification ?? item.notification)
  };
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