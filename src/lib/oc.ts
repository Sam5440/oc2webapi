/**
 * oc2webapi — OpenCode 免费通道浏览器端协议客户端。
 *
 * 按 OpenCode CLI 2.x 的线上请求形状构造 /inference 调用（协议要点与资源
 * 来源见 README「实现说明」）。UI 层不应直接使用本文件，一律经过 ChatEngine。
 */

import promptV2Raw from "@/assets/oc2/prompt-v2.txt?raw";
import toolsV2Json from "@/assets/oc2/tools-v2.json";

const PROMPT_MARKER = "You are opencode, an interactive CLI tool";

/** v2 客户端 JSON.stringify 的键序；其余键按字典序跟在后面。 */
const V2_CHAT_KEY_ORDER = ["model", "messages", "tools", "stream", "stream_options", "max_completion_tokens"];

/** 2.x 客户端固定携带的补全上限。 */
const V2_COMPLETION_LIMIT = 32000;

/** 官方工具集的键序（tools-v2.json 的原始顺序）。 */
const V2_TOOL_ORDER = ["edit", "execute", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write", "patch"];

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 会话内为每个"用户轮次"钉住的 msg_ ID（官方客户端行为）。 */
let lastMessageId: { value: bigint; id: string } | null = null;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface ModelRecord {
  id: string;
  name?: string;
  type?: string;
  description?: string;
  modalities?: { input?: string[]; output?: string[] };
  capabilities?: { reasoning?: { supported?: boolean }; tools?: { supported?: boolean } };
  limit?: { context?: number; input?: number; output?: number };
  cost?: {
    text?: {
      input?: { price?: number };
      output?: { price?: number };
    };
  };
  api?: { "chat-completions"?: { base_url?: string } };
}

export interface UpstreamMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type StreamEvent =
  | { type: "start"; id: string; model?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; call: ToolCall }
  | { type: "usage"; usage: { input: number; output: number } }
  | { type: "finish"; stop: string }
  | { type: "error"; message: string; kind: string };

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number } | null;
  stop: string | null;
  error: { message: string; kind: string } | null;
}

export interface UpstreamError {
  message: string;
  kind: string;
  status: number;
  limited: boolean;
}

/* ------------------------------------------------------------------ */
/* 身份                                                                */
/* ------------------------------------------------------------------ */

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function randomBase62(len: number): string {
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += BASE62[buf[i] % 62];
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 铸造官方 Identifier.descending() 布局的会话 ID：
 * "ses_" + 12 位 hex（48 位 ~(ms<<12|counter)）+ 14 位 Base62。
 * 免费档校验该形状与降序时间部分，并从时间戳推导风险窗口，
 * 因此必须使用真实当前时间。
 */
export function mintSessionId(now = Date.now()): string {
  const value = (BigInt(now) << 12n) | 1n;
  const inverted = ~value & 0xffffffffffffn;
  const timePart = inverted.toString(16).padStart(12, "0");
  return "ses_" + timePart + randomBase62(14);
}

/** 项目 ID：官方 CLI 发送 git 根提交的 40 位 hex；配额按 (项目 ID, 出口) 记账，每请求全新一枚。 */
export function mintProjectId(): string {
  return toHex(randomBytes(20));
}

/** 用户消息 ID："msg_" + 12 位升序 hex + 14 位 Base62，同一轮次保持不变。 */
export function mintMessageId(now = Date.now()): string {
  const value = (BigInt(now) << 12n) | 1n;
  if (lastMessageId && lastMessageId.value === value) return lastMessageId.id;
  const id = "msg_" + value.toString(16).padStart(12, "0") + randomBase62(14);
  lastMessageId = { value, id };
  return id;
}

/* ------------------------------------------------------------------ */
/* 请求形状                                                            */
/* ------------------------------------------------------------------ */

function platformName(): string {
  const ua = navigator.userAgent || "";
  if (/Win/i.test(ua)) return "win32";
  if (/Mac/i.test(ua)) return "darwin";
  if (/Android/i.test(ua)) return "android";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utcDateLine(now = new Date()): string {
  return `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, "0")} ${now.getUTCFullYear()}`;
}

/** 与 CLI 一致的静态技能清单。 */
const SKILLS_BLOCK = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

/** 官方 CLI 的 <env> 块 + 内置技能清单。 */
export function environmentBlock(model: string, now = new Date()): string {
  const apiModel = String(model || "").replace(/^opencode\//, "").trim() || "unknown";
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    "  Working directory: /workspace",
    "  Workspace root folder: /workspace",
    "  Is directory a git repo: yes",
    `  Platform: ${platformName()}`,
    `  Today's date: ${utcDateLine(now)}`,
    "</env>",
  ].join("\n");
}

/**
 * 组装完整 system prompt：官方原文 + env + 技能清单；用户自定义指令
 * 以空行接在官方内容之后（免费档要求 system 中携带官方标记，只能追加）。
 */
export function buildSystemPrompt(model: string, userInstructions?: string): string {
  const official = promptV2Raw + environmentBlock(model) + "\n" + SKILLS_BLOCK;
  const extra = (userInstructions || "").trim();
  return extra ? official + "\n\n" + extra : official;
}

/** 把官方工具集渲染为 Chat 线形状（2.x 客户端对每个工具标记 strict:false）。 */
export function officialToolset(): Record<string, unknown>[] {
  return V2_TOOL_ORDER.map((name) => {
    const def = (toolsV2Json as Record<string, { description?: string; parameters?: Record<string, unknown> }>)[name] ?? {};
    return {
      type: "function",
      function: {
        name,
        description: def.description || "Agent tool " + name,
        parameters: def.parameters || { type: "object", properties: {} },
        strict: false,
      },
    };
  });
}

/**
 * 按 v2 客户端键序编码请求体。核心键在前，其余键字典序跟随。
 */
export function encodeChatBody(payload: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  const rest: string[] = [];
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

export interface BuiltRequest {
  path: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * 构造一次上游推理请求（体 + 头）。conversation 传入会话的 ses_ ID；
 * project 每请求全新铸造。apiKey 为空时使用匿名凭证 "public"（大小写敏感）。
 */
export function buildRequest(opts: {
  model: string;
  messages: UpstreamMessage[];
  sessionId: string;
  userInstructions?: string;
  apiKey?: string;
}): BuiltRequest {
  const system = buildSystemPrompt(opts.model, opts.userInstructions);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: "system", content: system }, ...opts.messages],
    tools: officialToolset(),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: V2_COMPLETION_LIMIT,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + (opts.apiKey ? opts.apiKey.trim() : "public"),
    "x-opencode-client": "cli",
    "x-session-affinity": opts.sessionId,
    "X-Session-Id": opts.sessionId,
    "x-opencode-session": opts.sessionId,
    "x-opencode-session-id": opts.sessionId,
    "x-opencode-project": mintProjectId(),
  };
  return { path: "/chat/completions", body: encodeChatBody(body), headers };
}

/** 由模型档案取其 Chat Completions 端点（含 host 与路径）。 */
export function modelEndpoint(modelRecord: ModelRecord | undefined): string | null {
  const api = modelRecord?.api?.["chat-completions"];
  if (!api?.base_url) return null;
  return api.base_url.replace(/\/+$/, "") + "/chat/completions";
}

export const DEFAULT_INFERENCE_URL = "https://opencode.ai/inference/openai/v1/chat/completions";

/** 免费档判定：ID 含 free（不分大小写）或输入/输出价格均为 0。 */
export function isFreeModel(record: ModelRecord | undefined | null): boolean {
  if (!record) return false;
  if (/free/i.test(record.id || "")) return true;
  const cost = record.cost?.text;
  if (!cost) return false;
  return cost.input?.price === 0 && cost.output?.price === 0;
}

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

function mergeToolName(current: string, fragment: string): string {
  if (!current || fragment === current) return fragment;
  if (fragment.startsWith(current)) return fragment;
  return current + fragment;
}

/**
 * 解析上游 SSE 流，事件与 opencode2api 的 bridge 事件对齐（见 StreamEvent）。
 * 返回聚合结果；文本/思考/用量通过 onEvent 实时回调。
 */
export async function consumeSSE(response: Response, onEvent?: (event: StreamEvent) => void): Promise<StreamResult> {
  const result: StreamResult = { text: "", reasoning: "", toolCalls: [], usage: null, stop: null, error: null };
  if (!response.body) {
    throw new Error("上游响应没有可读流");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolsByKey = new Map<string, ToolCall>();
  let started = false;
  let stopReading = false;

  const emit = (event: StreamEvent) => {
    if (onEvent) onEvent(event);
  };

  const handleChunk = (chunk: string): "done" | "error" | null => {
    if (chunk === "[DONE]") return "done";
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(chunk);
    } catch {
      return null; // 心跳或注释行，忽略
    }
    const errObj = value.error as unknown;
    if (errObj) {
      const message =
        (typeof errObj === "string" ? errObj : (errObj as { message?: string })?.message) || "上游流返回错误";
      const kind =
        (typeof errObj === "object" && errObj !== null ? ((errObj as { type?: string }).type || (errObj as { code?: string }).code) : null) ||
        "upstream_error";
      result.error = { message, kind };
      emit({ type: "error", message, kind });
      return "error";
    }
    if (!started && typeof value.id === "string" && value.id) {
      started = true;
      emit({ type: "start", id: value.id, model: value.model as string | undefined });
    }
    const usage = value.usage as Record<string, number> | undefined;
    if (usage) {
      result.usage = { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 };
      emit({ type: "usage", usage: result.usage });
    }
    for (const raw of (value.choices as Record<string, unknown>[] | undefined) || []) {
      const choice = raw || {};
      const delta = (choice.delta as Record<string, unknown>) || {};
      const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
      if (reasoning) {
        result.reasoning += reasoning;
        emit({ type: "reasoning", text: reasoning });
      }
      const content = delta.content as string | undefined;
      if (content) {
        result.text += content;
        emit({ type: "text", text: content });
      }
      for (const rawCall of (delta.tool_calls as Record<string, unknown>[] | undefined) || []) {
        const call = rawCall || {};
        const key = String(call.index ?? call.id ?? "");
        const fn = (call.function as { name?: string; arguments?: string }) || {};
        const entry = toolsByKey.get(key) || { id: "", name: "", arguments: "" };
        if (typeof call.id === "string" && call.id) entry.id = call.id;
        if (fn.name) entry.name = mergeToolName(entry.name, fn.name);
        if (fn.arguments) entry.arguments += fn.arguments;
        toolsByKey.set(key, entry);
      }
      const finish = choice.finish_reason as string | undefined;
      if (finish) {
        const stop = finish.toLowerCase();
        if (["error", "network_error", "server_error"].includes(stop)) {
          const message = ((choice.error as { message?: string })?.message) || "上游流异常终止";
          result.error = { message, kind: "upstream_error" };
          emit({ type: "error", message, kind: "upstream_error" });
          return "error";
        }
        result.stop = finish;
        emit({ type: "finish", stop: finish });
      }
    }
    return null;
  };

  while (!stopReading) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      const signal = handleChunk(payload);
      if (signal === "done" || signal === "error") {
        stopReading = true;
        break;
      }
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* 流已结束 */
  }
  for (const entry of toolsByKey.values()) {
    result.toolCalls.push(entry);
    emit({ type: "tool", call: entry });
  }
  return result;
}

/** 上游 JSON 错误体 → 结构化错误。limited 标记免费额度类错误。 */
export async function parseErrorResponse(response: Response): Promise<UpstreamError> {
  let message = "上游返回 HTTP " + response.status;
  let kind = "http_" + response.status;
  let body = "";
  try {
    body = await response.text();
  } catch {
    /* 忽略读取失败 */
  }
  if (body) {
    try {
      const value = JSON.parse(body);
      const err = value.error || value;
      if (typeof err === "string") message = err;
      else if (err?.message) {
        message = err.message;
        kind = err.type || err.code || kind;
      }
    } catch {
      message = body.slice(0, 300);
    }
  }
  const limited = /FreeUsageLimit|Free usage limit|FreeTier/i.test(message + " " + kind);
  return { message, kind, status: response.status, limited };
}
