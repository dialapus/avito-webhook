#!/usr/bin/env node
// =============================================================================
// Avito Webhook Server — Railway deployment
// Receives Avito messenger webhooks, caches chats, provides API for OpenClaw agent
// =============================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ===================== CONFIG =====================

const PORT = parseInt(process.env.PORT) || 4040;
const AVITO_CLIENT_ID = process.env.AVITO_CLIENT_ID;
const AVITO_CLIENT_SECRET = process.env.AVITO_CLIENT_SECRET;
const AVITO_USER_ID = process.env.AVITO_USER_ID || '204620380';
const AVITO_API_BASE = process.env.AVITO_API_BASE || 'https://api.avito.ru';
const WEBHOOK_API_KEY = process.env.WEBHOOK_API_KEY || '';
const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');

// Ensure directories
const CHATS_DIR = path.join(CACHE_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });

const WEBHOOK_LOG = path.join(CACHE_DIR, 'webhook.log');
const SYNC_STATUS_FILE = path.join(CACHE_DIR, 'sync-status.json');
const WEBHOOK_SEEN_FILE = path.join(CACHE_DIR, 'webhook-seen.json');
const INDEX_FILE = path.join(CACHE_DIR, 'index.json');

// ===================== LOGGING =====================

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(WEBHOOK_LOG, line + '\n'); } catch {}
}

// ===================== AVITO TOKEN MANAGEMENT =====================

let tokenCache = { token: null, expiresAt: 0 };

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 30000,
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 3600000) {
    return tokenCache.token;
  }

  log('🔑 Refreshing Avito token...');
  const body = `grant_type=client_credentials&client_id=${AVITO_CLIENT_ID}&client_secret=${AVITO_CLIENT_SECRET}`;

  const res = await httpsRequest(`${AVITO_API_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, body);

  if (res.status !== 200) {
    log(`❌ Token refresh failed: ${res.status} ${res.body.slice(0, 200)}`);
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = JSON.parse(res.body);
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in * 1000);
  log('✅ Token refreshed');
  return tokenCache.token;
}

async function avitoApi(method, apiPath) {
  try {
    const token = await getToken();
    const url = `${AVITO_API_BASE}${apiPath}`;
    const res = await httpsRequest(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 401) {
      // Token expired, force refresh
      tokenCache.token = null;
      const newToken = await getToken();
      const retry = await httpsRequest(url, {
        method,
        headers: {
          'Authorization': `Bearer ${newToken}`,
          'Content-Type': 'application/json',
        },
      });
      return JSON.parse(retry.body);
    }

    return JSON.parse(res.body);
  } catch (err) {
    log(`❌ API error (${method} ${apiPath}): ${err.message}`);
    return null;
  }
}

// ===================== CHAT CACHE =====================

function safeName(chatId) {
  return chatId.replace(/\//g, '%2F');
  // ~ is preserved — valid in filenames
}

function saveChatMessages(chatId, messages) {
  if (!messages || !messages.length) return;

  const safe = safeName(chatId);

  // JSON
  const jsonFile = path.join(CHATS_DIR, `${safe}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ chat_id: chatId, messages, cached_at: new Date().toISOString() }));

  // TXT (human-readable)
  const msgs = [...messages].sort((a, b) => (a.created || 0) - (b.created || 0));
  const lines = [
    `Chat: ${chatId}`,
    `Link: https://www.avito.ru/profile/messenger/channel/${chatId}`,
    `Messages: ${msgs.length}`,
    '-'.repeat(60),
  ];

  for (const m of msgs) {
    const dir = String(m.author_id) === AVITO_USER_ID ? '→ МЫ' : '← Клиент';
    const dt = new Date((m.created || 0) * 1000);
    const dateStr = `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const text = (m.content && m.content.text) || `[${m.type || 'unknown'}]`;
    lines.push(`[${dateStr}] ${dir}: ${text.slice(0, 300)}`);
  }

  const txtFile = path.join(CHATS_DIR, `chat_${safe}.txt`);
  fs.writeFileSync(txtFile, lines.join('\n') + '\n');
}

async function updateChatCache(chatId) {
  try {
    const data = await avitoApi('GET', `/messenger/v3/accounts/${AVITO_USER_ID}/chats/${chatId}/messages/?limit=50&offset=0`);
    if (!data || !data.messages) {
      log(`❌ No messages for ${chatId}`);
      return false;
    }
    saveChatMessages(chatId, data.messages);
    log(`✅ Cache updated: ${chatId} (${data.messages.length} msgs)`);
    return true;
  } catch (err) {
    log(`❌ Error updating ${chatId}: ${err.message}`);
    return false;
  }
}

// ===================== INDEX =====================

let chatIndex = {};

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      chatIndex = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    }
  } catch { chatIndex = {}; }
}

function saveIndex() {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(chatIndex, null, 2));
  } catch {}
}

// ===================== WEBHOOK TRACKING =====================

let webhookSeen = {};

function loadWebhookSeen() {
  try {
    if (fs.existsSync(WEBHOOK_SEEN_FILE)) {
      webhookSeen = JSON.parse(fs.readFileSync(WEBHOOK_SEEN_FILE, 'utf8'));
    }
  } catch { webhookSeen = {}; }
}

function saveWebhookSeen() {
  try { fs.writeFileSync(WEBHOOK_SEEN_FILE, JSON.stringify(webhookSeen, null, 2)); } catch {}
}

// ===================== PERIODIC SYNC =====================

let syncState = {
  lastSync: null, lastDuration: 0,
  chatsChecked: 0, chatsUpdated: 0, chatsMissed: 0,
  isRunning: false, errors: 0,
};

async function periodicSync() {
  if (syncState.isRunning) return;
  syncState.isRunning = true;
  const startTime = Date.now();
  let checked = 0, updated = 0, errors = 0;

  log('🔄 Starting periodic sync...');

  try {
    const allChats = [];
    for (let offset = 0; offset <= 1000; offset += 100) {
      const data = await avitoApi('GET', `/messenger/v2/accounts/${AVITO_USER_ID}/chats?chat_types=u2i&limit=100&offset=${offset}`);
      if (!data || !data.chats || data.chats.length === 0) break;
      allChats.push(...data.chats);
      if (data.chats.length < 100) break;
      await sleep(300);
    }

    log(`📊 Fetched ${allChats.length} chats from Avito`);

    // Update index
    const newIndex = {};
    for (const chat of allChats) {
      const lastMsg = chat.last_message || {};
      newIndex[chat.id] = {
        updated: lastMsg.created || 0,
        lastMsgId: lastMsg.id || '',
        lastDir: lastMsg.author_id == AVITO_USER_ID ? 'out' : 'in',
        lastText: (lastMsg.content && lastMsg.content.text || '').slice(0, 100),
        users: (chat.users || []).filter(u => u.id != AVITO_USER_ID).map(u => u.name).filter(Boolean),
        item: chat.context && chat.context.value ? chat.context.value.title : '',
        price: chat.context && chat.context.value ? chat.context.value.price_string : '',
        itemUrl: chat.context && chat.context.value ? chat.context.value.url : '',
      };
    }

    // Determine which chats need update
    for (const chat of allChats) {
      checked++;
      const id = chat.id;
      const lastMsgId = (chat.last_message || {}).id || '';
      const prev = chatIndex[id];

      if (!prev || prev.lastMsgId !== lastMsgId) {
        const ok = await updateChatCache(id);
        if (ok) updated++;
        else errors++;
        await sleep(200);
      }
    }

    chatIndex = newIndex;
    saveIndex();

  } catch (err) {
    log(`❌ Sync error: ${err.message}`);
    errors++;
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  syncState = {
    lastSync: new Date().toISOString(),
    lastDuration: parseFloat(duration),
    chatsChecked: checked, chatsUpdated: updated,
    chatsMissed: 0, isRunning: false, errors,
  };

  try { fs.writeFileSync(SYNC_STATUS_FILE, JSON.stringify(syncState, null, 2)); } catch {}
  saveWebhookSeen();

  if (updated > 0) {
    log(`🔄 Sync done: ${checked} checked, ${updated} updated (${duration}s)`);
  } else {
    log(`🔄 Sync: all up to date (${checked} chats, ${duration}s)`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===================== AUTH MIDDLEWARE =====================

function checkAuth(req) {
  if (!WEBHOOK_API_KEY) return true; // No key configured = open
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${WEBHOOK_API_KEY}`;
}

// ===================== HTTP SERVER =====================

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- Health (public) ---
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      chatsInIndex: Object.keys(chatIndex).length,
      chatsInCache: (() => {
        try { return fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json')).length; } catch { return 0; }
      })(),
      sync: {
        lastSync: syncState.lastSync,
        lastDuration: syncState.lastDuration,
        chatsChecked: syncState.chatsChecked,
        chatsUpdated: syncState.chatsUpdated,
        isRunning: syncState.isRunning,
        errors: syncState.errors,
      },
    });
  }

  // --- Webhook (from Avito, no auth) ---
  if (req.method === 'POST' && (pathname === '/webhook' || pathname === '/')) {
    const body = await parseBody(req);
    sendJson(res, 200, { ok: true });

    try {
      const payload = JSON.parse(body);
      log(`📨 Webhook: ${body.slice(0, 300)}`);

      const value = (payload.payload && payload.payload.value) || {};
      const chatId = value.chat_id;
      const msgId = value.id || '';

      if (chatId) {
        log(`💬 New message in chat: ${chatId}`);
        webhookSeen[chatId] = { lastMsgId: msgId, at: Date.now() };
        updateChatCache(chatId); // async, don't await
      }
    } catch (err) {
      log(`❌ Webhook parse error: ${err.message}`);
    }
    return;
  }

  // --- Force sync (authed) ---
  if (req.method === 'POST' && pathname === '/sync') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    sendJson(res, 200, { triggered: true });
    setImmediate(() => periodicSync());
    return;
  }

  // ===================== API ENDPOINTS (authed) =====================

  // --- List chats from index ---
  if (req.method === 'GET' && pathname === '/api/chats') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;

    const entries = Object.entries(chatIndex)
      .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0))
      .slice(offset, offset + limit)
      .map(([id, info]) => ({
        chat_id: id,
        link: `https://www.avito.ru/profile/messenger/channel/${id}`,
        ...info,
        lastDate: info.updated ? new Date(info.updated * 1000).toISOString() : null,
      }));

    return sendJson(res, 200, { total: Object.keys(chatIndex).length, offset, limit, chats: entries });
  }

  // --- Unread chats (last message from client) ---
  if (req.method === 'GET' && pathname === '/api/unread') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    const days = parseInt(url.searchParams.get('days')) || 3;
    const cutoff = Date.now() / 1000 - days * 86400;

    const unread = Object.entries(chatIndex)
      .filter(([, info]) => info.lastDir === 'in' && info.updated > cutoff)
      .sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0))
      .map(([id, info]) => ({
        chat_id: id,
        link: `https://www.avito.ru/profile/messenger/channel/${id}`,
        ...info,
        lastDate: info.updated ? new Date(info.updated * 1000).toISOString() : null,
      }));

    return sendJson(res, 200, { count: unread.length, days, chats: unread });
  }

  // --- Chat messages from cache ---
  if (req.method === 'GET' && pathname.startsWith('/api/chats/') && pathname.endsWith('/messages')) {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    // Extract chat ID: /api/chats/{chatId}/messages
    const chatId = decodeURIComponent(pathname.slice('/api/chats/'.length, -'/messages'.length));
    const safe = safeName(chatId);
    const jsonFile = path.join(CHATS_DIR, `${safe}.json`);

    if (!fs.existsSync(jsonFile)) {
      return sendJson(res, 404, { error: 'Chat not in cache', chat_id: chatId });
    }

    try {
      const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      return sendJson(res, 200, data);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // --- Serve files from cache ---
  if (req.method === 'GET' && pathname.startsWith('/reports/')) {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const filename = decodeURIComponent(pathname.slice('/reports/'.length));
    if (filename.includes('..')) return sendJson(res, 403, { error: 'Forbidden' });
    const filePath = path.join(CACHE_DIR, filename);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      res.writeHead(200, { 'Content-Type': (mimeTypes[ext] || 'application/octet-stream') + '; charset=utf-8' });
      return fs.createReadStream(filePath).pipe(res);
    }
    return sendJson(res, 404, { error: 'File not found' });
  }

  sendJson(res, 404, { error: 'Not found' });
});

// ===================== STARTUP =====================

server.listen(PORT, async () => {
  log(`🚀 Avito Webhook Server started on port ${PORT}`);
  log(`📡 Waiting for Avito webhooks...`);
  log(`🔑 API auth: ${WEBHOOK_API_KEY ? 'enabled' : 'DISABLED (no WEBHOOK_API_KEY)'}`);

  loadIndex();
  loadWebhookSeen();

  // Startup sync after 3s
  setTimeout(() => periodicSync(), 3000);

  // Periodic sync
  setInterval(() => periodicSync(), SYNC_INTERVAL_MS);
});

// Graceful shutdown
function shutdown(signal) {
  log(`🛑 ${signal} received, saving state...`);
  saveIndex();
  saveWebhookSeen();
  try { fs.writeFileSync(SYNC_STATUS_FILE, JSON.stringify(syncState, null, 2)); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
