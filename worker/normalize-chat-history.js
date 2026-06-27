import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openChatStore } from './chat-store.js';

const dbPath = process.env.CHAT_DB_PATH || path.join(process.cwd(), 'data', 'chat.db');

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(dbPath, backupPath);

const store = openChatStore(dbPath);
const { db } = store;

const donationRows = db.prepare('SELECT id, nick, type, dataJson FROM donations').all();
const chatRows = db.prepare('SELECT id, nick, dataJson FROM chats').all();

const updateDonationStmt = db.prepare('UPDATE donations SET nick = ?, dataJson = ? WHERE id = ?');
const deleteDonationStmt = db.prepare('DELETE FROM donations WHERE id = ?');
const updateChatStmt = db.prepare('UPDATE chats SET nick = ?, dataJson = ? WHERE id = ?');

let updatedDonations = 0;
let deletedMissionRows = 0;
let updatedChats = 0;

for (const row of donationRows) {
  const data = parseJson(row.dataJson);
  const type = String(row.type || data.type || '').toLowerCase();
  const normalized = normalizeDonationData(data, row.nick);

  if (type === 'mission' && !isFinalMission(normalized)) {
    deleteDonationStmt.run(row.id);
    deletedMissionRows += 1;
    continue;
  }

  const nextJson = JSON.stringify(normalized);
  if (normalized.nick !== row.nick || nextJson !== row.dataJson) {
    updateDonationStmt.run(normalized.nick, nextJson, row.id);
    updatedDonations += 1;
  }
}

for (const row of chatRows) {
  const data = parseJson(row.dataJson);
  const nextNick = normalizeDonorNick(row.nick || data.nick);
  if (data.nick != null) data.nick = normalizeDonorNick(data.nick);
  const nextJson = JSON.stringify(data);
  if (nextNick !== row.nick || nextJson !== row.dataJson) {
    updateChatStmt.run(nextNick, nextJson, row.id);
    updatedChats += 1;
  }
}

db.close?.();

console.log(`Backup created: ${backupPath}`);
console.log(`Updated donation rows: ${updatedDonations}`);
console.log(`Deleted non-final mission rows: ${deletedMissionRows}`);
console.log(`Updated chat rows: ${updatedChats}`);

function normalizeDonationData(data, fallbackNick) {
  const next = { ...data };
  next.nick = normalizeDonorNick(next.nick || fallbackNick);

  const normalizedLabel = normalizeMissionStatusLabel(next.missionStatusLabel);
  if (normalizedLabel) next.missionStatusLabel = normalizedLabel;

  if (next.missionSuccess === 'true') next.missionSuccess = true;
  if (next.missionSuccess === 'false') next.missionSuccess = false;
  if (next.missionFailed === 'true') next.missionFailed = true;
  if (next.missionFailed === 'false') next.missionFailed = false;

  return next;
}

function normalizeDonorNick(nick) {
  const text = String(nick || '').trim();
  if (!text || /^anonymous donor$/i.test(text) || /^anonymous$/i.test(text)) return '익명의 후원자';
  return text;
}

function normalizeMissionStatusLabel(label) {
  const text = String(label || '').trim().replace(/^미션\s+/, '');
  if (!text) return '';
  const key = text.toUpperCase().replace(/[\s-]+/g, '_');
  if (['성공', 'SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE'].includes(key)) return '성공';
  if (['실패', 'FAIL', 'FAILED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(key)) return '실패';
  if (['제시', 'PROPOSAL', 'PENDING', 'WAITING', 'OPEN'].includes(key)) return '제시';
  if (['진행', 'IN_PROGRESS', 'ONGOING', 'APPROVED', 'ACCEPTED', 'STARTED', 'RUNNING'].includes(key)) return '진행';
  return text;
}

function isFinalMission(data) {
  const label = normalizeMissionStatusLabel(data.missionStatusLabel);
  if (label === '성공' || label === '실패') return true;
  if (data.missionSuccess === true || data.missionSuccess === 'true') return true;
  if (data.missionFailed === true || data.missionFailed === 'true') return true;

  const status = String(data.missionStatus || data.status || '').toUpperCase();
  if (['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'DONE'].includes(status)) return true;
  if (['FAIL', 'FAILED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(status)) return true;

  return false;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}
