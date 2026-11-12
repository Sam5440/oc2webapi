/**
 * oc2webapi — 同源透传中转（Vercel Edge Function）。
 *
 * OpenCode 的推理接口（POST /inference/*）不开放 CORS，网页无法跨域读取
 * 响应。本函数把同源请求原样转发到 opencode.ai，并将上游 SSE 流式回传，
 * 使浏览器端可以完成原本被 CORS 拦截的调用。
 *
 * 安全约束：
 *   - 只转发 https://opencode.ai 的 /inference/* 与 /zen/* 路径，不是开放代理。
 *   - 只复制业务请求头，不透传 Cookie 与部署平台注入的头。
 *   - 可选环境变量 RELAY_TOKEN：设置后要求请求头 x-oc2-token 匹配，
 *     供自建中转者防止陌生人搭便车。
 *
 * 说明：上游看到的是本函数的出口 IP（Vercel），不是访客浏览器 IP。
 * 页面端默认优先尝试浏览器直连以使用用户自己的 IP，直连因 CORS 不可用时
 * 才落到这里；两种通道的行为差异见 README。
 */

export const config = { runtime: 'edge' };

const UPSTREAM_ORIGIN = 'https://opencode.ai';
const ALLOWED_PREFIXES = ['/inference/', '/zen/'];
const UPSTREAM_UA = 'opencode/latest/2.1.1/cli';
const REQUEST_TIMEOUT_MS = 280_000;

/** 浏览器端会携带、且上游关心的请求头。 */
const FORWARD_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'x-opencode-client',
  'x-opencode-session',
  'x-opencode-session-id',
  'x-session-affinity',
  'x-session-id',
  'x-opencode-project',
  'x-opencode-parent-session-id',
  'x-parent-session-id',
  'anthropic-version',
  'anthropic-beta',
  'x-api-key',
];

/** 回传给浏览器时保留的上游响应头。 */
const RESPONSE_HEADERS = ['content-type', 'x-request-id', 'retry-after'];

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function corsPreflight(request) {
  const requestHeaders = request.headers.get('access-control-request-headers') || '';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': requestHeaders || FORWARD_HEADERS.join(', '),
      'Access-Control-Max-Age': '86400',
    },
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (request.method !== 'POST' && request.method !== 'GET') {
    return json(405, { error: { message: '仅支持 GET / POST', type: 'method_not_allowed' } });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return json(403, {
      error: {
        message: '中转仅允许转发 OpenCode 网关路径（/inference/*、/zen/*）',
        type: 'path_forbidden',
      },
    });
  }

  const token = process.env.RELAY_TOKEN;
  if (token && request.headers.get('x-oc2-token') !== token) {
    return json(401, { error: { message: '缺少或错误的 x-oc2-token', type: 'relay_unauthorized' } });
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('user-agent', UPSTREAM_UA);
  headers.set('accept-encoding', 'identity');

  const target = UPSTREAM_ORIGIN + path + url.search;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const aborted = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(504, {
      error: {
        message: aborted ? '中转等待上游超时' : '中转无法连接上游',
        type: aborted ? 'upstream_timeout' : 'upstream_unreachable',
      },
    });
  }

  const responseHeaders = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  responseHeaders.set('Access-Control-Allow-Origin', '*');
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('X-Accel-Buffering', 'no');
  if (!responseHeaders.has('content-type')) {
    responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
