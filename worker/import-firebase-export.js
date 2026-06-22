import { readFileSync } from 'node:fs';
import { openChatStore } from './chat-store.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node worker/import-firebase-export.js <firebase-chat-export.json>');
  process.exit(1);
}

const exportData = JSON.parse(readFileSync(file, 'utf8'));
const store = openChatStore();
let sessionCount = 0;
let skippedSessionCount = 0;
let chatCount = 0;
let donationCount = 0;

store.db.exec('BEGIN');
try {
  for (const session of exportData.sessions || []) {
    if (store.getSession(session.id)) {
      skippedSessionCount += 1;
      continue;
    }

    store.createSession({
      id: session.id,
      ...(session.data || {}),
      collector: session.data?.collector || 'firebase-import'
    });
    if (session.data?.endedAt) store.finishSession(session.id, 'firebase-import');

    for (const chat of session.chats || []) {
      store.addChat(session.id, chat);
      chatCount += 1;
    }

    for (const donation of session.donations || []) {
      store.addDonation(session.id, donation);
      donationCount += 1;
    }

    sessionCount += 1;
  }

  store.db.exec('COMMIT');
} catch (error) {
  store.db.exec('ROLLBACK');
  throw error;
}

console.log(`Imported ${sessionCount} sessions, ${chatCount} chats, ${donationCount} donations. Skipped ${skippedSessionCount} existing sessions.`);
