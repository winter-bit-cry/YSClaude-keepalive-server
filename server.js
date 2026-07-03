import { createServer } from 'node:http';
import { createHash, createSign, randomUUID } from 'node:crypto';
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
const FCM_SERVICE_ACCOUNT_JSON = process.env.FCM_SERVICE_ACCOUNT_JSON || '';
const FCM_SERVICE_ACCOUNT_FILE = process.env.FCM_SERVICE_ACCOUNT_FILE || '';
const FCM_PUSH_BODY_MAX_CHARS = 200;

const state = {
  conversations: {},
  logs: [],
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
    message: `next ${new Date(item.nextKeepaliveAt).toISOString()}`,
  });
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

let fcmServiceAccount = null;
const fcmAccessTokenCache = { token: null, expiresAt: 0 };

async function loadFcmServiceAccount() {
  let raw = FCM_SERVICE_ACCOUNT_JSON;
  if (!raw && FCM_SERVICE_ACCOUNT_FILE) {
    try {
      raw = await readFile(FCM_SERVICE_ACCOUNT_FILE, 'utf8');
    } catch (error) {
      console.warn('[fcm] service account file read failed:', error.message);
      return;
    }
  }
  if (!raw) {
    console.warn('[fcm] no service account configured, push disabled (set FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE)');
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error('missing client_email/private_key/project_id');
    }
    fcmServiceAccount = parsed;
    console.log(`[fcm] push enabled for project ${parsed.project_id}`);
  } catch (error) {
    console.warn('[fcm] service account parse failed, push disabled:', error.message);
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getFcmAccessToken() {
  if (!fcmServiceAccount) throw new Error('FCM service account not configured');
  if (fcmAccessTokenCache.token && fcmAccessTokenCache.expiresAt > now()) {
    return fcmAccessTokenCache.token;
  }
  const iat = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: fcmServiceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(fcmServiceAccount.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`FCM oauth ${response.status}: ${text}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('FCM oauth response missing access_token');
  fcmAccessTokenCache.token = data.access_token;
  fcmAccessTokenCache.expiresAt = now() + Math.max(60, Number(data.expires_in || 3600) - 600) * 1000;
  return fcmAccessTokenCache.token;
}

function isFcmTokenInvalidError(status, bodyText) {
  if (status === 404) return true;
  const text = String(bodyText || '');
  return text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT');
}

async function sendFcmUserMessagePush(item, messageText) {
  if (!fcmServiceAccount) return { sent: false, reason: 'no-service-account' };
  const fcmToken = item.push?.fcmToken;
  if (!fcmToken) return { sent: false, reason: 'no-token' };

  const body = String(messageText || '').trim().slice(0, FCM_PUSH_BODY_MAX_CHARS);
  const payload = {
    message: {
      token: fcmToken,
      notification: {
        title: 'Claude在呼叫你……',
        body,
      },
      android: {
        priority: 'high',
        notification: { channel_id: 'chat-replies-message-alert-v2' },
      },
      data: {
        kind: 'remote-agent-user-message',
        conversationId: String(item.conversationId || ''),
      },
    },
  };
  const url = `https://fcm.googleapis.com/v1/projects/${fcmServiceAccount.project_id}/messages:send`;

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getFcmAccessToken()}`,
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 401) {
    fcmAccessTokenCache.token = null;
    fcmAccessTokenCache.expiresAt = 0;
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await getFcmAccessToken()}`,
      },
      body: JSON.stringify(payload),
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (isFcmTokenInvalidError(response.status, text)) {
      delete item.push;
      addLog('fcm-token-invalid', {
        conversationId: item.conversationId,
        status: response.status,
        message: `token invalidated (${response.status})`,
      });
      return { sent: false, reason: 'token-invalid' };
    }
    throw new Error(`FCM send ${response.status}: ${text}`);
  }
  return { sent: true };
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
  const elapsedMinutes = Math.max(1, Math.round((plannedAt - (item.lastTouchedAt || item.updatedAt || plannedAt)) / 60000));
  return [
    `距离上次对话或保活已经过去约 ${elapsedMinutes} 分钟。`,
    '你正在服务器端执行一次远程保活/自主活动 tick。',
    '你可以先什么都不做，也可以给用户留一条消息，也可以只进行内部活动记录。',
    ...buildAgentTickToolLines(item, tools),
    '最终必须只输出 JSON，不要 Markdown，不要额外解释：',
    '{"action":"noop","reason":"..."}',
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
  if (action === 'user_message' && typeof decision.message === 'string' && decision.message.trim()) {
    return {
      action,
      message: decision.message.trim(),
      reason: typeof decision.reason === 'string' ? decision.reason : '',
    };
  }
  if (action === 'agent_activity') {
    return {
      action,
      summary: String(decision.summary || decision.reason || '').trim() || '远程自主活动完成。',
      messagesToAppend: Array.isArray(decision.messagesToAppend) ? decision.messagesToAppend : [],
      reason: typeof decision.reason === 'string' ? decision.reason : '',
    };
  }
  return {
    action: 'noop',
    reason: typeof decision?.reason === 'string' ? decision.reason : '',
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
    item.status = 'disabled';
    item.disabledReason = 'quiet-hours';
    item.nextKeepaliveAt = null;
    item.updatedAt = now();
    addLog('keepalive-skipped', {
      conversationId,
      reason: 'quiet-hours',
      plannedAt,
      snapshotHash: item.snapshotHash,
      preview: item.preview,
      message: 'quiet-hours',
    });
    await saveState();
    clearConversationTimer(conversationId);
    return;
  }

  try {
    let usedMaxTokens = 0;
    const agentToolDefinitions = getAgentToolDefinitions(item.agentTools);
    // agentTick.enabled 显式控制是否执行自主 tick；旧快照无该字段时退回"有工具才 tick"
    const tickEnabled = item.agentTick ? item.agentTick.enabled === true : agentToolDefinitions.length > 0;
    if (tickEnabled) {
      const { decision, toolTranscript } = await runAgentTick(conversationId, item, plannedAt);
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
        // 推送失败不能中断保活周期
        try {
          const pushResult = await sendFcmUserMessagePush(item, decision.message);
          addLog(pushResult.sent ? 'fcm-push-ok' : 'fcm-push-skipped', {
            conversationId,
            reason: pushResult.reason,
            message: pushResult.sent ? 'push sent' : `skipped: ${pushResult.reason}`,
          });
        } catch (error) {
          addLog('fcm-push-error', {
            conversationId,
            error: error.message || String(error),
            message: error.message || String(error),
          });
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
    item.nextKeepaliveAt = item.lastTouchedAt + KEEPALIVE_INTERVAL_MS;
    item.lastError = null;
    item.updatedAt = item.lastTouchedAt;
    addLog('keepalive-ok', {
      conversationId,
      snapshotHash: item.snapshotHash,
      maxTokens: usedMaxTokens,
      touchedAt: item.lastTouchedAt,
      nextKeepaliveAt: item.nextKeepaliveAt,
      preview: item.preview,
      message: `next ${new Date(item.nextKeepaliveAt).toISOString()}`,
    });
    scheduleConversation(conversationId);
    await saveState();
  } catch (error) {
    item.lastError = error.message || String(error);
    item.lastFailedAt = now();
    item.nextKeepaliveAt = Math.min(now() + 5 * 60 * 1000, plannedAt + 10 * 60 * 1000);
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
  const fcmToken = typeof push.fcmToken === 'string' ? push.fcmToken.trim() : '';
  if (!fcmToken) return undefined;
  return { fcmToken };
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
  const nextKeepaliveAt = touchedAt + KEEPALIVE_INTERVAL_MS;
  const hash = snapshotHash(input.request);
  const preview = buildSnapshotPreview(input.request);
  const existing = state.conversations[input.conversationId] || {};

  if (isInQuietHours(nextKeepaliveAt, input.quietHours)) {
    clearConversationTimer(input.conversationId);
    state.conversations[input.conversationId] = {
      conversationId: input.conversationId,
      snapshotHash: hash,
      request: input.request,
      quietHours: input.quietHours,
      agentTools: input.agentTools,
      agentTick: input.agentTick,
      push: input.push || existing.push,
      preview,
      status: 'disabled',
      disabledReason: 'quiet-hours',
      lastTouchedAt: touchedAt,
      nextKeepaliveAt: null,
      updatedAt: touchedAt,
      pendingMessages: existing.pendingMessages || [],
      activityLog: existing.activityLog || [],
    };
    addLog('snapshot-disabled', {
      conversationId: input.conversationId,
      snapshotHash: hash,
      reason: 'quiet-hours',
      preview,
      message: 'quiet-hours',
    });
    await saveState();
    jsonResponse(res, 200, { ok: true, status: 'disabled', reason: 'quiet-hours' });
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
    lastTouchedAt: touchedAt,
    nextKeepaliveAt,
    updatedAt: touchedAt,
    lastError: null,
    pendingMessages: existing.pendingMessages || [],
    activityLog: existing.activityLog || [],
  };
  addLog('snapshot-updated', {
    conversationId: input.conversationId,
    snapshotHash: hash,
    nextKeepaliveAt,
    preview,
    message: `next ${new Date(nextKeepaliveAt).toISOString()}`,
  });
  scheduleConversation(input.conversationId);
  await saveState();
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
  addLog('keepalive-disabled', {
    conversationId,
    reason: 'client-disable',
    snapshotHash: existing.snapshotHash,
    preview: existing.preview,
    message: 'client-disable',
  });
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
    preview: item.preview,
    agentToolsEnabled: getAgentToolDefinitions(item.agentTools).map((tool) => tool.function.name),
    agentTickEnabled: item.agentTick ? item.agentTick.enabled === true : getAgentToolDefinitions(item.agentTools).length > 0,
    pushConfigured: Boolean(item.push?.fcmToken),
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
    jsonResponse(res, 400, { ok: false, error: 'fcmToken is required' });
    return;
  }
  // 单用户服务器：token 轮换时更新所有会话
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
    if (req.method === 'POST' && url.pathname === '/v1/keepalive/push-token') {
      await handlePushToken(req, res);
      return;
    }
    jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    jsonResponse(res, error.statusCode || 400, { ok: false, error: error.message || String(error) });
  }
}

await loadState();
await loadFcmServiceAccount();
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
