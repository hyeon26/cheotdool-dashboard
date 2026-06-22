# Chat collector worker

This worker is for an always-on VM. It watches the CHZZK live status, opens the chat websocket when the stream starts, and stores chats in SQLite on the VM.

- Default DB: `data/chat.db`
- Local API: `npm run chat-api`
- Collector: `npm run collector`

## Environment variables

All variables are optional unless your deployment needs a custom value.

```bash
PUBLIC_SITE_URL=https://firstandsecond.vercel.app
CHZZK_CHANNEL_ID=48070f8882233efa7aee52519fee8fca
CHAT_DB_PATH=/home/ubuntu/cheotdool-dashboard/data/chat.db
CHAT_API_PORT=8787
CHAT_API_TOKEN=change-this-secret
POLL_INTERVAL_MS=3000
OFFLINE_IDLE_MS=60000
OFFLINE_RECONNECT_LIMIT=5
```

## Run

```bash
npm install
npm run collector
npm run chat-api
node worker/import-firebase-export.js firebase-chat-export.json
```

For 24/7 operation, run `collector` and `chat-api` with `pm2` or `systemd` on the VM. Set Vercel `CHAT_STORE_ORIGIN` to the VM API origin, for example `http://138.2.42.142:8787`.
