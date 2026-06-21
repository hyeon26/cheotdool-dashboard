# Chat collector worker

This worker is for an always-on VM. It watches the CHZZK live status, opens the chat websocket when the stream starts, and stores chats in the existing Firestore structure:

- `chatSessions/{sessionId}`
- `chatSessions/{sessionId}/chats`

## Environment variables

All variables are optional unless your deployment needs a custom value.

```bash
PUBLIC_SITE_URL=https://firstandsecond.vercel.app
CHZZK_CHANNEL_ID=48070f8882233efa7aee52519fee8fca
POLL_INTERVAL_MS=3000
OFFLINE_IDLE_MS=60000
OFFLINE_RECONNECT_LIMIT=5
OFFLINE_STATUS_CONFIRMATIONS=5
CHAT_CHUNK_SIZE=50
CHAT_FLUSH_MS=10000
```

## Run

```bash
npm install
npm run collector
```

For 24/7 operation, run it with `pm2` or `systemd` on the VM.
