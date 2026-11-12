/**
 * oc2webapi — OpenCode 免费通道浏览器端协议客户端。
 *
 * 该模块按 OpenCode CLI 2.x 的线上请求形状构造 /inference 调用：
 *   - 会话与项目身份（ses_ 降序时间戳 ID、每请求全新 40 位 hex 项目 ID）
 *   - 官方 CLI system prompt + <env> 块 + 内置技能清单（免费档强制校验）
 *   - 官方 13 工具集追加（免费档拒绝非 agent 形状的请求）
 *   - v2 客户端的 JSON 键序、stream/stream_options/max_completion_tokens 约定
 *   - 上游 SSE 流解析（文本/思考/工具调用/用量/错误）
 *
 * 协议细节逆向自 opencode2api（GPL-3.0）项目，资源文件 prompt-v2.txt 与
 * tools-v2.json 为官方 CLI 捕获原文。
 */

const PROMPT_MARKER = 'You are opencode, an interactive CLI tool';

/** v2 客户端 JSON.stringify 的键序；其余键按字典序跟在后面。 */
const V2_CHAT_KEY_ORDER = ['model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens'];

/** 2.x 客户端固定携带的补全上限。 */
const V2_COMPLETION_LIMIT = 32000;

/** 官方工具集的键序（tools-v2.json 的原始顺序）。 */
const V2_TOOL_ORDER = ['edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell', 'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch'];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 会话内为每个"用户轮次"钉住的 msg_ ID（官方客户端行为）。 */
let lastMessageId = null;

/* ------------------------------------------------------------------ */
/* 身份                                                                */
/* ------------------------------------------------------------------ */

function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function randomBase62(len) {
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += BASE62[buf[i] % 62];
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 铸造官方 Identifier.descending() 布局的会话 ID：
 * "ses_" + 12 位 hex（48 位 ~(ms<<12|counter)）+ 14 位 Base62。
 * 免费档校验该形状与降序时间部分（低 12 位以 f[c-f][0-9a-f] 收尾），
 * 并从时间戳推导风险窗口，因此必须使用真实当前时间。
 */
export function mintSessionId(now = Date.now()) {
  const value = (BigInt(now) << 12n) | 1n;
  const inverted = ~value & 0xFFFFFFFFFFFFn;
  const timePart = inverted.toString(16).padStart(12, '0');
  return 'ses_' + timePart + randomBase62(14);
}

/** 项目 ID：官方 CLI 发送 git 根提交的 40 位 hex；免费档按 (项目 ID, 出口) 记账配额，每请求全新一枚。 */
export function mintProjectId() {
  return toHex(randomBytes(20));
}

/** 用户消息 ID："msg_" + 12 位升序 hex + 14 位 Base62，同一轮次保持不变。 */
export function mintMessageId(now = Date.now()) {
  const value = (BigInt(now) << 12n) | 1n;
  if (lastMessageId && lastMessageId.value === value) return lastMessageId.id;
  const id = 'msg_' + value.toString(16).padStart(12, '0') + randomBase62(14);
  lastMessageId = { value, id };
  return id;
}

/* ------------------------------------------------------------------ */
/* 请求形状                                                            */
/* ------------------------------------------------------------------ */

let promptText = null;
let toolsText = null;

async function loadAssets() {
  if (promptText && toolsText) return;
  const [p, t] = await Promise.all([
    fetch(new URL('../oc2/prompt-v2.txt', import.meta.url)).then((r) => {
      if (!r.ok) throw new Error('prompt 资源加载失败: ' + r.status);
      return r.text();
    }),
    fetch(new URL('../oc2/tools-v2.json', import.meta.url)).then((r) => {
      if (!r.ok) throw new Error('工具集资源加载失败: ' + r.status);
      return r.json();
    }),
  ]);
  promptText = p;
  toolsText = t;
}

function platformName() {
  const ua = navigator.userAgent || '';
  if (/Win/i.test(ua)) return 'win32';
  if (/Mac/i.test(ua)) return 'darwin';
  if (/Android/i.test(ua)) return 'android';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'unknown';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDateLine(now = new Date()) {
  const d = `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, '0')} ${now.getUTCFullYear()}`;
  return d;
}

/** 官方 CLI 的 <env> 块 + 内置技能清单。 */
export function environmentBlock(model, now = new Date()) {
  const apiModel = String(model || '').replace(/^opencode\//, '').trim() || 'unknown';
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    'Here is some useful information about the environment you are running in:',
    '<env>',
    '  Working directory: /workspace',
    '  Workspace root folder: /workspace',
    '  Is directory a git repo: yes',
    `  Platform: ${platformName()}`,
    `  Today's date: ${utcDateLine(now)}`,
    '</env>',
  ].join('\n');
}

/**
 * 组装完整 system prompt：官方原文 + env + 技能清单；用户自定义指令
 * 以空行接在官方内容之后（与 opencode2api 的注入策略一致）。
 * 免费档要求 system 中携带官方标记，因此用户指令只能追加、不能替换。
 */
export async function buildSystemPrompt(model, userInstructions) {
  await loadAssets();
  const official = promptText + environmentBlock(model) + '\n' + SKILLS_BLOCK;
  const extra = (userInstructions || '').trim();
  return extra ? official + '\n\n' + extra : official;
}

/* 与 CLI 一致的静态技能清单。 */
const SKILLS_BLOCK = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

/** 把官方工具集渲染为 Chat 线形状（2.x 客户端对每个工具标记 strict:false）。 */
export async function officialToolset() {
  await loadAssets();
  return V2_TOOL_ORDER.map((name) => {
    const def = toolsText[name] || {};
    return {
      type: 'function',
      function: {
        name,
        description: def.description || 'Agent tool ' + name,
        parameters: def.parameters || { type: 'object', properties: {} },
        strict: false,
      },
    };
  });
}

/**
 * 按 v2 客户端键序编码请求体。核心键在前（model, messages, tools, stream,
 * stream_options, max_completion_tokens），其余键字典序跟随。
 */
export function encodeChatBody(payload) {
  const out = {};
  const rest = [];
  for (const key of V2_CHAT_KEY_ORDER) {
    if (key in payload) out[key] = payload[key];
  }
  for (const key of Object.keys(payload)) {
    if (!(key in out)) rest.push(key);
  }
  rest.sort();
  for (const key of rest) out[key] = payload[key];
  return JSON.stringify(out);
}

/**
 * 构造一次上游推理请求（体 + 头）。conversation 传入会话的 ses_ ID；
 * project 每请求全新铸造。apiKey 为空时使用匿名凭证 "public"（大小写敏感）。
 */
export async function buildRequest({ model, messages, sessionId, userInstructions, apiKey }) {
  await loadAssets();
  const system = await buildSystemPrompt(model, userInstructions);
  const tools = await officialToolset();
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: V2_COMPLETION_LIMIT,
  };
  const projectId = mintProjectId();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (apiKey ? apiKey.trim() : 'public'),
    'x-opencode-client': 'cli',
    'x-session-affinity': sessionId,
    'X-Session-Id': sessionId,
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-opencode-project': projectId,
  };
  return { path: '/chat/completions', body: encodeChatBody(body), headers };
}

/** 由模型档案取其 Chat Completions 端点（含 host 与路径）。 */
export function modelEndpoint(modelRecord) {
  const api = modelRecord && modelRecord.api && modelRecord.api['chat-completions'];
  if (!api || !api.base_url) return null;
  return api.base_url.replace(/\/+$/, '') + '/chat/completions';
}

/** 免费档判定：ID 含 free（不分大小写）或输入/输出价格均为 0。 */
export function isFreeModel(record) {
  if (!record) return false;
  if (/free/i.test(record.id || '')) return true;
  const cost = record.cost && record.cost.text;
  if (!cost) return false;
  const inP = cost.input && cost.input.price;
  const outP = cost.output && cost.output.price;
  return inP === 0 && outP === 0;
}

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析上游 SSE 流，回调与 opencode2api 的 bridge 事件对齐：
 *   { type: 'start', id, model }
 *   { type: 'text', text }
 *   { type: 'reasoning', text }
 *   { type: 'tool', call: { id, name, arguments } }   // 完整聚合后的调用
 *   { type: 'usage', usage: { input, output } }
 *   { type: 'finish', stop }
 *   { type: 'error', message, kind }
 * 返回聚合结果 { text, reasoning, toolCalls, usage, stop, error }。
 */
export async function consumeSSE(response, onEvent) {
  const result = { text: '', reasoning: '', toolCalls: [], usage: null, stop: null, error: null };
  if (!response.body) {
    throw new Error('上游响应没有可读流');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolsByKey = new Map();
  let started = false;

  const handleChunk = (chunk) => {
    if (chunk === '[DONE]') return 'done';
    let value;
    try {
      value = JSON.parse(chunk);
    } catch {
      return null; // 心跳或注释行，忽略
    }
    // 错误信封：OpenAI 形 {"error":{...}} 与上游形 {"type":"error",...}
    const errObj = value && value.error;
    if (errObj) {
      const message = (typeof errObj === 'string' ? errObj : errObj.message) || '上游流返回错误';
      const kind = (typeof errObj === 'object' && (errObj.type || errObj.code)) || 'upstream_error';
      result.error = { message, kind };
      emit({ type: 'error', message, kind });
      return 'error';
    }
    if (!started && value.id) {
      started = true;
      emit({ type: 'start', id: value.id, model: value.model });
    }
    if (value.usage) {
      result.usage = {
        input: value.usage.prompt_tokens ?? 0,
        output: value.usage.completion_tokens ?? 0,
      };
      emit({ type: 'usage', usage: result.usage });
    }
    for (const choice of value.choices || []) {
      const delta = choice.delta || {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        result.reasoning += reasoning;
        emit({ type: 'reasoning', text: reasoning });
      }
      if (delta.content) {
        result.text += delta.content;
        emit({ type: 'text', text: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const key = String(call.index ?? call.id ?? '');
        const entry = toolsByKey.get(key) || { id: '', name: '', arguments: '' };
        if (call.id) entry.id = call.id;
        if (call.function && call.function.name) {
          entry.name = mergeToolName(entry.name, call.function.name);
        }
        if (call.function && call.function.arguments) entry.arguments += call.function.arguments;
        toolsByKey.set(key, entry);
      }
      if (choice.finish_reason) {
        const stop = String(choice.finish_reason).toLowerCase();
        if (['error', 'network_error', 'server_error'].includes(stop)) {
          const message = (choice.error && choice.error.message) || '上游流异常终止';
          result.error = { message, kind: 'upstream_error' };
          emit({ type: 'error', message, kind: 'upstream_error' });
          return 'error';
        }
        result.stop = choice.finish_reason;
        emit({ type: 'finish', stop: choice.finish_reason });
      }
    }
    return null;
  };

  const emit = (event) => {
    if (onEvent) onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      const signal = handleChunk(payload);
      if (signal === 'done' || signal === 'error') {
        try { await reader.cancel(); } catch { /* 流已结束 */ }
        finalizeTools();
        return result;
      }
    }
  }
  finalizeTools();
  return result;

  function finalizeTools() {
    for (const entry of toolsByKey.values()) {
      result.toolCalls.push(entry);
      emit({ type: 'tool', call: entry });
    }
  }
}

function mergeToolName(current, fragment) {
  if (!current || fragment === current) return fragment;
  if (fragment.startsWith(current)) return fragment;
  return current + fragment;
}

/** 上游 JSON 错误体 → { message, kind, status, limit }。limit 标记免费额度类错误。 */
export async function parseErrorResponse(response) {
  let message = '上游返回 HTTP ' + response.status;
  let kind = 'http_' + response.status;
  let body = '';
  try {
    body = await response.text();
  } catch { /* 忽略读取失败 */ }
  if (body) {
    try {
      const value = JSON.parse(body);
      const err = value.error || value;
      if (typeof err === 'string') message = err;
      else if (err && err.message) {
        message = err.message;
        kind = err.type || err.code || kind;
      }
    } catch {
      message = body.slice(0, 300);
    }
  }
  const limited = /FreeUsageLimit|Free usage limit|FreeTier/i.test(message + ' ' + kind);
  return { message, kind, status: response.status, limited };
}
