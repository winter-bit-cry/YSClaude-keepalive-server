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
const MAX_LOG_ENTRIES = Number(process.env.MAX_LOG_ENTRIES || 300);
const SNAPSHOT_PREVIEW_TAIL_CHARS = 120;
const AGENT_TICK_MAX_TOKENS = Number(process.env.AGENT_TICK_MAX_TOKENS || 800);
const AGENT_ACTIVITY_MAX_TOOL_ROUNDS = Number(process.env.AGENT_ACTIVITY_MAX_TOOL_ROUNDS || 4);
const SERVERCHAN_SENDKEY = process.env.SERVERCHAN_SENDKEY || '';
const WXPUSHER_APP_TOKEN = process.env.WXPUSHER_APP_TOKEN || '';
const WXPUSHER_UIDS = process.env.WXPUSHER_UIDS || '';
const WXPUSHER_TOPIC_IDS = process.env.WXPUSHER_TOPIC_IDS || '';
const YSCLAUDE_APP_DEEPLINK_BASE = process.env.YSCLAUDE_APP_DEEPLINK_BASE || 'ysclaude://chat/';
const PUSH_BODY_MAX_CHARS = 200;

const state = {
  conversations: {},
  logs: [],
};
const timers = new Map();
let quietHoursPurgeTimer = null;

function now() {
  return Date.now();
}

function isFiniteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeFutureTimestamp(value, baseTime = now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    let timestamp = value;
    if (timestamp > 0 && timestamp < 365 * 24 * 60) {
      timestamp = baseTime + timestamp * 60 * 1000;
    } else if (timestamp > 1000000000 && timestamp < 100000000000) {
      timestamp *= 1000;
    }
    return timestamp > baseTime + 30 * 1000 ? timestamp : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return normalizeFutureTimestamp(numeric, baseTime);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > baseTime + 30 * 1000 ? parsed : null;
  }
  return null;
}

function extractDecisionNextAwakeAt(decision, baseTime = now()) {
  if (!decision || typeof decision !== 'object') return null;
  for (const key of ['next_awake_minutes', 'nextAwakeMinutes', 'wakeAfterMinutes', 'next_awake_in_minutes']) {
    const timestamp = normalizeFutureTimestamp(decision[key], baseTime);
    if (timestamp) return timestamp;
  }
  for (const key of ['next_awake', 'nextAwake', 'nextAwakeAt', 'next_awake_at']) {
    const timestamp = normalizeFutureTimestamp(decision[key], baseTime);
    if (timestamp) return timestamp;
  }
  return null;
}

function isAgentTickEnabled(item) {
  return item?.agentTick ? item.agentTick.enabled === true : getAgentToolDefinitions(item?.agentTools).length > 0;
}

function nextAgentWakeAt(item, fallbackFrom = now()) {
  if (isFiniteTimestamp(item?.nextAwakeAt)) return item.nextAwakeAt;
  if (isAgentTickEnabled(item)) return fallbackFrom + KEEPALIVE_INTERVAL_MS;
  return null;
}

function computeNextSchedule(item, fromTime = now()) {
  const nextAwakeAt = nextAgentWakeAt(item, fromTime);
  if (!nextAwakeAt) {
    return {
      nextKeepaliveAt: fromTime + KEEPALIVE_INTERVAL_MS,
      nextAwakeAt: null,
      triggerKind: 'keepalive',
    };
  }
  if (nextAwakeAt - fromTime <= KEEPALIVE_INTERVAL_MS) {
    return {
      nextKeepaliveAt: Math.max(fromTime + 1000, nextAwakeAt),
      nextAwakeAt,
      triggerKind: 'agent-wake',
    };
  }
  return {
    nextKeepaliveAt: fromTime + KEEPALIVE_INTERVAL_MS,
    nextAwakeAt,
    triggerKind: 'keepalive',
  };
}

function shouldRunAgentWake(item, plannedAt) {
  if (!isAgentTickEnabled(item)) return false;
  if (!isFiniteTimestamp(item?.nextAwakeAt)) return true;
  return plannedAt >= item.nextAwakeAt - 1000;
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function htmlResponse(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
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
      state.logs = Array.isArray(parsed.logs) ? parsed.logs.slice(-MAX_LOG_ENTRIES) : [];
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

function addLog(type, details = {}) {
  const entry = {
    id: randomUUID(),
    type,
    createdAt: now(),
    ...details,
  };
  state.logs.push(entry);
  if (state.logs.length > MAX_LOG_ENTRIES) {
    state.logs = state.logs.slice(-MAX_LOG_ENTRIES);
  }
  const conversationPart = entry.conversationId ? ` ${entry.conversationId}` : '';
  const messagePart = entry.message ? ` ${entry.message}` : '';
  console.log(`[${type}]${conversationPart}${messagePart}`);
  return entry;
}

function normalizePreviewText(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= SNAPSHOT_PREVIEW_TAIL_CHARS) return normalized;
  return normalized.slice(-SNAPSHOT_PREVIEW_TAIL_CHARS);
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      if (typeof part.input_text === 'string') return part.input_text;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function buildSnapshotPreview(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const lastTextMessage = [...messages].reverse().find((message) => normalizePreviewText(extractMessageText(message.content)));
  const fallbackMessage = messages[messages.length - 1] || null;
  const lastMessageText = lastTextMessage ? normalizePreviewText(extractMessageText(lastTextMessage.content)) : '';
  return {
    model: request?.model || null,
    messageCount: messages.length,
    lastMessageRole: lastTextMessage?.role || fallbackMessage?.role || null,
    lastMessageTail: lastMessageText || (fallbackMessage?.tool_calls?.length ? '[工具调用]' : null),
  };
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

function nextQuietStartAt(quietHours, reference = now()) {
  if (!quietHours?.enabled) return null;
  const start = Number(quietHours.startMinutes);
  const end = Number(quietHours.endMinutes);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
  if (isInQuietHours(reference, quietHours)) return reference;

  const date = new Date(reference);
  const current = minutesOfDay(reference);
  const daysToAdd = current < start ? 0 : 1;
  date.setDate(date.getDate() + daysToAdd);
  date.setHours(Math.floor(start / 60), start % 60, 0, 0);
  return date.getTime();
}

function clearAllConversationTimers() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

function clearQuietHoursPurgeTimer() {
  if (!quietHoursPurgeTimer) return;
  clearTimeout(quietHoursPurgeTimer);
  quietHoursPurgeTimer = null;
}

async function purgeAllStateForQuietHours(reason = 'quiet-hours') {
  const conversationCount = Object.keys(state.conversations).length;
  const logCount = state.logs.length;
  clearAllConversationTimers();
  clearQuietHoursPurgeTimer();
  state.conversations = {};
  state.logs = [];
  console.log(`[quiet-hours-purge] ${reason}; cleared ${conversationCount} conversations and ${logCount} logs`);
  await saveState();
}

function scheduleQuietHoursPurge() {
  clearQuietHoursPurgeTimer();
  const candidates = Object.values(state.conversations)
    .map((item) => ({
      conversationId: item.conversationId,
      quietHours: item.quietHours,
      purgeAt: nextQuietStartAt(item.quietHours),
    }))
    .filter((item) => Number.isFinite(item.purgeAt));
  if (candidates.length === 0) return;

  candidates.sort((a, b) => a.purgeAt - b.purgeAt);
  const nextPurge = candidates[0];
  const delay = Math.max(1000, nextPurge.purgeAt - now());
  console.log(`[quiet-hours-purge-scheduled] ${new Date(nextPurge.purgeAt).toISOString()}`);
  quietHoursPurgeTimer = setTimeout(() => {
    purgeAllStateForQuietHours('quiet-hours-start').catch((error) => {
      console.warn('[quiet-hours-purge] failed:', error.message);
    });
  }, delay);
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
  addLog('keepalive-scheduled', {
    conversationId,
    nextKeepaliveAt: item.nextKeepaliveAt,
    nextAwakeAt: item.nextAwakeAt || null,
    nextTriggerKind: item.nextTriggerKind || null,
    message: `${item.nextTriggerKind || 'next'} ${new Date(item.nextKeepaliveAt).toISOString()}`,
  });
  const timer = setTimeout(() => {
    runKeepalive(conversationId).catch((error) => {
      console.warn(`[keepalive] ${conversationId} failed:`, error.message);
    });
  }, delay);
  timers.set(conversationId, timer);
  scheduleQuietHoursPurge();
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

// ─── Server酱推送 ────────────────────────────────────────────
// 兼容两代 SendKey：SCT 开头走 sctapi.ftqq.com；sctp{uid}t 开头走 Server酱3 的 push.ft07.com。
function buildServerChanUrl(sendKey) {
  const key = String(sendKey || '').trim();
  if (!key) return null;
  const sc3Match = key.match(/^sctp(\d+)t/i);
  if (sc3Match) {
    return `https://${sc3Match[1]}.push.ft07.com/send/${key}.send`;
  }
  return `https://sctapi.ftqq.com/${key}.send`;
}

function getServerChanSendKey(item) {
  if (getPushProvider(item) === 'wxpusher') return '';
  return String(item?.push?.serverChanSendKey || SERVERCHAN_SENDKEY || '').trim();
}

function splitPushList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTopicIds(value) {
  return splitPushList(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function getPushProvider(item) {
  const provider = String(item?.push?.provider || '').trim().toLowerCase();
  if (provider === 'serverchan' || provider === 'wxpusher' || provider === 'both') return provider;
  return 'both';
}

async function sendServerChanUserMessagePush(item, messageText) {
  const sendKey = getServerChanSendKey(item);
  if (!sendKey) return { sent: false, reason: 'no-sendkey' };
  const url = buildServerChanUrl(sendKey);
  if (!url) return { sent: false, reason: 'invalid-sendkey' };

  const desp = String(messageText || '').trim().slice(0, PUSH_BODY_MAX_CHARS);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      title: 'Claude在呼叫你……',
      desp: desp || '（空消息）',
      short: desp || undefined,
    }),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`ServerChan send ${response.status}: ${text.slice(0, 300)}`);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON 响应但 HTTP 成功，按成功处理
  }
  if (data && typeof data.code === 'number' && data.code !== 0) {
    // code 非 0 通常是 SendKey 错误或超出配额
    throw new Error(`ServerChan error ${data.code}: ${data.message || text.slice(0, 300)}`);
  }
  return { sent: true };
}

function getWxPusherConfig(item) {
  if (getPushProvider(item) === 'serverchan') return null;
  const config = item?.push?.wxPusher || {};
  const appToken = String(config.appToken || WXPUSHER_APP_TOKEN || '').trim();
  const uids = splitPushList(config.uids || config.uid || WXPUSHER_UIDS);
  const topicIds = normalizeTopicIds(config.topicIds || config.topicId || WXPUSHER_TOPIC_IDS);
  if (!appToken) return null;
  return { appToken, uids, topicIds };
}

function buildConversationDeepLink(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return undefined;
  const encodedId = encodeURIComponent(id);
  const base = String(YSCLAUDE_APP_DEEPLINK_BASE || '').trim();
  if (!base) return `ysclaude://chat/${encodedId}`;
  if (base.includes('{conversationId}')) return base.replaceAll('{conversationId}', encodedId);
  return `${base.replace(/\/?$/, '/')}${encodedId}`;
}

async function sendWxPusherUserMessagePush(item, messageText) {
  const config = getWxPusherConfig(item);
  if (!config) return { sent: false, reason: 'no-app-token' };
  if (config.uids.length === 0 && config.topicIds.length === 0) {
    return { sent: false, reason: 'no-recipient' };
  }

  const content = String(messageText || '').trim().slice(0, PUSH_BODY_MAX_CHARS) || '（空消息）';
  const url = buildConversationDeepLink(item?.conversationId);
  const response = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({
      appToken: config.appToken,
      content,
      summary: 'Claude在呼叫你……',
      contentType: 1,
      url,
      uids: config.uids.length ? config.uids : undefined,
      topicIds: config.topicIds.length ? config.topicIds : undefined,
    }),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`WxPusher send ${response.status}: ${text.slice(0, 300)}`);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && data.code !== 1000) {
    return { sent: false, reason: data.msg || data.message || `code-${data.code}` };
  }
  return { sent: true };
}

async function sendUserMessagePushes(item, messageText) {
  const senders = [];
  if (getServerChanSendKey(item)) {
    senders.push(['serverchan', () => sendServerChanUserMessagePush(item, messageText)]);
  }
  if (getWxPusherConfig(item)) {
    senders.push(['wxpusher', () => sendWxPusherUserMessagePush(item, messageText)]);
  }
  if (senders.length === 0) {
    return [{ channel: 'none', sent: false, reason: 'no-channel' }];
  }

  const results = [];
  for (const [channel, sender] of senders) {
    try {
      results.push({ channel, ...(await sender()) });
    } catch (error) {
      results.push({ channel, sent: false, error: error.message || String(error) });
    }
  }
  return results;
}

function getAgentToolDefinitions(agentTools = {}) {
  const tools = [];
  if (agentTools.memoryVault?.enabled && agentTools.memoryVault.baseUrl) {
    tools.push(
      {
        type: 'function',
        function: {
          name: 'search_memory_vault',
          description: '语义搜索记忆库，用于回忆用户过去经历、偏好、计划、关系和长期信息。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索关键词或语义查询' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'keyword_search_memory_vault',
          description: '关键词搜索记忆库，用于查找明确词语、名称、标签或原文片段。',
          parameters: {
            type: 'object',
            properties: {
              keywords: { type: 'string', description: '一个或多个关键词，多个关键词用空格分隔' },
            },
            required: ['keywords'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'query_diary',
          description: '查询指定日期的日记内容。',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: '日期，格式为 YYYY-MM-DD' },
            },
            required: ['date'],
          },
        },
      }
    );
  }
  if (agentTools.webSearch?.enabled && agentTools.webSearch.tavilyApiKey) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: '通过 Tavily 搜索互联网获取实时信息。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索查询词' },
          },
          required: ['query'],
        },
      },
    });
  }
  return tools;
}

async function executeAgentTool(toolName, args, agentTools = {}) {
  switch (toolName) {
    case 'search_memory_vault':
      return executeMemorySearch(args.query, agentTools.memoryVault);
    case 'keyword_search_memory_vault':
      return executeMemoryKeywordSearch(args.keywords || args.query, agentTools.memoryVault);
    case 'query_diary':
      return executeDiaryQuery(args.date, agentTools.memoryVault);
    case 'web_search':
      return executeWebSearch(args.query, agentTools.webSearch);
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

async function executeMemorySearch(query, config) {
  if (!config?.baseUrl) throw new Error('未配置记忆库地址');
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const params = new URLSearchParams({
    query: String(query || ''),
    top_k: String(config.topK || 5),
    token_budget: String(config.tokenBudget || 2000),
  });
  const resp = await fetch(`${baseUrl}/api/search?${params}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`记忆库搜索失败: HTTP ${resp.status}`);
  return formatMemorySearchResponse(await resp.json(), '相关记忆');
}

async function executeMemoryKeywordSearch(keywords, config) {
  if (!config?.baseUrl) throw new Error('未配置记忆库地址');
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const params = new URLSearchParams({
    q: String(keywords || ''),
    top_k: String(config.topK || 5),
    token_budget: String(config.tokenBudget || 2000),
  });
  const resp = await fetch(`${baseUrl}/api/search/keyword?${params}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`记忆库关键词搜索失败: HTTP ${resp.status}`);
  return formatMemorySearchResponse(await resp.json(), '关键词命中记忆');
}

function formatMemorySearchResponse(data, resultLabel) {
  const items = data?.items || [];
  if (items.length === 0) return `未找到${resultLabel}。`;
  const lines = [`找到 ${items.length} 条${resultLabel}：\n`];
  for (const item of items) {
    const date = item.date || '未知日期';
    const content = item.original || item.summary || '';
    const tags = Array.isArray(item.tags) && item.tags.length > 0 ? ` #${item.tags.join(' #')}` : '';
    const score = item.score != null ? ` (相关度: ${(item.score * 100).toFixed(0)}%)` : '';
    lines.push(`【${date}】${score}${tags}\n${content}\n`);
  }
  return lines.join('\n');
}

async function executeDiaryQuery(date, config) {
  if (!config?.baseUrl) throw new Error('未配置记忆库地址');
  const baseUrl = String(config.baseUrl).replace(/\/$/, '');
  const resp = await fetch(`${baseUrl}/api/diary/${encodeURIComponent(String(date || ''))}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    if (resp.status === 404) return `未找到 ${date} 的日记。`;
    throw new Error(`日记查询失败: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const content = data.content || data.text || data.diary || data.body || JSON.stringify(data);
  return `【${date} 的日记】\n${content}`;
}

async function executeWebSearch(query, config) {
  if (!config?.tavilyApiKey) throw new Error('未配置 Tavily API Key');
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: String(query || ''),
      max_results: config.maxResults || 5,
      api_key: config.tavilyApiKey,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Tavily 搜索失败: HTTP ${resp.status} - ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const results = data.results || [];
  if (results.length === 0) return '未找到相关搜索结果。';
  return [
    `搜索到 ${results.length} 条结果：\n`,
    ...results.map((item) => `### ${item.title || '无标题'}\n${item.url || ''}\n${item.content || ''}\n`),
  ].join('\n');
}

async function callChatCompletion(request, { messages, maxTokens, tools } = {}) {
  const url = `${String(request.baseUrl || '').trim().replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: request.model,
    messages: messages || request.messages,
    stream: false,
    max_tokens: maxTokens,
  };
  if (typeof request.temperature === 'number') {
    body.temperature = request.temperature;
  }
  if (request.sessionId) {
    body.session_id = request.sessionId;
  }
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
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

async function callKeepaliveApi(request, maxTokens) {
  return callChatCompletion(request, { maxTokens });
}

function buildAgentTickToolLines(item, tools) {
  if (!tools || tools.length === 0) {
    return ['本次 tick 没有任何可用工具。不要尝试调用工具，仅基于已有上下文决定。'];
  }
  const capabilities = [];
  if (item.agentTools?.memoryVault?.enabled) {
    capabilities.push('记忆库搜索/日记查询');
  }
  if (item.agentTools?.webSearch?.enabled) {
    capabilities.push('Tavily 联网搜索');
  }
  return [
    `可用工具仅限：${capabilities.join('、')}。不要假装使用手机本地工具，不要控制设备。`,
    '如果需要回顾用户长期记忆或查询实时信息，可以调用工具；如果没有必要，请直接 noop。',
  ];
}

function buildAgentTickPrompt(item, plannedAt, tools) {
  const lastUserSnapshotAt = item.lastUserSnapshotAt || item.lastSnapshotAt || item.updatedAt || item.lastTouchedAt || plannedAt;
  const elapsedUserMinutes = Math.max(0, Math.round((plannedAt - lastUserSnapshotAt) / 60000));
  const currentTime = now();
  return [
    `Current server time: ${new Date(currentTime).toISOString()}`,
    `This wake was planned for: ${new Date(plannedAt).toISOString()}`,
    `Last user snapshot time: ${new Date(lastUserSnapshotAt).toISOString()}`,
    `Minutes since last user snapshot: ${elapsedUserMinutes}`,
    'Use "last user snapshot" as the time since the user last talked in the app. Do not reset it for ordinary server keepalive.',
    'Always include "next_awake" in the final JSON. Use an ISO 8601 timestamp for when you want to be awakened next.',
    'If the next wake is more than 55 minutes away, the server will run ordinary cache keepalive every 55 minutes until that time.',
    `距离用户上次在 App 侧对话/上传快照已经过去约 ${elapsedUserMinutes} 分钟。`,
    '你正在服务器端执行一次远程保活/自主活动 tick。',
    '你可以先什么都不做，也可以给用户留一条消息，也可以只进行内部活动记录。',
    ...buildAgentTickToolLines(item, tools),
    '最终必须只输出 JSON，不要 Markdown，不要额外解释：',
    '{"action":"noop","reason":"...","next_awake":"2026-07-04T12:30:00.000Z"}',
    '{"action":"user_message","message":"...","reason":"...","next_awake":"2026-07-04T12:30:00.000Z"}',
    'JSON without "next_awake" is invalid.',
    'Every final JSON object must include "next_awake".',
    '{"action":"user_message","message":"发给用户的消息","reason":"..."}',
    '{"action":"agent_activity","summary":"内部活动摘要","messagesToAppend":[{"role":"assistant","content":"可选：要写入后续上下文的简短记录"}]}',
  ].join('\n');
}

function parseJsonDecision(content) {
  const text = String(content || '').trim();
  if (!text) return { action: 'noop', reason: 'empty-response' };
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
  }
  return { action: 'agent_activity', summary: text.slice(0, 2000) };
}

function normalizeDecision(decision) {
  const action = decision?.action;
  const nextAwakeAt = extractDecisionNextAwakeAt(decision);
  if (action === 'user_message' && typeof decision.message === 'string' && decision.message.trim()) {
    return {
      action,
      message: decision.message.trim(),
      reason: typeof decision.reason === 'string' ? decision.reason : '',
      nextAwakeAt,
    };
  }
  if (action === 'agent_activity') {
    return {
      action,
      summary: String(decision.summary || decision.reason || '').trim() || '远程自主活动完成。',
      messagesToAppend: Array.isArray(decision.messagesToAppend) ? decision.messagesToAppend : [],
      reason: typeof decision.reason === 'string' ? decision.reason : '',
      nextAwakeAt,
    };
  }
  return {
    action: 'noop',
    reason: typeof decision?.reason === 'string' ? decision.reason : '',
    nextAwakeAt,
  };
}

async function runAgentTick(conversationId, item, plannedAt) {
  const tools = getAgentToolDefinitions(item.agentTools);
  const messages = [
    ...item.request.messages,
    { role: 'user', content: buildAgentTickPrompt(item, plannedAt, tools) },
  ];
  const toolTranscript = [];
  let toolCallCount = 0;
  let finalMessage = null;

  addLog('agent-tick-start', {
    conversationId,
    snapshotHash: item.snapshotHash,
    toolCount: tools.length,
    preview: item.preview,
    message: `tools ${tools.length}`,
  });

  while (true) {
    const response = await callChatCompletion(item.request, {
      messages,
      maxTokens: AGENT_TICK_MAX_TOKENS,
      tools: tools.length > 0 ? tools : undefined,
    });
    const assistantMessage = response?.choices?.[0]?.message || response?.message || {};
    finalMessage = assistantMessage;
    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length || toolCallCount >= AGENT_ACTIVITY_MAX_TOOL_ROUNDS) break;

    const assistantToolMessage = {
      role: 'assistant',
      tool_calls: toolCalls,
    };
    if (assistantMessage.content) {
      assistantToolMessage.content = assistantMessage.content;
    }
    messages.push(assistantToolMessage);

    for (const toolCall of toolCalls) {
      toolCallCount++;
      const name = toolCall?.function?.name || '';
      let args = {};
      try {
        args = JSON.parse(toolCall?.function?.arguments || '{}');
      } catch {
        args = {};
      }
      addLog('agent-tool-call', {
        conversationId,
        snapshotHash: item.snapshotHash,
        toolName: name,
        args,
        preview: item.preview,
        message: name,
      });
      let result = '';
      try {
        result = await executeAgentTool(name, args, item.agentTools);
        addLog('agent-tool-result', {
          conversationId,
          snapshotHash: item.snapshotHash,
          toolName: name,
          resultPreview: normalizePreviewText(result),
          preview: item.preview,
          message: name,
        });
      } catch (error) {
        result = `工具调用失败：${error.message || String(error)}`;
        addLog('agent-tool-error', {
          conversationId,
          snapshotHash: item.snapshotHash,
          toolName: name,
          error: result,
          preview: item.preview,
          message: name,
        });
      }
      toolTranscript.push({
        toolName: name,
        args,
        resultPreview: normalizePreviewText(result),
        createdAt: now(),
      });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
      if (toolCallCount >= AGENT_ACTIVITY_MAX_TOOL_ROUNDS) break;
    }
  }

  const decision = normalizeDecision(parseJsonDecision(finalMessage?.content || ''));
  return { decision, toolTranscript };
}

function appendAgentDecisionToSnapshot(item, decision, toolTranscript) {
  const createdAt = now();
  item.pendingMessages ||= [];
  item.activityLog ||= [];

  if (decision.action === 'user_message') {
    const message = {
      id: randomUUID(),
      role: 'assistant',
      content: decision.message,
      createdAt,
      source: 'remote-agent',
      toolTranscript,
      consumed: false,
    };
    item.pendingMessages.push(message);
    item.request.messages.push({ role: 'assistant', content: decision.message });
    item.activityLog.push({
      id: randomUUID(),
      type: 'user_message',
      summary: decision.reason || '远程 AI 给用户留言。',
      toolTranscript,
      createdAt,
      consumed: false,
    });
    return { changed: true, logType: 'agent-user-message', message: normalizePreviewText(decision.message) };
  }

  if (decision.action === 'agent_activity') {
    const summary = decision.summary || '远程自主活动完成。';
    // 统一固定 assistant 角色：客户端 API 管线只回传 user/assistant，其他角色会被丢弃导致缓存前缀分叉
    const messagesToAppend = decision.messagesToAppend
      .filter((message) => message && typeof message.content === 'string')
      .map((message) => ({
        role: 'assistant',
        content: message.content,
      }));
    const fallbackLines = [`[远程自主活动记录]`, summary];
    if (toolTranscript.length > 0) {
      fallbackLines.push('', '工具调用：');
      for (const tool of toolTranscript) {
        fallbackLines.push(`- ${tool.toolName}: ${tool.resultPreview || '完成'}`);
      }
    }
    const contextMessages = messagesToAppend.length > 0
      ? messagesToAppend
      : [{ role: 'assistant', content: fallbackLines.join('\n') }];
    item.request.messages.push(...contextMessages);
    item.activityLog.push({
      id: randomUUID(),
      type: 'agent_activity',
      summary,
      toolTranscript,
      appendedMessages: contextMessages,
      createdAt,
      consumed: false,
    });
    return { changed: true, logType: 'agent-activity', message: normalizePreviewText(summary) };
  }

  item.activityLog.push({
    id: randomUUID(),
    type: 'noop',
    summary: decision.reason || '模型选择不主动行动。',
    toolTranscript,
    createdAt,
    consumed: true,
  });
  return { changed: false, logType: 'agent-noop', message: decision.reason || 'noop' };
}

async function runKeepalive(conversationId) {
  const item = state.conversations[conversationId];
  if (!item || item.status !== 'active') return;

  const plannedAt = item.nextKeepaliveAt || now();
  if (isInQuietHours(plannedAt, item.quietHours)) {
    await purgeAllStateForQuietHours('keepalive-in-quiet-hours');
    return;
  }

  try {
    let usedMaxTokens = 0;
    const agentToolDefinitions = getAgentToolDefinitions(item.agentTools);
    // agentTick.enabled 显式控制是否执行自主 tick；旧快照无该字段时退回"有工具才 tick"
    const runAgentWake = shouldRunAgentWake(item, plannedAt);
    let nextAwakeDecisionAt = null;
    if (runAgentWake) {
      const { decision, toolTranscript } = await runAgentTick(conversationId, item, plannedAt);
      nextAwakeDecisionAt = decision.nextAwakeAt;
      const applyResult = appendAgentDecisionToSnapshot(item, decision, toolTranscript);
      if (applyResult.changed) {
        item.snapshotHash = snapshotHash(item.request);
        item.preview = buildSnapshotPreview(item.request);
      }
      addLog(applyResult.logType, {
        conversationId,
        snapshotHash: item.snapshotHash,
        decision,
        toolCalls: toolTranscript.length,
        preview: item.preview,
        message: applyResult.message,
      });
      if (applyResult.logType === 'agent-user-message') {
        if (getServerChanSendKey(item)) {
        // 推送失败不能中断保活周期
        try {
          const pushResult = await sendServerChanUserMessagePush(item, decision.message);
          addLog(pushResult.sent ? 'push-ok' : 'push-skipped', {
            conversationId,
            reason: pushResult.reason,
            message: pushResult.sent ? 'push sent' : `skipped: ${pushResult.reason}`,
          });
        } catch (error) {
          addLog('push-error', {
            conversationId,
            error: error.message || String(error),
            message: error.message || String(error),
          });
        }
        }
        if (getWxPusherConfig(item)) {
          try {
            const pushResult = await sendWxPusherUserMessagePush(item, decision.message);
            addLog(pushResult.sent ? 'push-ok' : 'push-skipped', {
              conversationId,
              channel: 'wxpusher',
              reason: pushResult.reason,
              message: pushResult.sent ? 'wxpusher push sent' : `skipped: ${pushResult.reason}`,
            });
          } catch (error) {
            addLog('push-error', {
              conversationId,
              channel: 'wxpusher',
              error: error.message || String(error),
              message: error.message || String(error),
            });
          }
        }
      }
    } else {
      try {
        await callKeepaliveApi(item.request, 0);
      } catch (error) {
        if (!shouldRetryWithOneToken(error)) throw error;
        addLog('keepalive-retry', {
          conversationId,
          snapshotHash: item.snapshotHash,
          maxTokens: 1,
          error: error.message || String(error),
          preview: item.preview,
          message: 'retry max_tokens=1',
        });
        usedMaxTokens = 1;
        await callKeepaliveApi(item.request, 1);
      }
    }

    item.lastTouchedAt = now();
    if (runAgentWake) {
      item.nextAwakeAt = nextAwakeDecisionAt || item.lastTouchedAt + KEEPALIVE_INTERVAL_MS;
    }
    const nextSchedule = computeNextSchedule(item, item.lastTouchedAt);
    item.nextAwakeAt = nextSchedule.nextAwakeAt;
    item.nextKeepaliveAt = nextSchedule.nextKeepaliveAt;
    item.nextTriggerKind = nextSchedule.triggerKind;
    item.lastError = null;
    item.updatedAt = item.lastTouchedAt;
    addLog('keepalive-ok', {
      conversationId,
      snapshotHash: item.snapshotHash,
      maxTokens: usedMaxTokens,
      touchedAt: item.lastTouchedAt,
      nextAwakeAt: item.nextAwakeAt,
      nextKeepaliveAt: item.nextKeepaliveAt,
      nextTriggerKind: item.nextTriggerKind,
      preview: item.preview,
      message: `${item.nextTriggerKind} ${new Date(item.nextKeepaliveAt).toISOString()}`,
    });
    scheduleConversation(conversationId);
    await saveState();
  } catch (error) {
    item.lastError = error.message || String(error);
    item.lastFailedAt = now();
    item.nextKeepaliveAt = Math.min(now() + 5 * 60 * 1000, plannedAt + 10 * 60 * 1000);
    item.nextTriggerKind = 'retry';
    item.updatedAt = now();
    addLog('keepalive-error', {
      conversationId,
      snapshotHash: item.snapshotHash,
      error: item.lastError,
      failedAt: item.lastFailedAt,
      retryAt: item.nextKeepaliveAt,
      preview: item.preview,
      message: item.lastError,
    });
    scheduleConversation(conversationId);
    await saveState();
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
    agentTools: normalizeAgentTools(input.agentTools),
    agentTick: normalizeAgentTick(input.agentTick),
    push: normalizePushConfig(input.push),
  };
}

function normalizeAgentTick(agentTick) {
  if (!agentTick || typeof agentTick !== 'object' || typeof agentTick.enabled !== 'boolean') return undefined;
  return { enabled: agentTick.enabled };
}

function normalizePushConfig(push) {
  if (!push || typeof push !== 'object') return undefined;
  const providerInput = String(push.provider || push.channel || '').trim().toLowerCase();
  const provider = providerInput === 'serverchan' || providerInput === 'wxpusher' || providerInput === 'both'
    ? providerInput
    : 'both';
  const serverChanSendKey = typeof push.serverChanSendKey === 'string' ? push.serverChanSendKey.trim() : '';
  const wxInput = push.wxPusher && typeof push.wxPusher === 'object' ? push.wxPusher : push;
  const wxPusherAppToken = typeof wxInput.appToken === 'string' ? wxInput.appToken.trim() : '';
  const wxPusherUids = splitPushList(wxInput.uids || wxInput.uid);
  const wxPusherTopicIds = normalizeTopicIds(wxInput.topicIds || wxInput.topicId);
  const normalized = {};
  if ((provider === 'serverchan' || provider === 'both') && serverChanSendKey) normalized.serverChanSendKey = serverChanSendKey;
  if ((provider === 'wxpusher' || provider === 'both') && wxPusherAppToken && (wxPusherUids.length > 0 || wxPusherTopicIds.length > 0)) {
    normalized.wxPusher = {
      appToken: wxPusherAppToken,
      uids: wxPusherUids,
      topicIds: wxPusherTopicIds,
    };
  }
  if (Object.keys(normalized).length) normalized.provider = provider;
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeAgentTools(agentTools) {
  if (!agentTools || typeof agentTools !== 'object') return undefined;
  const normalized = {};
  if (agentTools.memoryVault?.enabled && agentTools.memoryVault.baseUrl) {
    normalized.memoryVault = {
      enabled: true,
      baseUrl: String(agentTools.memoryVault.baseUrl).trim().replace(/\/$/, ''),
      topK: Math.max(1, Number(agentTools.memoryVault.topK) || 5),
      tokenBudget: Math.max(500, Number(agentTools.memoryVault.tokenBudget) || 2000),
      maxToolCalls: Math.max(1, Number(agentTools.memoryVault.maxToolCalls) || 3),
    };
  }
  if (agentTools.webSearch?.enabled && agentTools.webSearch.tavilyApiKey) {
    normalized.webSearch = {
      enabled: true,
      tavilyApiKey: String(agentTools.webSearch.tavilyApiKey).trim(),
      maxResults: Math.max(1, Number(agentTools.webSearch.maxResults) || 5),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function handleSnapshot(req, res) {
  const input = validateSnapshot(await readJsonBody(req));
  const touchedAt = now();
  const hash = snapshotHash(input.request);
  const preview = buildSnapshotPreview(input.request);
  const existing = state.conversations[input.conversationId] || {};
  const initialSchedule = computeNextSchedule(
    { agentTools: input.agentTools, agentTick: input.agentTick },
    touchedAt
  );
  const nextKeepaliveAt = initialSchedule.nextKeepaliveAt;

  if (isInQuietHours(nextKeepaliveAt, input.quietHours)) {
    await purgeAllStateForQuietHours('snapshot-next-trigger-in-quiet-hours');
    jsonResponse(res, 200, { ok: true, status: 'cleared', reason: 'quiet-hours' });
    return;
  }

  state.conversations[input.conversationId] = {
    conversationId: input.conversationId,
    snapshotHash: hash,
    request: input.request,
    quietHours: input.quietHours,
    agentTools: input.agentTools,
    agentTick: input.agentTick,
    push: input.push || existing.push,
    preview,
    status: 'active',
    disabledReason: null,
    lastUserSnapshotAt: touchedAt,
    lastTouchedAt: touchedAt,
    nextKeepaliveAt,
    nextAwakeAt: initialSchedule.nextAwakeAt,
    nextTriggerKind: initialSchedule.triggerKind,
    updatedAt: touchedAt,
    lastError: null,
    pendingMessages: existing.pendingMessages || [],
    activityLog: existing.activityLog || [],
  };
  addLog('snapshot-updated', {
    conversationId: input.conversationId,
    snapshotHash: hash,
    lastUserSnapshotAt: touchedAt,
    nextKeepaliveAt,
    nextAwakeAt: initialSchedule.nextAwakeAt,
    nextTriggerKind: initialSchedule.triggerKind,
    preview,
    message: `${initialSchedule.triggerKind} ${new Date(nextKeepaliveAt).toISOString()}`,
  });
  scheduleConversation(input.conversationId);
  await saveState();
  jsonResponse(res, 200, {
    ok: true,
    status: 'active',
    snapshotHash: hash,
    lastUserSnapshotAt: touchedAt,
    nextKeepaliveAt,
    nextAwakeAt: initialSchedule.nextAwakeAt,
    nextTriggerKind: initialSchedule.triggerKind,
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
  addLog('keepalive-disabled', {
    conversationId,
    reason: 'client-disable',
    snapshotHash: existing.snapshotHash,
    preview: existing.preview,
    message: 'client-disable',
  });
  await saveState();
  scheduleQuietHoursPurge();
  jsonResponse(res, 200, { ok: true, status: 'disabled' });
}

async function deleteConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) {
    const error = new Error('conversationId is required');
    error.statusCode = 400;
    throw error;
  }
  const existing = getConversationOr404(id);
  clearConversationTimer(id);
  delete state.conversations[id];
  addLog('conversation-deleted', {
    conversationId: id,
    snapshotHash: existing.snapshotHash,
    status: existing.status,
    preview: existing.preview,
    message: 'deleted',
  });
  await saveState();
  scheduleQuietHoursPurge();
  return existing;
}

async function handleDeleteConversation(req, res, conversationIdFromPath = '') {
  let conversationId = String(conversationIdFromPath || '').trim();
  if (!conversationId && req.method !== 'GET') {
    const input = await readJsonBody(req);
    conversationId = String(input.conversationId || '').trim();
  }
  const deleted = await deleteConversation(conversationId);
  jsonResponse(res, 200, {
    ok: true,
    deleted: {
      conversationId: deleted.conversationId || conversationId,
      snapshotHash: deleted.snapshotHash || null,
      status: deleted.status || null,
    },
  });
}

function publicStatus() {
  return Object.values(state.conversations).map((item) => ({
    conversationId: item.conversationId,
    snapshotHash: item.snapshotHash,
    status: item.status,
    disabledReason: item.disabledReason,
    lastUserSnapshotAt: item.lastUserSnapshotAt || null,
    lastTouchedAt: item.lastTouchedAt,
    nextKeepaliveAt: item.nextKeepaliveAt,
    nextAwakeAt: item.nextAwakeAt || null,
    nextTriggerKind: item.nextTriggerKind || null,
    lastError: item.lastError,
    updatedAt: item.updatedAt,
    preview: item.preview,
    agentToolsEnabled: getAgentToolDefinitions(item.agentTools).map((tool) => tool.function.name),
    agentTickEnabled: item.agentTick ? item.agentTick.enabled === true : getAgentToolDefinitions(item.agentTools).length > 0,
    pushConfigured: Boolean(getServerChanSendKey(item) || getWxPusherConfig(item)),
    pendingMessageCount: (item.pendingMessages || []).filter((message) => !message.consumed).length,
    activityCount: (item.activityLog || []).filter((entry) => !entry.consumed).length,
  }));
}

function publicLogs({ limit = 100, conversationId } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const logs = conversationId
    ? state.logs.filter((entry) => entry.conversationId === conversationId)
    : state.logs;
  return logs.slice(-safeLimit).reverse();
}

function getConversationOr404(conversationId) {
  const item = state.conversations[conversationId];
  if (!item) {
    const error = new Error('conversation not found');
    error.statusCode = 404;
    throw error;
  }
  return item;
}

function publicInbox(conversationId) {
  const item = getConversationOr404(conversationId);
  return (item.pendingMessages || []).filter((message) => !message.consumed);
}

function publicActivity(conversationId, limit = 100) {
  const item = getConversationOr404(conversationId);
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return (item.activityLog || [])
    .filter((entry) => !entry.consumed)
    .slice(-safeLimit)
    .reverse();
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>YSClaude Keepalive Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f4ee;
      --panel: #ffffff;
      --text: #171412;
      --muted: #746b62;
      --border: #e4ded5;
      --primary: #c96f13;
      --danger: #dc2626;
      --success: #15803d;
      --shadow: 0 10px 28px rgba(44, 31, 20, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #12100d;
        --panel: #211c17;
        --text: #f7f2ea;
        --muted: #baafa3;
        --border: #3a3027;
        --primary: #f59e0b;
        --danger: #f87171;
        --success: #4ade80;
        --shadow: none;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }
    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: clamp(24px, 4vw, 36px);
      letter-spacing: 0;
    }
    .subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 16px;
      margin-bottom: 16px;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(160px, 260px) auto;
      gap: 10px;
      align-items: end;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 10px;
      background: transparent;
      color: var(--text);
      font: inherit;
    }
    button {
      min-height: 40px;
      border: 1px solid var(--primary);
      border-radius: 8px;
      padding: 8px 12px;
      background: transparent;
      color: var(--primary);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.primary {
      background: var(--primary);
      color: #fff;
    }
    button.danger {
      border-color: var(--danger);
      color: var(--danger);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      margin-top: 10px;
    }
    .summary strong { color: var(--text); }
    .grid {
      display: grid;
      gap: 12px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      background: color-mix(in srgb, var(--panel), var(--bg) 20%);
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }
    .id {
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      word-break: break-all;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 3px 9px;
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      white-space: nowrap;
    }
    .pill.active {
      border-color: color-mix(in srgb, var(--success), transparent 45%);
      color: var(--success);
    }
    .pill.disabled {
      border-color: color-mix(in srgb, var(--danger), transparent 45%);
      color: var(--danger);
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 12px 0;
    }
    .field {
      border-top: 1px solid var(--border);
      padding-top: 8px;
      min-width: 0;
    }
    .field-name {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .field-value {
      margin-top: 3px;
      font-size: 13px;
      word-break: break-word;
    }
    .tail {
      color: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .notice {
      min-height: 22px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
    }
    .notice.error { color: var(--danger); }
    .empty {
      color: var(--muted);
      text-align: center;
      padding: 32px 8px;
    }
    @media (max-width: 780px) {
      header { display: block; }
      .controls { grid-template-columns: 1fr; }
      .meta { grid-template-columns: 1fr 1fr; }
      .card-head { display: block; }
      .pill { margin-top: 8px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Keepalive Admin</h1>
        <div class="subtitle">查看、停用或删除服务端保存的 Prompt Cache 快照。</div>
      </div>
      <button id="refreshTop" type="button">刷新</button>
    </header>

    <section class="panel">
      <div class="controls">
        <label>
          服务地址
          <input id="baseUrl" autocomplete="url" />
        </label>
        <label>
          访问令牌
          <input id="token" type="password" autocomplete="current-password" placeholder="KEEPALIVE_AUTH_TOKEN" />
        </label>
        <button id="refresh" class="primary" type="button">读取状态</button>
      </div>
      <div class="summary" id="summary"></div>
      <div class="notice" id="notice"></div>
    </section>

    <section class="grid" id="conversations"></section>
  </main>

  <script>
    const baseUrlInput = document.querySelector("#baseUrl");
    const tokenInput = document.querySelector("#token");
    const refreshButton = document.querySelector("#refresh");
    const refreshTopButton = document.querySelector("#refreshTop");
    const conversationsNode = document.querySelector("#conversations");
    const summaryNode = document.querySelector("#summary");
    const noticeNode = document.querySelector("#notice");

    baseUrlInput.value = localStorage.getItem("ysclaude.keepalive.admin.baseUrl") || location.origin;
    tokenInput.value = localStorage.getItem("ysclaude.keepalive.admin.token") || "";

    function apiBase() {
      return baseUrlInput.value.trim().replace(/\\/$/, "");
    }

    function authHeaders() {
      const token = tokenInput.value.trim();
      return token ? { Authorization: "Bearer " + token } : {};
    }

    function setNotice(message, isError = false) {
      noticeNode.textContent = message || "";
      noticeNode.classList.toggle("error", Boolean(isError));
    }

    function formatTime(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      return date.toLocaleString();
    }

    function shortHash(value) {
      return value ? String(value).slice(0, 12) : "—";
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    async function requestJson(path, options = {}) {
      const response = await fetch(apiBase() + path, {
        ...options,
        headers: {
          ...authHeaders(),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "HTTP " + response.status);
      }
      return data;
    }

    function render(conversations) {
      const activeCount = conversations.filter((item) => item.status === "active").length;
      const pendingCount = conversations.reduce((sum, item) => sum + Number(item.pendingMessageCount || 0), 0);
      const activityCount = conversations.reduce((sum, item) => sum + Number(item.activityCount || 0), 0);
      summaryNode.innerHTML = [
        "<span>会话 <strong>" + conversations.length + "</strong></span>",
        "<span>活跃 <strong>" + activeCount + "</strong></span>",
        "<span>待收件 <strong>" + pendingCount + "</strong></span>",
        "<span>自主活动 <strong>" + activityCount + "</strong></span>",
      ].join("");

      if (conversations.length === 0) {
        conversationsNode.innerHTML = '<div class="panel empty">暂无快照会话。</div>';
        return;
      }

      conversationsNode.innerHTML = conversations.map((item) => {
        const statusClass = item.status === "active" ? "active" : item.status === "disabled" ? "disabled" : "";
        const preview = item.preview || {};
        const tools = Array.isArray(item.agentToolsEnabled) && item.agentToolsEnabled.length
          ? item.agentToolsEnabled.join(", ")
          : "—";
        return '<article class="card" data-id="' + escapeHtml(item.conversationId) + '">' +
          '<div class="card-head">' +
            '<div>' +
              '<div class="field-name">Conversation</div>' +
              '<div class="id">' + escapeHtml(item.conversationId) + '</div>' +
            '</div>' +
            '<span class="pill ' + statusClass + '">' + escapeHtml(item.status || "unknown") + '</span>' +
          '</div>' +
          '<div class="meta">' +
            field("Hash", shortHash(item.snapshotHash)) +
            field("Model", preview.model || "—") +
            field("Messages", preview.messageCount ?? "—") +
            field("Next", formatTime(item.nextKeepaliveAt)) +
            field("Awake", formatTime(item.nextAwakeAt)) +
            field("Trigger", item.nextTriggerKind || "--") +
            field("Last user", formatTime(item.lastUserSnapshotAt)) +
            field("Last touched", formatTime(item.lastTouchedAt)) +
            field("Updated", formatTime(item.updatedAt)) +
            field("Pending", item.pendingMessageCount || 0) +
            field("Activity", item.activityCount || 0) +
            field("Agent tick", item.agentTickEnabled ? "on" : "off") +
            field("Push", item.pushConfigured ? "configured" : "—") +
            field("Tools", tools) +
            field("Disabled reason", item.disabledReason || "—") +
          '</div>' +
          '<div class="tail">' + escapeHtml((preview.lastMessageRole ? preview.lastMessageRole + ": " : "") + (preview.lastMessageTail || "暂无消息片段")) + '</div>' +
          (item.lastError ? '<div class="notice error">保活失败：' + escapeHtml(item.lastError) + '</div>' : '') +
          '<div class="actions">' +
            '<button type="button" data-action="logs">查看日志</button>' +
            '<button type="button" data-action="disable" ' + (item.status === "disabled" ? "disabled" : "") + '>停用</button>' +
            '<button type="button" class="danger" data-action="delete">删除</button>' +
          '</div>' +
        '</article>';
      }).join("");
    }

    function field(name, value) {
      return '<div class="field"><div class="field-name">' + escapeHtml(name) + '</div><div class="field-value">' + escapeHtml(value) + '</div></div>';
    }

    async function refresh() {
      refreshButton.disabled = true;
      refreshTopButton.disabled = true;
      setNotice("读取中...");
      localStorage.setItem("ysclaude.keepalive.admin.baseUrl", apiBase());
      localStorage.setItem("ysclaude.keepalive.admin.token", tokenInput.value.trim());
      try {
        const data = await requestJson("/v1/keepalive/status");
        render(Array.isArray(data.conversations) ? data.conversations : []);
        setNotice("已刷新 " + new Date().toLocaleTimeString());
      } catch (error) {
        setNotice(error.message || String(error), true);
      } finally {
        refreshButton.disabled = false;
        refreshTopButton.disabled = false;
      }
    }

    async function disableConversation(conversationId) {
      if (!confirm("停用这个快照会话？\\n" + conversationId)) return;
      await requestJson("/v1/keepalive/disable", {
        method: "POST",
        body: JSON.stringify({ conversationId, updatedAt: Date.now() }),
      });
      await refresh();
    }

    async function deleteConversation(conversationId) {
      if (!confirm("永久删除这个快照会话？\\n删除后服务端不会再显示它，相关待收件和活动记录也会一起删除。\\n\\n" + conversationId)) return;
      await requestJson("/v1/keepalive/conversations/" + encodeURIComponent(conversationId), {
        method: "DELETE",
      });
      await refresh();
    }

    async function showLogs(conversationId) {
      try {
        const data = await requestJson("/v1/keepalive/logs?limit=40&conversationId=" + encodeURIComponent(conversationId));
        const lines = (data.logs || []).map((entry) => {
          return "[" + formatTime(entry.createdAt) + "] " + entry.type + " " + (entry.message || entry.error || "");
        });
        alert(lines.length ? lines.join("\\n") : "暂无日志");
      } catch (error) {
        setNotice(error.message || String(error), true);
      }
    }

    conversationsNode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const card = button.closest("[data-id]");
      const conversationId = card?.dataset.id;
      if (!conversationId) return;
      const action = button.dataset.action;
      if (action === "disable") disableConversation(conversationId).catch((error) => setNotice(error.message || String(error), true));
      if (action === "delete") deleteConversation(conversationId).catch((error) => setNotice(error.message || String(error), true));
      if (action === "logs") showLogs(conversationId);
    });

    refreshButton.addEventListener("click", refresh);
    refreshTopButton.addEventListener("click", refresh);
    refresh();
  </script>
</body>
</html>`;
}

async function handleAck(req, res, collectionName) {
  const input = await readJsonBody(req);
  const conversationId = String(input.conversationId || '').trim();
  const ids = Array.isArray(input.ids) ? new Set(input.ids.map((id) => String(id))) : null;
  if (!conversationId) {
    jsonResponse(res, 400, { ok: false, error: 'conversationId is required' });
    return;
  }
  const item = getConversationOr404(conversationId);
  const collection = item[collectionName] || [];
  let count = 0;
  for (const entry of collection) {
    if (!ids || ids.has(String(entry.id))) {
      entry.consumed = true;
      entry.consumedAt = now();
      count++;
    }
  }
  item.updatedAt = now();
  addLog(`${collectionName}-ack`, {
    conversationId,
    count,
    message: String(count),
  });
  await saveState();
  jsonResponse(res, 200, { ok: true, count });
}

async function handlePushToken(req, res) {
  const input = await readJsonBody(req);
  const push = normalizePushConfig(input.push || input);
  if (!push) {
    jsonResponse(res, 400, { ok: false, error: 'push channel config is required' });
    return;
  }
  // 单用户服务器：SendKey 更新时同步到所有会话
  let updated = 0;
  for (const item of Object.values(state.conversations)) {
    item.push = push;
    updated++;
  }
  addLog('push-token-updated', {
    updated,
    message: `updated ${updated} conversations`,
  });
  await saveState();
  jsonResponse(res, 200, { ok: true, updated });
}

async function handlePushTest(req, res) {
  const input = await readJsonBody(req);
  const push = normalizePushConfig(input.push || input);
  const item = { push };
  const results = await sendUserMessagePushes(item, input.message || 'YSClaude 推送测试：通知通道工作正常。');
  const ok = results.some((result) => result.sent);
  for (const result of results) {
    addLog(result.sent ? 'push-test-ok' : result.error ? 'push-test-error' : 'push-test-skipped', {
      channel: result.channel,
      reason: result.reason,
      error: result.error,
      message: result.sent ? `${result.channel} test push sent` : result.error || `skipped: ${result.reason}`,
    });
  }
  jsonResponse(res, ok ? 200 : 400, {
    ok,
    results,
    error: ok ? undefined : results[0]?.error || results[0]?.reason,
  });
  return;
  try {
    const result = await sendServerChanUserMessagePush(item, input.message || 'YSClaude 推送测试：Server酱通道工作正常。');
    addLog(result.sent ? 'push-test-ok' : 'push-test-skipped', {
      reason: result.reason,
      message: result.sent ? 'test push sent' : `skipped: ${result.reason}`,
    });
    jsonResponse(res, result.sent ? 200 : 400, { ok: result.sent, reason: result.reason });
  } catch (error) {
    addLog('push-test-error', { error: error.message || String(error), message: error.message || String(error) });
    jsonResponse(res, 502, { ok: false, error: error.message || String(error) });
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      htmlResponse(res, 200, adminPageHtml());
      return;
    }

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
    if (req.method === 'GET' && url.pathname === '/v1/keepalive/logs') {
      jsonResponse(res, 200, {
        ok: true,
        logs: publicLogs({
          limit: url.searchParams.get('limit') || 100,
          conversationId: url.searchParams.get('conversationId') || '',
        }),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/keepalive/inbox') {
      const conversationId = String(url.searchParams.get('conversationId') || '').trim();
      jsonResponse(res, 200, { ok: true, messages: publicInbox(conversationId) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/inbox/ack') {
      await handleAck(req, res, 'pendingMessages');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/keepalive/activity') {
      const conversationId = String(url.searchParams.get('conversationId') || '').trim();
      jsonResponse(res, 200, {
        ok: true,
        activity: publicActivity(conversationId, url.searchParams.get('limit') || 100),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/activity/ack') {
      await handleAck(req, res, 'activityLog');
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
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/delete') {
      await handleDeleteConversation(req, res);
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/keepalive/conversations/')) {
      const conversationId = decodeURIComponent(url.pathname.slice('/v1/keepalive/conversations/'.length));
      await handleDeleteConversation(req, res, conversationId);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/push-token') {
      await handlePushToken(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/push-test') {
      await handlePushTest(req, res);
      return;
    }
    jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { ok: false, error: error.message || String(error) });
  }
}

await loadState();
if (SERVERCHAN_SENDKEY) {
  console.log('[push] ServerChan fallback SendKey configured');
} else {
  console.log('[push] no SERVERCHAN_SENDKEY env; push uses per-conversation SendKey from client');
}
if (WXPUSHER_APP_TOKEN) {
  console.log('[push] WxPusher fallback AppToken configured');
}
for (const item of Object.values(state.conversations)) {
  if (item.status === 'active') {
    scheduleConversation(item.conversationId);
  }
}
scheduleQuietHoursPurge();

createServer(route).listen(PORT, HOST, () => {
  console.log(`YSClaude keepalive server listening on http://${HOST}:${PORT}`);
  if (!AUTH_TOKEN) {
    console.warn('KEEPALIVE_AUTH_TOKEN is empty. Set it before exposing this server.');
  }
});
