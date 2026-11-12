/**
 * oc2webapi — 请求通道（transport）。
 *
 * OpenCode 推理接口（POST）不开放 CORS，浏览器直连时请求能发出、响应无法
 * 读取；/v1/models 等 GET 接口则完全开放 CORS。通道层提供三种模式：
 *
 *   auto   — 优先浏览器直连（真实用户 IP），CORS 失败或 429/5xx 时回退到
 *            中转（同源 /api 或自定义地址），成功后记住可用通道（粘性）。
 *   direct — 仅直连。需要浏览器禁用 CORS、安装放行扩展，或未来上游开放 CORS。
 *   relay  — 仅中转。中转地址默认同源 /api（Vercel Edge Function）。
 */

const STICKY_KEY = "oc2webapi.transport.sticky";

/** 中转目标白名单：只允许转发到 OpenCode 官方网关路径。 */
export const RELAY_PREFIXES = ["/inference/", "/zen/"];

export type TransportMode = "auto" | "direct" | "relay";

export interface TransportSettings {
  mode: TransportMode;
  relayBase: string;
  apiKey: string;
}

export function defaultRelayBase(): string {
  return new URL("/api", location.href).toString().replace(/\/+$/, "");
}

export function loadTransportSettings(settings: { transportMode?: string; relayBase?: string; apiKey?: string }): TransportSettings {
  return {
    mode: (settings.transportMode as TransportMode) || "auto",
    relayBase: (settings.relayBase || "").trim() || defaultRelayBase(),
    apiKey: (settings.apiKey || "").trim(),
  };
}

function stickyGet(): string {
  try {
    return sessionStorage.getItem(STICKY_KEY) || "";
  } catch {
    return "";
  }
}

function stickySet(value: string): void {
  try {
    sessionStorage.setItem(STICKY_KEY, value);
  } catch {
    /* 忽略 */
  }
}

function targetUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

function isOpencodeUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

/** 模型列表：GET 接口开放 CORS，任何模式下都优先浏览器直连，失败再走中转。 */
export async function fetchModels(relayBase: string): Promise<ModelRecordLike[]> {
  const path = "/inference/openai/v1/models";
  const attempts = [targetUrl("https://opencode.ai", path), targetUrl(relayBase, path)];
  let lastError: unknown = null;
  for (const url of attempts) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (!list.length) throw new Error("模型列表为空");
      return list;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型列表获取失败");
}

export interface ModelRecordLike {
  id: string;
  [key: string]: unknown;
}

/** 当前全局停止信号（由 UI 设置）。 */
let abortController: AbortController | null = null;

export function beginRequest(): AbortController {
  abortController = new AbortController();
  return abortController;
}

export function endRequest(): void {
  abortController = null;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function transportHint(err: unknown, transport: TransportMode): string {
  const detail = err instanceof Error && err.message ? `（${err.message}）` : "";
  if (transport === "direct") {
    return `浏览器直连失败${detail}。OpenCode 推理接口未开放 CORS，普通浏览器无法读取响应；请改用「自动」或「中转」通道。`;
  }
  return `请求发送失败${detail}。请检查网络，或在设置中更换中转地址。`;
}

export interface SendResult {
  response: Response;
  via: "direct" | "relay";
}

/**
 * 发送推理请求。mode: 'auto' | 'direct' | 'relay'。
 * 抛出的错误携带人类可读的通道提示。
 */
export async function sendInference(opts: {
  url: string;
  headers: Record<string, string>;
  body: string;
  mode: TransportMode;
  relayBase: string;
}): Promise<SendResult> {
  const { url, headers, body, mode, relayBase } = opts;
  if (!isOpencodeUrl(url)) throw new Error("推理地址不在 OpenCode 网关白名单内: " + url);
  const path = new URL(url).pathname;
  if (!RELAY_PREFIXES.some((p) => path.startsWith(p))) {
    throw new Error("推理路径不受支持: " + path);
  }
  const directUrl = targetUrl("https://opencode.ai", path);
  const relayUrl = targetUrl(relayBase || defaultRelayBase(), path);

  const order: ("direct" | "relay")[] = [];
  if (mode === "direct") order.push("direct");
  else if (mode === "relay") order.push("relay");
  else {
    // auto：优先上次成功的通道；没有记录时先直连（用户浏览器 IP 优先）。
    const sticky = stickyGet();
    if (sticky === "relay") order.push("relay", "direct");
    else order.push("direct", "relay");
  }

  let lastResponseInfo: SendResult | null = null;
  let lastError: unknown = null;
  for (let i = 0; i < order.length; i++) {
    const via = order[i];
    try {
      const response = await fetch(via === "direct" ? directUrl : relayUrl, {
        method: "POST",
        headers,
        body,
        signal: abortController ? abortController.signal : undefined,
      });
      if (response.ok) {
        stickySet(via);
        return { response, via };
      }
      // 拿到了 HTTP 响应。仅当遇到额度/限流/服务端错误时，auto 才值得换通道
      // 再试一次（另一个通道出口 IP 不同，免费额度相互独立）。
      const retryable = response.status === 429 || response.status >= 500;
      if (i + 1 < order.length && retryable) {
        // 消费旧响应体避免连接泄漏，但保留状态与错误体：
        // 若后续通道彻底失败，仍要把这份上游错误呈现给用户。
        const text = await response.text().catch(() => "");
        lastResponseInfo = {
          via,
          response: new Response(text, {
            status: response.status,
            headers: { "content-type": response.headers.get("content-type") || "application/json" },
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
  throw new Error(transportHint(lastError, mode));
}
