/**
 * oc2webapi — 对话引擎。
 *
 * 发送一轮消息的完整流程：
 *   1. 铸造/复用会话的 ses_ 上游身份
 *   2. buildRequest 生成官方形状的请求体与头
 *   3. transport.sendInference 按 auto/direct/relay 通道发送
 *   4. consumeSSE 解析流式事件并实时回调 UI
 *   5. 若模型调用官方工具（网页不执行工具）：回写禁用结果并自动续轮（上限 4 轮）
 *   6. 把最终消息与用量写回本地存储
 */

import * as oc from './oc.js';
import * as transport from './transport.js';
import * as models from './models.js';
import { store } from './store.js';

const MAX_TOOL_ROUNDS = 4;

const DISABLED_TOOL_RESULT = JSON.stringify({
  error: 'tool_unavailable',
  message: 'This web chat client cannot execute agent tools (shell, edit, webfetch, ...). '
    + 'Answer the user directly in plain text/markdown without calling any tool.',
});

export class ChatEngine {
  /** @type {AbortController|null} */
  #abort = null;

  get busy() {
    return !!this.#abort;
  }

  stop() {
    if (this.#abort) this.#abort.abort();
  }

  /**
   * 发送用户消息并驱动生成。
   * @param {object} opts { sessionId, text, callbacks: {onTurnStart, onDelta, onTurnEnd, onError} }
   */
  async send({ sessionId, text, callbacks }) {
    const session = store.get(sessionId);
    if (!session || this.busy) return;

    const userMessage = {
      id: 'm_' + crypto.randomUUID(),
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    session.messages.push(userMessage);
    if (session.messages.filter((m) => m.role === 'user').length === 1 && (!session.title || session.title === '新对话')) {
      store.update(session.id, { title: text.replace(/\s+/g, ' ').trim().slice(0, 24) || '新对话' });
    } else {
      store.update(session.id, {});
    }

    const assistantMessage = {
      id: 'm_' + crypto.randomUUID(),
      role: 'assistant',
      content: '',
      reasoning: '',
      toolNotes: [],
      model: session.model,
      ts: Date.now(),
      usage: null,
      error: null,
      upstreamSession: null,
    };
    session.messages.push(assistantMessage);
    callbacks.onTurnStart?.(session, assistantMessage);

    this.#abort = transport.beginRequest();
    try {
      await this.#runTurn({ session, assistantMessage, callbacks });
    } finally {
      transport.endRequest();
      this.#abort = null;
      store.update(session.id, {});
      callbacks.onTurnEnd?.(session, assistantMessage);
    }
  }

  /** 重新生成最后一条助手消息。 */
  async regenerate({ sessionId, callbacks }) {
    const session = store.get(sessionId);
    if (!session || this.busy) return;
    // 移除末尾的助手消息（可能含错误），保留用户消息。
    while (session.messages.length && session.messages[session.messages.length - 1].role === 'assistant') {
      session.messages.pop();
    }
    const assistantMessage = {
      id: 'm_' + crypto.randomUUID(),
      role: 'assistant',
      content: '',
      reasoning: '',
      toolNotes: [],
      model: session.model,
      ts: Date.now(),
      usage: null,
      error: null,
      upstreamSession: null,
    };
    session.messages.push(assistantMessage);
    callbacks.onTurnStart?.(session, assistantMessage);
    this.#abort = transport.beginRequest();
    try {
      await this.#runTurn({ session, assistantMessage, callbacks });
    } finally {
      transport.endRequest();
      this.#abort = null;
      store.update(session.id, {});
      callbacks.onTurnEnd?.(session, assistantMessage);
    }
  }

  async #runTurn({ session, assistantMessage, callbacks }) {
    const settings = store.getSettings();
    const transportSettings = transport.loadTransportSettings(store);

    // 首次使用时为会话铸造上游 ses_ 身份并固定。
    if (!session.upstreamSession) {
      session.upstreamSession = oc.mintSessionId();
      store.update(session.id, { upstreamSession: session.upstreamSession });
    }

    // 组装历史：跳过当前这轮的助手占位与 tool 消息。带工具调用的历史消息
    // 必须携带配对的 tool 结果（网页端一律回写"工具不可用"），否则上游 400。
    const history = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.id !== assistantMessage.id)
      .filter((m) => (m.content || '').trim() || (m.toolCalls && m.toolCalls.length))
      .flatMap((m) => {
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
          const calls = m.toolCalls;
          const entries = [{
            role: 'assistant',
            content: (m.content || '').trim() || null,
            tool_calls: calls.map((call, i) => ({
              id: call.id || 'call_hist_' + i,
              type: 'function',
              function: { name: call.name, arguments: call.arguments || '{}' },
            })),
          }];
          calls.forEach((call, i) => {
            entries.push({
              role: 'tool',
              tool_call_id: call.id || 'call_hist_' + i,
              content: DISABLED_TOOL_RESULT,
            });
          });
          return entries;
        }
        return [{ role: m.role, content: m.content }];
      });

    let toolRounds = 0;
    let toolCallHistory = [];
    let via = null;

    while (true) {
      const request = await oc.buildRequest({
        model: session.model,
        messages: [...history, ...toolCallHistory],
        sessionId: session.upstreamSession,
        userInstructions: settings.customInstructions,
        apiKey: transportSettings.apiKey,
      });

      let url;
      try {
        const list = await models.getModels();
        const record = list.find((m) => m.id === session.model);
        url = (record && oc.modelEndpoint(record)) || 'https://opencode.ai/inference/openai/v1/chat/completions';
      } catch {
        url = 'https://opencode.ai/inference/openai/v1/chat/completions';
      }

      let response;
      try {
        ({ response, via } = await transport.sendInference({
          url,
          headers: request.headers,
          body: request.body,
          transport: transportSettings.mode,
          relayBase: transportSettings.relayBase,
        }));
      } catch (err) {
        if (transport.isAbortError(err)) {
          assistantMessage.content = assistantMessage.content || '（已停止生成）';
          return;
        }
        assistantMessage.error = { message: err.message, kind: 'transport_error', via: null };
        return;
      }

      if (!response.ok) {
        const parsed = await oc.parseErrorResponse(response);
        // auto 通道在 429/5xx 时 transport 已自动换通道重试过一轮；
        // 两个通道都失败时，把两种口径都告诉用户。
        parsed.via = via;
        assistantMessage.error = parsed;
        if (!assistantMessage.content) {
          assistantMessage.content = '';
        }
        return;
      }

      const result = await oc.consumeSSE(response, (event) => {
        if (event.type === 'text') {
          assistantMessage.content += event.text;
          callbacks.onDelta?.(session, assistantMessage, event);
        } else if (event.type === 'reasoning') {
          assistantMessage.reasoning += event.text;
          callbacks.onDelta?.(session, assistantMessage, event);
        } else if (event.type === 'tool') {
          const note = event.call.name;
          if (note && !assistantMessage.toolNotes.includes(note)) assistantMessage.toolNotes.push(note);
          callbacks.onDelta?.(session, assistantMessage, event);
        } else if (event.type === 'usage') {
          assistantMessage.usage = event.usage;
        }
      });

      assistantMessage.upstreamSession = session.upstreamSession;

      if (result.error) {
        assistantMessage.error = result.error;
        return;
      }

      // 模型想调用工具：网页客户端不执行任何工具，回写禁用结果并自动续轮。
      if (result.toolCalls.length && result.stop === 'tool_calls') {
        if (++toolRounds > MAX_TOOL_ROUNDS) {
          assistantMessage.error = { message: '模型连续请求执行工具超过上限，已停止。请换个问法或模型。', kind: 'tool_loop_limit' };
          return;
        }
        assistantMessage.toolCalls = (assistantMessage.toolCalls || []).concat(result.toolCalls);
        toolCallHistory.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls.map((call, i) => ({
            id: call.id || 'call_' + toolRounds + '_' + i,
            type: 'function',
            function: { name: call.name, arguments: call.arguments || '{}' },
          })),
        });
        for (const call of result.toolCalls) {
          toolCallHistory.push({
            role: 'tool',
            tool_call_id: call.id || 'call_' + toolRounds,
            content: DISABLED_TOOL_RESULT,
          });
        }
        callbacks.onToolRound?.(session, assistantMessage, toolRounds);
        continue;
      }
      return;
    }
  }
}
