/**
 * oc2webapi — 请求通道（transport）。
 *
 * OpenCode 推理接口（POST）不开放 CORS，浏览器直连时请求能发出、响应无法
 * 读取；/v1/models 等 GET 接口则完全开放 CORS。通道层提供三种模式：
 *
 *   auto   — 优先浏览器直连（真实用户 IP），CORS 失败或 429/5xx 时回退到
 *            中转（同源 /api 或自定义地址），成功后记住可用通道（粘性）。
 *   direct — 仅直连。需要浏览器禁用 CORS、安装放行扩展，或未来上游开放 CORS。
 *   relay  — 仅中转。中转地址默认同源 /api（Vercel Edge Function），
 *            可在设置中指向任意自建中转。
 *
 * 直连失败的判定是"没拿到响应"（fetch 抛 TypeError），拿到响应就不再换通道。
 */

const STICKY_KEY = 'oc2webapi.transport.sticky';

/** 中转目标白名单：只允许转发到 OpenCode 官方网关路径。 */
export const RELAY_PREFIXES = ['/inference/', '/zen/'];

export function defaultRelayBase() {
  return new URL('/api', location.href).toString().replace(/\/+$/, '');
}

export function loadTransportSettings(store) {
  const s = store.getSettings();
  return {
    mode: s.transportMode || 'auto',
    relayBase: (s.relayBase || '').trim() || defaultRelayBase(),
    apiKey: (s.apiKey || '').trim(),
  };
}

function stickyGet() {
  try { return sessionStorage.getItem(STICKY_KEY) || ''; } catch { return ''; }
}

function stickySet(value) {
  try { sessionStorage.setItem(STICKY_KEY, value); } catch { /* 忽略 */ }
}

function targetUrl(base, path) {
  return base.replace(/\/+$/, '') + path;
}

function isOpencodeUrl(url) {
  try {
    const host = new URL(url).host;
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/** 模型列表：GET 接口开放 CORS，任何模式下都优先浏览器直连，失败再走中转。 */
export async function fetchModels({ relayBase }) {
  const path = '/inference/openai/v1/models';
  const attempts = [targetUrl('https://opencode.ai', path), targetUrl(relayBase, path)];
  let lastError = null;
  for (const url of attempts) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      if (!list.length) throw new Error('模型列表为空');
      return list;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('模型列表获取失败');
}

/**
 * 发送推理请求。transport: 'auto' | 'direct' | 'relay'。
 * 返回 { response, via }；via 为实际使用的通道 'direct' | 'relay'。
 * 抛出的错误携带 .via 与 .transportTried 信息供 UI 展示。
 */
export async function sendInference({ url, headers, body, transport, relayBase }) {
  if (!isOpencodeUrl(url)) throw new Error('推理地址不在 OpenCode 网关白名单内: ' + url);
  const path = new URL(url).pathname;
  if (!RELAY_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error('推理路径不受支持: ' + path);
  }
  const directUrl = targetUrl('https://opencode.ai', path);
  const relayUrl = targetUrl(relayBase || defaultRelayBase(), path);

  const attempt = async (target, via) => {
    const response = await fetch(target, { method: 'POST', headers, body, signal: currentSignal() });
    return { response, via };
  };

  const order = [];
  if (transport === 'direct') order.push('direct');
  else if (transport === 'relay') order.push('relay');
  else {
    // auto：优先上次成功的通道；没有记录时先直连（对得上"用户浏览器 IP"的默认期望）。
    const sticky = stickyGet();
    if (sticky === 'relay') order.push('relay', 'direct');
    else order.push('direct', 'relay');
  }

  let lastResponseInfo = null; // 最后一个拿到 HTTP 响应的通道（即使非 2xx）
  let lastError = null;
  for (let i = 0; i < order.length; i++) {
    const via = order[i];
    try {
      const { response } = await attempt(via === 'direct' ? directUrl : relayUrl, via);
      if (response.ok) {
        stickySet(via);
        return { response, via };
      }
      // 拿到了 HTTP 响应。仅当遇到额度/限流/服务端错误时，auto 才值得换通道
      // 再试一次（另一个通道出口 IP 不同，免费额度相互独立）。
      const retryable = response.status === 429 || response.status >= 500;
      if (i + 1 < order.length && retryable) {
        // 消费掉旧响应体避免连接泄漏，但把状态与错误体保留下来：
        // 若后续通道彻底失败，仍要把这份上游错误呈现给用户。
        const text = await response.text().catch(() => '');
        lastResponseInfo = {
          via,
          response: new Response(text, {
            status: response.status,
            headers: { 'content-type': response.headers.get('content-type') || 'application/json' },
          }),
        };
        continue;
      }
      return { response, via };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      // fetch 抛错 = 没拿到响应（CORS/网络），auto 模式换通道重试。
      if (i + 1 < order.length) continue;
    }
  }
  if (lastResponseInfo) return lastResponseInfo;
  const error = new Error(transportHint(lastError, transport));
  error.cause = lastError;
  throw error;
}

function transportHint(err, transport) {
  const detail = err && err.message ? '（' + err.message + '）' : '';
  if (transport === 'direct') {
    return '浏览器直连失败' + detail + '。OpenCode 推理接口未开放 CORS，普通浏览器无法读取响应；请改用「自动」或「中转」通道。';
  }
  return '请求发送失败' + detail + '。请检查网络，或在设置中更换中转地址。';
}

export function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** 当前全局停止信号（由 UI 设置）。 */
let abortController = null;

export function beginRequest() {
  abortController = new AbortController();
  return abortController;
}

export function endRequest() {
  abortController = null;
}

function currentSignal() {
  return abortController ? abortController.signal : undefined;
}
