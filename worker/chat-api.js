import http from 'node:http';
import { URL } from 'node:url';
import { openChatStore } from './chat-store.js';

const PORT = Number(process.env.CHAT_API_PORT || process.env.PORT || 8787);
const TOKEN = process.env.CHAT_API_TOKEN || '';
const store = openChatStore();

const server = http.createServer(async (req, res) => {
  try {
    setCors(res);
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (TOKEN && req.headers['x-chat-api-token'] !== TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      return sendJson(res, 200, { sessions: store.listSessions(url.searchParams.get('limit') || 50) });
    }

    if (req.method === 'POST' && url.pathname === '/sessions') {
      const body = await readJson(req);
      return sendJson(res, 201, { session: store.createSession(body) });
    }

    if (parts[0] === 'sessions' && parts[1]) {
      const sessionId = decodeURIComponent(parts[1]);

      if (req.method === 'GET' && parts.length === 2) {
        const detail = store.getSessionDetail(sessionId);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not found' });
      }

      if (req.method === 'DELETE' && parts.length === 2) {
        return sendJson(res, 200, { deleted: store.deleteSession(sessionId) });
      }

      if (req.method === 'PATCH' && parts[2] === 'finish') {
        const body = await readJson(req);
        return sendJson(res, 200, { session: store.finishSession(sessionId, body.reason || 'stopped') });
      }

      if (req.method === 'POST' && parts[2] === 'chats') {
        store.addChat(sessionId, await readJson(req));
        return sendJson(res, 201, { ok: true });
      }

      if (req.method === 'POST' && parts[2] === 'donations') {
        store.addDonation(sessionId, await readJson(req));
        return sendJson(res, 201, { ok: true });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[chat-api] listening on ${PORT}`);
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Chat-Api-Token');
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(status === 204 ? '' : JSON.stringify(data));
}
