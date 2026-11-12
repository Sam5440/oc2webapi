/**
 * oc2webapi — 入口：装配 store / engine / ui，驱动首屏。
 */

import { store, DEFAULT_INSTRUCTIONS } from './store.js';
import { ChatEngine } from './chat.js';
import { UI } from './ui.js';
import * as models from './models.js';

const engine = new ChatEngine();

const ui = new UI({
  store,
  engine,
  onNewChat,
  onDeleteSession,
  onSend,
  onStop,
  onRegenerate,
  onModelChange,
});

/* ---------------- 会话操作 ---------------- */

function ensureActiveSession() {
  let session = store.getActive();
  if (!session) {
    session = store.createSession({ model: store.getSettings().currentModel || '' });
    afterSessionSwitch();
  }
  return session;
}

function onNewChat() {
  const session = store.createSession({ model: store.getSettings().currentModel || '' });
  afterSessionSwitch();
  ui.openSidebar(false);
  ui.clearInput();
  return session;
}

function onDeleteSession(id) {
  store.remove(id);
  if (!store.getActive()) ensureActiveSession();
  afterSessionSwitch();
}

function afterSessionSwitch() {
  ui.renderSessions();
  ui.renderMessages(store.getActive());
  ui.renderModelLabel();
  ui.hideBanner();
  const active = store.getActive();
  if (active) store.saveSettings({ currentModel: active.model });
}

/* ---------------- 模型 ---------------- */

async function loadModels() {
  try {
    const list = await models.getModels();
    ui.setModels(list);
    const active = store.getActive();
    if (active && !active.model) {
      const preferred = pickDefaultModel(list);
      store.update(active.id, { model: preferred });
      store.saveSettings({ currentModel: preferred });
    }
    ui.renderModelLabel();
  } catch (err) {
    ui.showBanner(`模型列表获取失败：${escapeText(err.message)}。可在设置中更换通道后重试。`);
  }
}

function pickDefaultModel(list) {
  const free = list.filter((m) => /free/i.test(m.id));
  if (!free.length) return list[0]?.id || '';
  const preferred = free.find((m) => m.id === 'glm-5.3-flash-free')
    || free.find((m) => m.id === 'minimax-m3.1-flash-free')
    || free[0];
  return preferred.id;
}

function onModelChange(modelId) {
  const active = store.getActive();
  if (!active) return;
  store.update(active.id, { model: modelId });
  store.saveSettings({ currentModel: modelId });
  ui.renderModelLabel();
  ui.renderModelList(document.getElementById('model-search').value);
}

/* ---------------- 发送 ---------------- */

function onSend() {
  if (engine.busy) return;
  const text = ui.input.value.trim();
  if (!text) return;
  const session = ensureActiveSession();
  if (!session.model) {
    ui.showBanner('请先在顶部选择一个模型。');
    return;
  }
  ui.hideBanner();
  ui.clearInput();
  engine.send({
    sessionId: session.id,
    text,
    callbacks: {
      onTurnStart: (session, message) => {
        ui.renderSessions();
        ui.markStreamStart(message);
      },
      onDelta: (_session, message) => ui.markStreamDelta(message),
      onToolRound: (_session, _message, round) => {
        ui.showBanner(`模型尝试调用工具（第 ${round} 轮），网页端不执行工具，已自动请求纯文字回答…`, { dismissible: false });
      },
      onTurnEnd: (session, message) => {
        ui.hideBanner();
        if (message.error && message.error.limited) {
          ui.showBanner(
            '免费额度提示：OpenCode 免费通道按出口 IP 限额。当前网络额度可能已耗尽——可稍后再试、切换网络、'
            + '在设置中填入自己的 Key，或参考 README 自建中转。',
          );
        }
        void session;
        ui.renderSessions();
      },
    },
  }).catch((err) => {
    console.error(err);
    ui.showBanner('发送失败：' + escapeText(err.message));
  });
}

function onStop() {
  engine.stop();
}

function onRegenerate() {
  const session = store.getActive();
  if (!session || engine.busy) return;
  engine.regenerate({
    sessionId: session.id,
    callbacks: {
      onTurnStart: (_session, message) => {
        ui.renderSessions();
        // 移除旧消息后整体重绘，再挂流式节点
        ui.renderMessages(session);
        ui.markStreamStart(message);
      },
      onDelta: (_session, message) => ui.markStreamDelta(message),
      onTurnEnd: (_session, message) => {
        ui.hideBanner();
        if (message.error && message.error.limited) {
          ui.showBanner('免费额度提示：当前网络免费配额可能已耗尽，可稍后再试或切换网络。');
        }
        ui.renderSessions();
      },
    },
  }).catch((err) => {
    console.error(err);
    ui.showBanner('重新生成失败：' + escapeText(err.message));
  });
}

/* ---------------- store 订阅 ---------------- */

store.subscribe((event) => {
  if (event.type === 'active-changed') {
    afterSessionSwitch();
  } else if (event.type === 'sessions-changed') {
    ui.renderSessions();
    ui.renderModelLabel();
  } else if (event.type === 'settings-changed') {
    ui.renderTransportBadge();
  } else if (event.type === 'quota-error') {
    ui.showBanner('本地存储空间不足，较早的对话可能无法保存。请导出后清理旧会话。');
  }
});

/* ---------------- 启动 ---------------- */

function escapeText(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function boot() {
  // 会话为空时建一个；非空则恢复上次活跃会话
  const sessions = store.sessions;
  if (!sessions.length) {
    ensureActiveSession();
  } else {
    if (!store.getActive()) store.state.activeId = store.orderedSessions()[0].id;
    afterSessionSwitch();
  }
  ui.renderTransportBadge();
  ui.focusInput();
  loadModels();

  // 免责/状态横幅（仅首次访问展示）
  try {
    if (!localStorage.getItem('oc2webapi.visited')) {
      localStorage.setItem('oc2webapi.visited', '1');
      ui.showBanner(
        '欢迎使用 oc2webapi：请求默认由你的浏览器直连 OpenCode（用户 IP），CORS 受限时自动经同源中转转发；'
        + '对话仅保存在你的浏览器本地。详见设置与 README。',
        { dismissible: true },
      );
    }
  } catch { /* 忽略存储失败 */ }
}

boot();
