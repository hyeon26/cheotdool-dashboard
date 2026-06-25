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
    upsertDonationStmt.run(
      id,
      sessionId,
      stringValue(data.time),
      stringValue(data.nick || '익명의 후원자'),
      stringValue(data.type),
      numberOrNull(data.amt),
      stringValue(data.message || data.msg),
      JSON.stringify({ ...data, id }),
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
    deleteSession
  };
}

function stringValue(value) {
  return value == null ? '' : String(value);
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
