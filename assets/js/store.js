/**
 * oc2webapi — 本地会话存储。
 *
 * 所有对话数据只保存在浏览器 localStorage，服务端（含中转函数）不留存任何
 * 会话内容。结构：
 *   oc2webapi.sessions.v1 → { version, activeId, sessions: [...] }
 *   oc2webapi.settings.v1 → 设置对象
 *   oc2webapi.models.v1   → 模型目录缓存 { ts, list }
 */

const SESSIONS_KEY = 'oc2webapi.sessions.v1';
const SETTINGS_KEY = 'oc2webapi.settings.v1';
const MODELS_KEY = 'oc2webapi.models.v1';
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认自定义指令：覆盖官方 CLI 提示词中"极简命令行风格"的要求，
 *  让网页聊天保持正常助手的表达。官方 prompt 本体仍完整保留（免费档强制）。 */
export const DEFAULT_INSTRUCTIONS = [
  '你现在运行在一个网页聊天界面（oc2webapi），而不是终端 CLI。',
  '上一段 CLI 提示词中关于"简洁、少行数、命令行风格"的要求不适用于本场景：',
  '请以乐于助人的通用 AI 助手身份回答，用与用户相同的语言，',
  '根据问题需要给出充分、结构清晰的 Markdown 回答；代码块标注语言。',
  '除非用户明确要求，不要主动调用工具，直接用文字回答即可。',
].join('\n');

export function defaultSettings() {
  return {
    transportMode: 'auto',        // auto | direct | relay
    relayBase: '',                // 空 = 同源 /api
    apiKey: '',                   // 选填 Zen/Go Key；空 = 匿名 public
    customInstructions: DEFAULT_INSTRUCTIONS,
    theme: 'auto',                // auto | light | dark
    currentModel: '',
  };
}

function safeParse(raw, fallback) {
  try {
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

class Store {
  constructor() {
    this.state = this.#load();
    this.listeners = new Set();
  }

  #load() {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const state = safeParse(raw, null) || { version: 1, activeId: '', sessions: [] };
    if (!Array.isArray(state.sessions)) state.sessions = [];
    return state;
  }

  #save() {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.error('会话保存失败（可能超出存储配额）', err);
      this.#emit({ type: 'quota-error', error: err });
    }
  }

  #emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /* ---------------- 会话 ---------------- */

  get sessions() {
    return this.state.sessions;
  }

  get activeId() {
    return this.state.activeId;
  }

  orderedSessions() {
    return [...this.state.sessions].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  createSession({ model }) {
    const session = {
      id: 'local_' + crypto.randomUUID(),
      upstreamSession: null, // 首次请求时铸造 ses_ ID 并固定
      title: '新对话',
      model: model || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      messages: [],
    };
    this.state.sessions.unshift(session);
    this.state.activeId = session.id;
    this.#save();
    this.#emit({ type: 'sessions-changed' });
    return session;
  }

  get(id) {
    return this.state.sessions.find((s) => s.id === id) || null;
  }

  getActive() {
    return this.get(this.state.activeId) || null;
  }

  setActive(id) {
    if (this.get(id)) {
      this.state.activeId = id;
      this.#save();
      this.#emit({ type: 'active-changed' });
    }
  }

  update(id, patch) {
    const session = this.get(id);
    if (!session) return;
    Object.assign(session, patch, { updatedAt: Date.now() });
    this.#save();
    this.#emit({ type: 'sessions-changed' });
  }

  remove(id) {
    const index = this.state.sessions.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.state.sessions.splice(index, 1);
    if (this.state.activeId === id) {
      this.state.activeId = this.state.sessions[0]?.id || '';
    }
    this.#save();
    this.#emit({ type: 'sessions-changed' });
  }

  clearAll() {
    this.state = { version: 1, activeId: '', sessions: [] };
    this.#save();
    this.#emit({ type: 'sessions-changed' });
  }

  /** 导入等直接变更 state 后的持久化入口。 */
  persist() {
    this.#save();
    this.#emit({ type: 'sessions-changed' });
  }

  /* ---------------- 设置 ---------------- */

  getSettings() {
    return { ...defaultSettings(), ...safeParse(localStorage.getItem(SETTINGS_KEY), {}) };
  }

  saveSettings(patch) {
    const merged = { ...this.getSettings(), ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    this.#emit({ type: 'settings-changed' });
    return merged;
  }

  /* ---------------- 模型目录缓存 ---------------- */

  getCachedModels() {
    const cache = safeParse(localStorage.getItem(MODELS_KEY), null);
    if (!cache || !Array.isArray(cache.list) || !cache.list.length) return null;
    if (Date.now() - cache.ts > MODELS_TTL_MS) return null;
    return cache.list;
  }

  saveModels(list) {
    try {
      localStorage.setItem(MODELS_KEY, JSON.stringify({ ts: Date.now(), list }));
    } catch { /* 模型缓存超配额时可安全丢弃 */ }
  }
}

export const store = new Store();
