import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'chat.db');
const dbPath = process.env.CHAT_DB_PATH || DEFAULT_DB_PATH;

if (!existsSync(dbPath)) {
  console.error(`[migrate-kst] database not found: ${dbPath}`);
  process.exit(1);
}

const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(dbPath, backupPath);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

const tables = [
  { name: 'sessions', key: 'id', dateColumns: ['startedAt', 'endedAt'], timeColumn: '' },
  { name: 'chats', key: 'id', dateColumns: ['createdAt'], timeColumn: 'time' },
  { name: 'donations', key: 'id', dateColumns: ['createdAt'], timeColumn: 'time' }
];

let changed = 0;

db.exec('BEGIN');
try {
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
    for (const row of rows) {
      const patch = {};
      for (const column of table.dateColumns) {
        const converted = convertUtcToKst(row[column]);
        if (converted && converted !== row[column]) patch[column] = converted;
      }

      if (table.timeColumn && patch.createdAt) {
        patch[table.timeColumn] = patch.createdAt.slice(11, 19);
      }

      if (!Object.keys(patch).length) continue;

      const assignments = Object.keys(patch).map(column => `${column} = ?`).join(', ');
      const values = [...Object.keys(patch).map(column => patch[column]), row[table.key]];
      db.prepare(`UPDATE ${table.name} SET ${assignments} WHERE ${table.key} = ?`).run(...values);
      changed += 1;
    }
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`[migrate-kst] failed: ${error.message}`);
  console.error(`[migrate-kst] backup remains at: ${backupPath}`);
  process.exit(1);
}

console.log(`[migrate-kst] updated ${changed} rows`);
console.log(`[migrate-kst] backup: ${backupPath}`);

function convertUtcToKst(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.endsWith('+09:00')) return '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return kstISOString(date);
}

function kstISOString(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
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