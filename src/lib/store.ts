/**
 * oc2webapi — 本地会话存储（框架无关单例 + React 绑定）。
 *
 * 所有对话数据只保存在浏览器 localStorage，服务端（含中转函数）不留存。
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface MessageError {
  message: string;
  kind: string;
  status?: number;
  limited?: boolean;
  via?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolNotes?: string[];
  model?: string;
  ts: number;
  usage?: { input: number; output: number } | null;
  error?: MessageError | null;
  upstreamSession?: string | null;
}

export interface Session {
  id: string;
  upstreamSession: string | null; // 首次请求时铸造 ses_ ID 并固定
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  messages: ChatMessage[];
}

export interface SessionsState {
  version: number;
  activeId: string;
  sessions: Session[];
}

export type StoreEvent =
  | { type: "sessions-changed" }
  | { type: "active-changed" }
  | { type: "settings-changed" }
  | { type: "quota-error" };

export interface AppSettings {
  transportMode: "auto" | "direct" | "relay";
  relayBase: string;
  apiKey: string;
  customInstructions: string;
  theme: "auto" | "light" | "dark";
  currentModel: string;
}

/** 默认自定义指令：覆盖官方 CLI 提示词中"极简命令行风格"的要求，
 *  让网页聊天保持正常助手的表达。官方 prompt 本体仍完整保留（免费档强制）。 */
export const DEFAULT_INSTRUCTIONS = [
  "你现在运行在一个网页聊天界面（oc2webapi），而不是终端 CLI。",
  '上一段 CLI 提示词中关于"简洁、少行数、命令行风格"的要求不适用于本场景：',
  "请以乐于助人的通用 AI 助手身份回答，用与用户相同的语言，",
  "根据问题需要给出充分、结构清晰的 Markdown 回答；代码块标注语言。",
  "除非用户明确要求，不要主动调用工具，直接用文字回答即可。",
].join("\n");

export function defaultSettings(): AppSettings {
  return {
    transportMode: "auto",
    relayBase: "",
    apiKey: "",
    customInstructions: DEFAULT_INSTRUCTIONS,
    theme: "auto",
    currentModel: "",
  };
}

const SESSIONS_KEY = "oc2webapi.sessions.v1";
const SETTINGS_KEY = "oc2webapi.settings.v1";
const MODELS_KEY = "oc2webapi.models.v1";
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    const value = JSON.parse(raw ?? "");
    return (value ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  private state: SessionsState;
  private listeners = new Set<() => void>();

  constructor() {
    this.state = safeParse<SessionsState>(localStorage.getItem(SESSIONS_KEY), { version: 1, activeId: "", sessions: [] });
    if (!Array.isArray(this.state.sessions)) this.state.sessions = [];
  }

  /* React 绑定：getSnapshot 必须返回稳定引用，emit 时先替换 state 引用 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionsState => this.state;

  private emit(): void {
    this.state = { ...this.state };
    for (const listener of this.listeners) listener();
  }

  persist(): void {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.error("会话保存失败（可能超出存储配额）", err);
      window.dispatchEvent(new CustomEvent("oc2webapi:quota-error"));
    }
  }

  /* ---------------- 会话 ---------------- */

  get sessions(): Session[] {
    return this.state.sessions;
  }

  get activeId(): string {
    return this.state.activeId;
  }

  orderedSessions(): Session[] {
    return [...this.state.sessions].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  createSession(opts: { model?: string } = {}): Session {
    const session: Session = {
      id: "local_" + crypto.randomUUID(),
      upstreamSession: null,
      title: "新对话",
      model: opts.model || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      messages: [],
    };
    this.state.sessions = [session, ...this.state.sessions];
    this.state.activeId = session.id;
    this.persist();
    this.emit();
    return session;
  }

  get(id: string): Session | null {
    return this.state.sessions.find((s) => s.id === id) ?? null;
  }

  getActive(): Session | null {
    return this.get(this.state.activeId);
  }

  setActive(id: string): void {
    if (this.get(id)) {
      this.state.activeId = id;
      this.persist();
      this.emit();
    }
  }

  update(id: string, patch: Partial<Session>): void {
    const session = this.get(id);
    if (!session) return;
    Object.assign(session, patch, { updatedAt: Date.now() });
    this.persist();
    this.emit();
  }

  remove(id: string): void {
    const index = this.state.sessions.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    if (this.state.activeId === id) {
      this.state.activeId = this.state.sessions[0]?.id ?? "";
    }
    this.persist();
    this.emit();
  }

  clearAll(): void {
    this.state = { version: 1, activeId: "", sessions: [] };
    this.persist();
    this.emit();
  }

  /** 导入会话：跳过已存在 ID，返回导入数量并把活跃会话指向最后一个新会话。 */
  importSessions(sessions: Session[]): number {
    let imported = 0;
    let lastId = "";
    for (const session of sessions) {
      if (!session || typeof session !== "object" || !Array.isArray(session.messages)) continue;
      if (this.get(session.id)) continue;
      this.state.sessions.push({
        ...session,
        // 缺省字段兜底：导入文件缺字段时补齐
        pinned: session.pinned ?? false,
        upstreamSession: session.upstreamSession ?? null,
        model: session.model ?? "",
        title: session.title ?? "新对话",
        createdAt: session.createdAt ?? Date.now(),
        updatedAt: session.updatedAt ?? Date.now(),
      });
      lastId = session.id;
      imported++;
    }
    if (lastId) this.state.activeId = lastId;
    this.persist();
    this.emit();
    return imported;
  }

  /* ---------------- 设置 ---------------- */

  getSettings(): AppSettings {
    return { ...defaultSettings(), ...safeParse<Partial<AppSettings>>(localStorage.getItem(SETTINGS_KEY), {}) };
  }

  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const merged = { ...this.getSettings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  }

  /* ---------------- 模型目录缓存 ---------------- */

  getCachedModels(): unknown[] | null {
    const cache = safeParse<{ ts: number; list: unknown[] } | null>(localStorage.getItem(MODELS_KEY), null);
    if (!cache || !Array.isArray(cache.list) || !cache.list.length) return null;
    if (Date.now() - cache.ts > MODELS_TTL_MS) return null;
    return cache.list;
  }

  saveModels(list: unknown[]): void {
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify({ ts: Date.now(), list }));
    } catch {
      /* 模型缓存超配额时可安全丢弃 */
    }
  }
}

export const store = new Store();

/** 配额错误事件 → 应用内弹一次提示（App 级监听）。 */
export function listenQuotaErrors(handler: () => void): () => void {
  window.addEventListener("oc2webapi:quota-error", handler);
  return () => window.removeEventListener("oc2webapi:quota-error", handler);
}
