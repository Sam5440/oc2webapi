/**
 * oc2webapi — 界面渲染与交互。
 *
 * 职责：会话列表、消息流（含流式增量渲染）、模型选择、设置弹窗、主题、
 * 导出菜单、横幅提示。数据操作通过 store / export / chat（由 main 注入）完成。
 */

import { renderMarkdown, enhanceMarkdownDOM } from './markdown.js';
import { exportSession } from './export.js';
import { groupModels } from './models.js';
import { DEFAULT_INSTRUCTIONS } from './store.js';

const $ = (id) => document.getElementById(id);

const els = {
  sidebar: $('sidebar'), sidebarMask: $('sidebar-mask'),
  sessionList: $('session-list'),
  chatScroll: $('chat-scroll'), messages: $('messages'), emptyState: $('empty-state'),
  input: $('input'), btnSend: $('btn-send'), btnStop: $('btn-stop'), composerHint: $('composer-hint'),
  modelPickerLabel: $('model-picker-label'), modelPopover: $('model-popover'),
  modelSearch: $('model-search'), modelList: $('model-list'),
  transportBadge: $('transport-badge'),
  banner: $('banner'),
  settingsModal: $('settings-modal'),
  exportMenu: $('export-menu'),
};

export class UI {
  #mediaBound = false;

  constructor({ store, engine, onNewChat, onDeleteSession, onSend, onStop, onRegenerate, onModelChange }) {
    this.store = store;
    this.engine = engine;
    this.handlers = { onNewChat, onDeleteSession, onSend, onStop, onRegenerate, onModelChange };
    this.models = [];
    this.input = els.input;
    this.streamingMessageId = null;
    this.streamDirty = false;
    this.rafPending = false;
    this.streamNode = null;
    this.streamMd = null;
    this.#bindStatic();
    this.#applyTheme(store.getSettings().theme);
  }

  /* ================= 静态事件绑定 ================= */

  #bindStatic() {
    $('btn-new-chat').addEventListener('click', () => this.handlers.onNewChat());
    $('btn-open-sidebar').addEventListener('click', () => this.openSidebar(true));
    $('btn-close-sidebar').addEventListener('click', () => this.openSidebar(false));
    $('sidebar-mask').addEventListener('click', () => this.openSidebar(false));

    $('btn-send').addEventListener('click', () => this.handlers.onSend());
    $('btn-stop').addEventListener('click', () => this.handlers.onStop());
    $('btn-regen-confirm')?.addEventListener('click', () => this.handlers.onRegenerate());

    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.handlers.onSend();
      }
    });
    els.input.addEventListener('input', () => this.#autoResize());
    this.#autoResize();

    // 模型选择
    $('btn-model-picker').addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = els.modelPopover.hidden;
      this.closePopovers();
      if (hidden) { els.modelPopover.hidden = false; els.modelSearch.focus(); }
    });
    els.modelSearch.addEventListener('input', () => this.renderModelList(els.modelSearch.value));
    els.modelPopover.addEventListener('click', (e) => e.stopPropagation());
    els.modelList.addEventListener('click', (e) => {
      const option = e.target.closest('[data-model-id]');
      if (!option) return;
      els.modelPopover.hidden = true;
      this.handlers.onModelChange(option.dataset.modelId);
    });

    // 导出菜单
    $('btn-export').addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = els.exportMenu.hidden;
      this.closePopovers();
      els.exportMenu.hidden = !hidden;
    });
    els.exportMenu.addEventListener('click', (e) => {
      const button = e.target.closest('[data-format]');
      if (!button) return;
      els.exportMenu.hidden = true;
      const session = this.store.getActive();
      if (session) exportSession(session, button.dataset.format);
    });
    document.addEventListener('click', () => this.closePopovers());

    // 设置弹窗
    $('btn-settings').addEventListener('click', () => this.openSettings(true));
    $('btn-close-settings').addEventListener('click', () => this.openSettings(false));
    els.settingsModal.addEventListener('click', (e) => {
      if (e.target === els.settingsModal) this.openSettings(false);
    });
    $('btn-theme').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const current = this.store.getSettings().theme || 'auto';
      const next = order[(order.indexOf(current) + 1) % order.length];
      this.store.saveSettings({ theme: next });
      this.#applyTheme(next);
    });

    // 设置项
    const relayInput = $('relay-base');
    relayInput.addEventListener('change', () => this.store.saveSettings({ relayBase: relayInput.value.trim() }));
    const keyInput = $('api-key');
    keyInput.addEventListener('change', () => this.store.saveSettings({ apiKey: keyInput.value.trim() }));
    const instructions = $('custom-instructions');
    instructions.addEventListener('change', () => this.store.saveSettings({ customInstructions: instructions.value }));
    $('btn-reset-instructions').addEventListener('click', () => {
      instructions.value = DEFAULT_INSTRUCTIONS;
      this.store.saveSettings({ customInstructions: DEFAULT_INSTRUCTIONS });
    });
    document.querySelectorAll('#transport-mode button').forEach((button) => {
      button.addEventListener('click', () => {
        this.store.saveSettings({ transportMode: button.dataset.value });
        this.renderSettings();
        this.renderTransportBadge();
      });
    });

    // 数据管理
    $('btn-export-data').addEventListener('click', () => this.#exportAllData());
    $('btn-import-data').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', (e) => this.#importData(e));
    $('btn-clear-all').addEventListener('click', () => {
      if (confirm('确定删除本地全部对话？此操作不可恢复。')) {
        this.store.clearAll();
        this.handlers.onNewChat();
      }
    });

    // 建议问题
    $('suggest-grid').addEventListener('click', (e) => {
      const button = e.target.closest('[data-prompt]');
      if (!button) return;
      els.input.value = button.dataset.prompt;
      this.#autoResize();
      this.handlers.onSend();
    });
  }

  closePopovers() {
    els.modelPopover.hidden = true;
    els.exportMenu.hidden = true;
  }

  openSidebar(open) {
    els.sidebar.classList.toggle('open', open);
    els.sidebarMask.hidden = !open;
  }

  /* ================= 主题 ================= */

  #applyTheme(theme) {
    const resolve = () => (theme === 'auto'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme);
    const apply = () => document.documentElement.dataset.theme = resolve();
    apply();
    if (!this.#mediaBound) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((this.store.getSettings().theme || 'auto') === 'auto') apply();
      });
      this.#mediaBound = true;
    }
  }

  /* ================= 会话列表 ================= */

  renderSessions() {
    const sessions = this.store.orderedSessions();
    els.sessionList.textContent = '';
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.id === this.store.activeId ? ' active' : '');
      item.setAttribute('role', 'option');

      const pin = document.createElement('span');
      pin.className = 'session-pin';
      pin.textContent = session.pinned ? '📌' : '';

      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = session.title || '新对话';

      const actions = document.createElement('span');
      actions.className = 'session-actions';
      actions.append(
        this.#sessionAction('_pin', session.pinned ? '📍' : '📌', '置顶/取消置顶', () => {
          this.store.update(session.id, { pinned: !session.pinned });
        }),
        this.#sessionAction('rename', '✏️', '重命名', () => this.#startRename(session, item)),
        this.#sessionAction('delete', '🗑', '删除会话', () => {
          if (confirm(`删除「${session.title || '新对话'}」？`)) this.handlers.onDeleteSession(session.id);
        }),
      );

      item.append(pin, title, actions);
      item.addEventListener('click', (e) => {
        if (e.target.closest('.session-actions')) return;
        this.store.setActive(session.id);
        this.openSidebar(false);
      });
      els.sessionList.appendChild(item);
    }
    if (!sessions.length) {
      const tip = document.createElement('p');
      tip.style.cssText = 'color:var(--fg-faint);font-size:12.5px;text-align:center;padding:16px 8px;';
      tip.textContent = '还没有对话，点上方「新对话」开始';
      els.sessionList.appendChild(tip);
    }
  }

  #sessionAction(key, label, title, onClick) {
    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.dataset.act = key;
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return button;
  }

  #startRename(session, item) {
    const titleEl = item.querySelector('.session-title');
    const input = document.createElement('input');
    input.className = 'session-title-input';
    input.value = session.title || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const value = input.value.trim();
      this.store.update(session.id, { title: value || session.title || '新对话' });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = session.title || ''; commit(); }
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  /* ================= 消息流 ================= */

  renderMessages(session) {
    this.streamingMessageId = null;
    els.messages.textContent = '';
    const has = session && session.messages.some((m) => m.role !== 'tool');
    els.emptyState.hidden = !!has;
    if (!session) return;
    for (const message of session.messages) {
      if (message.role === 'tool') continue;
      els.messages.appendChild(this.#buildMessageNode(session, message));
    }
    this.scrollToBottom(true);
    this.renderComposerState();
  }

  #buildMessageNode(session, message) {
    const node = document.createElement('div');
    node.className = 'message ' + (message.role === 'user' ? 'user' : 'assistant');
    node.dataset.mid = message.id;

    const head = document.createElement('div');
    head.className = 'm-head';
    const avatar = document.createElement('span');
    avatar.className = 'm-avatar';
    avatar.textContent = message.role === 'user' ? '你' : 'AI';
    head.appendChild(avatar);
    if (message.role === 'assistant' && message.model) {
      const model = document.createElement('span');
      model.className = 'm-model';
      model.textContent = message.model;
      head.appendChild(model);
    }
    const time = document.createElement('span');
    time.textContent = this.#time(message.ts);
    head.appendChild(time);

    const actions = document.createElement('span');
    actions.className = 'm-actions';
    actions.appendChild(this.#messageAction('复制', async () => {
      await navigator.clipboard.writeText(message.content || '');
    }));
    if (message.role === 'assistant' && session) {
      const isLast = session.messages.filter((m) => m.role !== 'tool').slice(-1)[0]?.id === message.id;
      if (isLast) {
        actions.appendChild(this.#messageAction('重新生成', () => this.handlers.onRegenerate()));
      }
    }
    head.appendChild(actions);
    node.appendChild(head);

    if (message.reasoning) node.appendChild(this.#reasoningNode(message.reasoning));
    if (message.toolNotes && message.toolNotes.length) {
      node.appendChild(this.#toolNotesNode(message.toolNotes));
    }

    const body = document.createElement('div');
    body.className = 'm-body';
    const md = document.createElement('div');
    md.className = 'md';
    if (message.role === 'user') {
      md.textContent = message.content || '';
    } else {
      md.innerHTML = renderMarkdown(message.content || '');
      enhanceMarkdownDOM(md);
    }
    body.appendChild(md);
    node.appendChild(body);

    if (message.role === 'assistant') {
      if (message.error) node.appendChild(this.#errorNode(message.error));
      const foot = document.createElement('div');
      foot.className = 'm-foot';
      const bits = [];
      if (message.usage) bits.push(`↑ ${message.usage.input} tokens · ↓ ${message.usage.output} tokens`);
      if (message.upstreamSession) bits.push('会话 ' + message.upstreamSession.slice(0, 11) + '…');
      foot.textContent = bits.join('　');
      node.appendChild(foot);
    }
    return node;
  }

  #messageAction(label, onClick) {
    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.textContent = label;
    button.addEventListener('click', () => onClick());
    return button;
  }

  #reasoningNode(text) {
    const details = document.createElement('details');
    details.className = 'reasoning';
    const summary = document.createElement('summary');
    summary.textContent = '💭 思考过程';
    const body = document.createElement('div');
    body.className = 'reasoning-body';
    body.textContent = text;
    details.append(summary, body);
    return details;
  }

  #toolNotesNode(notes) {
    const wrap = document.createElement('div');
    for (const note of notes) {
      const span = document.createElement('span');
      span.className = 'tool-note';
      span.textContent = '🛠 ' + note + '（网页端不执行工具）';
      wrap.appendChild(span);
    }
    return wrap;
  }

  #errorNode(error) {
    const card = document.createElement('div');
    card.className = 'error-card';
    const title = document.createElement('div');
    title.className = 'err-title';
    title.textContent = '生成失败（' + (error.kind || 'error') + '）';
    card.appendChild(title);
    const p = document.createElement('p');
    p.textContent = error.message || '未知错误';
    card.appendChild(p);
    if (error.limited) {
      const p2 = document.createElement('p');
      p2.innerHTML = '免费额度按出口 IP 记账：当前网络的免费配额可能已用完。可尝试等待额度恢复、切换网络，'
        + '在设置中填入自己的 OpenCode Key，或参考 README 自建中转换出口。';
      card.appendChild(p2);
    }
    return card;
  }

  /* 流式更新：先改数据，rAF 批量重渲染当前消息节点 */

  markStreamStart(message) {
    this.streamingMessageId = message.id;
    els.emptyState.hidden = true;
    this.renderComposerState();
    const session = this.store.getActive();
    if (session) {
      // 流式节点从占位开始
      const node = this.#buildMessageNode(session, message);
      node.dataset.streaming = '1';
      els.messages.appendChild(node);
      this.#ensureStreamRefs(message.id);
      this.scrollToBottom(true);
    }
  }

  #ensureStreamRefs(messageId) {
    if (this.streamNode && this.streamNode.dataset.mid === messageId) return;
    this.streamNode = els.messages.querySelector(`[data-mid="${messageId}"]`);
    this.streamMd = this.streamNode?.querySelector('.md') || null;
    this.streamReasoning = null;
  }

  markStreamDelta(message) {
    this.streamDirty = true;
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => this.#flushStream(message));
    }
  }

  #flushStream(message) {
    this.rafPending = false;
    if (!this.streamDirty || this.streamingMessageId !== message.id) { this.streamDirty = false; return; }
    this.streamDirty = false;
    this.#ensureStreamRefs(message.id);
    if (!this.streamNode) return;
    const md = this.streamMd;
    if (md) {
      md.innerHTML = renderMarkdown(message.content || '');
      enhanceMarkdownDOM(md);
      if (message.content) md.classList.add('typing-cursor');
    }
    // 思考过程增量
    if (message.reasoning) {
      let details = this.streamNode.querySelector('.reasoning');
      if (!details) {
        details = this.#reasoningNode(message.reasoning);
        this.streamNode.insertBefore(details, this.streamNode.querySelector('.m-body'));
        details.open = true;
      }
      const body = details.querySelector('.reasoning-body');
      if (body) {
        body.textContent = message.reasoning;
        body.scrollTop = body.scrollHeight;
      }
    }
    // 工具提示增量
    if (message.toolNotes && message.toolNotes.length) {
      const existing = this.streamNode.querySelector('.tool-note-wrap') || (() => {
        const wrap = document.createElement('div');
        wrap.className = 'tool-note-wrap';
        this.streamNode.insertBefore(wrap, this.streamNode.querySelector('.m-body'));
        return wrap;
      })();
      if (existing.childElementCount !== message.toolNotes.length) {
        existing.replaceChildren(...Array.from(this.#toolNotesNode(message.toolNotes).children));
      }
    }
    const nearBottom = this.#isNearBottom();
    if (nearBottom) this.scrollToBottom();
  }

  markStreamEnd(message) {
    if (!this.streamDirty) { /* no pending */ }
    this.#flushStream(message);
    this.streamingMessageId = null;
    this.streamNode = null;
    const session = this.store.getActive();
    // 整体重渲染一次以获得最终状态（错误卡、用量、操作按钮）
    if (session) this.renderMessages(session);
    this.renderComposerState();
  }

  /* ================= 输入区 ================= */

  #autoResize() {
    const input = els.input;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  renderComposerState() {
    const busy = this.engine.busy;
    els.btnSend.hidden = busy;
    els.btnStop.hidden = !busy;
  }

  clearInput() {
    els.input.value = '';
    this.#autoResize();
    els.input.focus();
  }

  focusInput() {
    els.input.focus();
  }

  #isNearBottom() {
    const el = els.chatScroll;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  scrollToBottom(instant = false) {
    const el = els.chatScroll;
    if (instant) el.scrollTop = el.scrollHeight;
    else el.scrollTo({ top: el.scrollHeight });
  }

  /* ================= 模型选择 ================= */

  setModels(list) {
    this.models = list || [];
    this.renderModelList(els.modelSearch.value);
  }

  renderModelList(filter = '') {
    const list = els.modelList;
    list.textContent = '';
    const keyword = filter.trim().toLowerCase();
    const filtered = keyword
      ? this.models.filter((m) => (m.id + ' ' + (m.name || '')).toLowerCase().includes(keyword))
      : this.models;
    const { free, others } = groupModels(filtered);
    const active = this.store.getActive();
    const currentModel = active ? active.model : this.store.getSettings().currentModel;

    const addGroup = (title, models) => {
      if (!models.length) return;
      const head = document.createElement('div');
      head.className = 'model-group-title';
      head.textContent = title;
      list.appendChild(head);
      for (const model of models) {
        const button = document.createElement('button');
        button.className = 'model-option' + (model.id === currentModel ? ' selected' : '');
        button.dataset.modelId = model.id;
        const main = document.createElement('div');
        main.style.minWidth = '0';
        const name = document.createElement('div');
        name.className = 'm-name';
        name.textContent = model.name || model.id;
        const id = document.createElement('div');
        id.className = 'm-id';
        id.textContent = model.id;
        main.append(name, id);
        const meta = document.createElement('div');
        meta.className = 'm-meta';
        if (String(model.id).toLowerCase().includes('free') || isFreeZero(model)) {
          const badge = document.createElement('span');
          badge.className = 'badge free';
          badge.textContent = '免费';
          meta.appendChild(badge);
        }
        const caps = model.capabilities || {};
        if (caps.reasoning && caps.reasoning.supported) {
          const badge = document.createElement('span');
          badge.className = 'badge reason';
          badge.textContent = '推理';
          meta.appendChild(badge);
        }
        if (model.limit && model.limit.context) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = Math.round(model.limit.context / 1000) + 'K';
          meta.appendChild(badge);
        }
        button.append(main, meta);
        list.appendChild(button);
      }
    };
    addGroup('免费模型', free);
    addGroup('其他模型（需 Key）', others);
    if (!filtered.length) {
      const tip = document.createElement('p');
      tip.style.cssText = 'color:var(--fg-faint);font-size:13px;text-align:center;padding:14px;';
      tip.textContent = '没有匹配的模型';
      list.appendChild(tip);
    }
  }

  renderModelLabel() {
    const active = this.store.getActive();
    const modelId = active ? active.model : '';
    const record = this.models.find((m) => m.id === modelId);
    els.modelPickerLabel.textContent = record ? (record.name || modelId) : (modelId || '选择模型');
  }

  renderTransportBadge() {
    const mode = this.store.getSettings().transportMode || 'auto';
    const names = { auto: '自动', direct: '直连', relay: '中转' };
    els.transportBadge.textContent = '通道：' + (names[mode] || mode);
    els.transportBadge.title = mode === 'auto'
      ? '自动：优先浏览器直连（用户 IP），CORS 失败自动回退中转'
      : mode === 'direct'
        ? '仅直连：请求始终从浏览器发出（需要 CORS 放行环境）'
        : '仅中转：请求经中转函数转发到 OpenCode';
  }

  /* ================= 设置 ================= */

  openSettings(open) {
    els.settingsModal.hidden = !open;
    if (open) this.renderSettings();
  }

  renderSettings() {
    const settings = this.store.getSettings();
    $('relay-base').value = settings.relayBase || '';
    $('api-key').value = settings.apiKey || '';
    $('custom-instructions').value = settings.customInstructions || '';
    document.querySelectorAll('#transport-mode button').forEach((button) => {
      button.classList.toggle('on', button.dataset.value === (settings.transportMode || 'auto'));
    });
  }

  /* ================= 横幅 ================= */

  showBanner(html, { dismissible = true } = {}) {
    els.banner.hidden = false;
    els.banner.innerHTML = '';
    const span = document.createElement('span');
    span.innerHTML = html;
    els.banner.appendChild(span);
    if (dismissible) {
      const button = document.createElement('button');
      button.textContent = '知道了';
      button.addEventListener('click', () => { els.banner.hidden = true; });
      els.banner.appendChild(button);
    }
  }

  hideBanner() {
    els.banner.hidden = true;
  }

  /* ================= 数据导入导出 ================= */

  #exportAllData() {
    const payload = { app: 'oc2webapi', version: 1, exportedAt: new Date().toISOString(), sessions: this.store.sessions };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oc2webapi-sessions-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
  }

  async #importData(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const sessions = Array.isArray(payload) ? payload : payload.sessions;
      if (!Array.isArray(sessions)) throw new Error('格式不正确');
      let imported = 0;
      for (const session of sessions) {
        if (!session || typeof session !== 'object' || !Array.isArray(session.messages)) continue;
        if (this.store.get(session.id)) continue;
        this.store.sessions.push({
          pinned: false, upstreamSession: null, model: '', title: '新对话',
          createdAt: Date.now(), updatedAt: Date.now(),
          ...session,
        });
        imported++;
      }
      this.store.state.activeId = this.store.sessions[this.store.sessions.length - 1]?.id || '';
      this.store.persist();
      this.renderSessions();
      this.renderMessages(this.store.getActive());
      alert(`已导入 ${imported} 个会话`);
    } catch (err) {
      alert('导入失败：' + err.message);
    }
  }

  #time(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

function isFreeZero(model) {
  const cost = model.cost && model.cost.text;
  if (!cost) return false;
  return (cost.input && cost.input.price) === 0 && (cost.output && cost.output.price) === 0;
}
