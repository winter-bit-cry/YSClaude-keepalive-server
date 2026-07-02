import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8789);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.KEEPALIVE_AUTH_TOKEN || '';
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 55 * 60 * 1000);
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const state = {
  conversations: {},
};
const timers = new Map();

function now() {
  return Date.now();
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function normalizeToken(value) {
  return String(value || '').replace(/^Bearer\s+/i, '').trim();
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return true;
  return normalizeToken(req.headers.authorization) === AUTH_TOKEN;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.conversations) {
      state.conversations = parsed.conversations;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[state] load failed:', error.message);
    }
  }
}

async function saveState() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function snapshotHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function minutesOfDay(timestamp) {
  const date = new Date(timestamp);
  return date.getHours() * 60 + date.getMinutes();
}

function isInQuietHours(timestamp, quietHours) {
  if (!quietHours?.enabled) return false;
  const start = Number(quietHours.startMinutes);
  const end = Number(quietHours.endMinutes);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const current = minutesOfDay(timestamp);
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

function clearConversationTimer(conversationId) {
  const timer = timers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(conversationId);
  }
}

function scheduleConversation(conversationId) {
  clearConversationTimer(conversationId);
  const item = state.conversations[conversationId];
  if (!item || item.status !== 'active' || !item.nextKeepaliveAt) return;

  const delay = Math.max(1000, item.nextKeepaliveAt - now());
  const timer = setTimeout(() => {
    runKeepalive(conversationId).catch((error) => {
      console.warn(`[keepalive] ${conversationId} failed:`, error.message);
    });
  }, delay);
  timers.set(conversationId, timer);
}

function applyThinkingConfig(body, request) {
  if (!request.generateThinking) return;
  body.reasoning = { effort: request.thinkingEffort || 'high' };
  if (request.thinkingCompatibility === 'nanogpt') {
    body.reasoning_effort = request.thinkingEffort || 'high';
  }
}

function applyPromptCacheCompatibility(body, request) {
  if (!request.promptCache?.enabled) return;
  if (request.promptCache.compatibility === 'nanogpt') {
    body.promptCaching = {
      enabled: true,
      ttl: request.promptCache.ttl,
      explicitCacheControl: true,
    };
  }
}

function buildHeaders(request) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(request.apiKey || '').trim()}`,
  };
  if (
    request.promptCache?.enabled &&
    request.promptCache.ttl === '1h' &&
    request.promptCache.compatibility === 'nanogpt'
  ) {
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11';
  }
  return headers;
}

function shouldRetryWithOneToken(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('max_tokens') || text.includes('max tokens') || text.includes('greater than 0');
}

async function callKeepaliveApi(request, maxTokens) {
  const url = `${String(request.baseUrl || '').trim().replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: request.model,
    messages: request.messages,
    stream: false,
    max_tokens: maxTokens,
  };
  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (request.sessionId) {
    body.session_id = request.sessionId;
  }
  applyThinkingConfig(body, request);
  applyPromptCacheCompatibility(body, request);

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(request),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API ${response.status}: ${text}`);
  }
  return response.json().catch(() => ({}));
}

async function runKeepalive(conversationId) {
  const item = state.conversations[conversationId];
  if (!item || item.status !== 'active') return;

  const plannedAt = item.nextKeepaliveAt || now();
  if (isInQuietHours(plannedAt, item.quietHours)) {
    item.status = 'disabled';
    item.disabledReason = 'quiet-hours';
    item.nextKeepaliveAt = null;
    item.updatedAt = now();
    await saveState();
    clearConversationTimer(conversationId);
    console.log(`[keepalive] ${conversationId} skipped in quiet hours`);
    return;
  }

  try {
    try {
      await callKeepaliveApi(item.request, 0);
    } catch (error) {
      if (!shouldRetryWithOneToken(error)) throw error;
      await callKeepaliveApi(item.request, 1);
    }

    item.lastTouchedAt = now();
    item.nextKeepaliveAt = item.lastTouchedAt + KEEPALIVE_INTERVAL_MS;
    item.lastError = null;
    item.updatedAt = item.lastTouchedAt;
    await saveState();
    scheduleConversation(conversationId);
    console.log(`[keepalive] ${conversationId} ok, next ${new Date(item.nextKeepaliveAt).toISOString()}`);
  } catch (error) {
    item.lastError = error.message || String(error);
    item.lastFailedAt = now();
    item.nextKeepaliveAt = Math.min(now() + 5 * 60 * 1000, plannedAt + 10 * 60 * 1000);
    item.updatedAt = now();
    await saveState();
    scheduleConversation(conversationId);
    console.warn(`[keepalive] ${conversationId} error: ${item.lastError}`);
  }
}

function validateSnapshot(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing JSON body');
  if (typeof input.conversationId !== 'string' || !input.conversationId.trim()) {
    throw new Error('conversationId is required');
  }
  const request = input.request;
  if (!request || typeof request !== 'object') throw new Error('request is required');
  for (const key of ['baseUrl', 'apiKey', 'model', 'sessionId']) {
    if (typeof request[key] !== 'string' || !request[key].trim()) {
      throw new Error(`request.${key} is required`);
    }
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new Error('request.messages must be a non-empty array');
  }
  if (!request.promptCache?.enabled || request.promptCache.ttl !== '1h') {
    throw new Error('request.promptCache must be enabled with ttl=1h');
  }
  return {
    conversationId: input.conversationId.trim(),
    request,
    quietHours: input.quietHours || { enabled: false },
  };
}

async function handleSnapshot(req, res) {
  const input = validateSnapshot(await readJsonBody(req));
  const touchedAt = now();
  const nextKeepaliveAt = touchedAt + KEEPALIVE_INTERVAL_MS;
  const hash = snapshotHash(input.request);

  if (isInQuietHours(nextKeepaliveAt, input.quietHours)) {
    clearConversationTimer(input.conversationId);
    state.conversations[input.conversationId] = {
      conversationId: input.conversationId,
      snapshotHash: hash,
      request: input.request,
      quietHours: input.quietHours,
      status: 'disabled',
      disabledReason: 'quiet-hours',
      lastTouchedAt: touchedAt,
      nextKeepaliveAt: null,
      updatedAt: touchedAt,
    };
    await saveState();
    jsonResponse(res, 200, { ok: true, status: 'disabled', reason: 'quiet-hours' });
    return;
  }

  state.conversations[input.conversationId] = {
    conversationId: input.conversationId,
    snapshotHash: hash,
    request: input.request,
    quietHours: input.quietHours,
    status: 'active',
    disabledReason: null,
    lastTouchedAt: touchedAt,
    nextKeepaliveAt,
    updatedAt: touchedAt,
    lastError: null,
  };
  await saveState();
  scheduleConversation(input.conversationId);
  jsonResponse(res, 200, {
    ok: true,
    status: 'active',
    snapshotHash: hash,
    nextKeepaliveAt,
  });
}

async function handleDisable(req, res) {
  const input = await readJsonBody(req);
  const conversationId = String(input.conversationId || '').trim();
  if (!conversationId) {
    jsonResponse(res, 400, { ok: false, error: 'conversationId is required' });
    return;
  }
  clearConversationTimer(conversationId);
  const existing = state.conversations[conversationId] || { conversationId };
  state.conversations[conversationId] = {
    ...existing,
    status: 'disabled',
    disabledReason: 'client-disable',
    nextKeepaliveAt: null,
    updatedAt: now(),
  };
  await saveState();
  jsonResponse(res, 200, { ok: true, status: 'disabled' });
}

function publicStatus() {
  return Object.values(state.conversations).map((item) => ({
    conversationId: item.conversationId,
    snapshotHash: item.snapshotHash,
    status: item.status,
    disabledReason: item.disabledReason,
    lastTouchedAt: item.lastTouchedAt,
    nextKeepaliveAt: item.nextKeepaliveAt,
    lastError: item.lastError,
    updatedAt: item.updatedAt,
  }));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, {
        ok: true,
        service: 'ysclaude-keepalive-server',
        id: randomUUID(),
        time: new Date().toISOString(),
      });
      return;
    }

    if (!isAuthorized(req)) {
      jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/keepalive/status') {
      jsonResponse(res, 200, { ok: true, conversations: publicStatus() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/snapshot') {
      await handleSnapshot(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/disable') {
      await handleDisable(req, res);
      return;
    }
    jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message || String(error) });
  }
}

await loadState();
for (const item of Object.values(state.conversations)) {
  if (item.status === 'active') {
    scheduleConversation(item.conversationId);
  }
}

createServer(route).listen(PORT, HOST, () => {
  console.log(`YSClaude keepalive server listening on http://${HOST}:${PORT}`);
  if (!AUTH_TOKEN) {
    console.warn('KEEPALIVE_AUTH_TOKEN is empty. Set it before exposing this server.');
  }
});
