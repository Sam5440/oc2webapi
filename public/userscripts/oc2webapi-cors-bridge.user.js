// ==UserScript==
// @name         oc2webapi · 浏览器直连增强（CORS 桥）
// @name:en      oc2webapi · Direct-connection CORS bridge
// @namespace    https://github.com/Sam5440/oc2webapi
// @version      1.0.0
// @description  让 oc2webapi 的「浏览器直连」通道真正可用：把发往 opencode.ai 的推理请求交给油猴后台发出，绕过浏览器 CORS 限制；上游看到的仍是你自己的 IP，且保持流式输出。
// @author       Sam5440
// @license      GPL-3.0-or-later
// @match        https://oc2webapi.vercel.app/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @include      /^https?:\/\/localhost(:\d+)?\//
// @include      /^https?:\/\/127\.0\.0\.1(:\d+)?\//
// @connect      opencode.ai
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 工作原理
 * --------
 * 1. 油猴脚本在 document-start 注入一段「页面侧」代码，替换 window.fetch。
 * 2. 页面里发往 https://opencode.ai/inference/* 或 /zen/* 的 POST 请求（其余方法不受 CORS
 *    影响，保持原生）不再由浏览器发起，而是通过 postMessage 交给油猴沙箱，用
 *    GM_xmlhttpRequest 在扩展后台发出——扩展请求不受 CORS 限制。
 * 3. 响应状态码、响应头与正文分块回传给页面，页面侧拼成一个真正的 ReadableStream
 *    塞进 new Response()，于是 oc2webapi 的 SSE 流式解析、错误解析、中止逻辑全部照常工作。
 *
 * 因此：上游看到的是你自己的出口 IP（免费额度独立于 Vercel 中转），网页也不需要任何
 * 中转服务。数据不经过第三方，请求内容只有你和 OpenCode 双方知道。
 *
 * 自定义部署域名
 * --------------
 * 把下面 @match 里的 oc2webapi.vercel.app 换成你的域名；若指向其他上游域名，记得补一行
 * @connect 你的域名，并同步修改 BRIDGE_HOSTS。
 *
 * 支持的脚本管理器：Tampermonkey / Violentmonkey（Chrome、Edge、Firefox）。
 */

(function () {
  "use strict";

  const VERSION = "1.0.0";
  const TAG = "[oc2webapi/cors-bridge]";
  const DEBUG = false;

  /** 允许桥接的上游主机（含其子域）。 */
  const BRIDGE_HOSTS = ["opencode.ai"];
  /** 允许桥接的路径前缀。 */
  const BRIDGE_PATHS = ["/inference/", "/zen/"];

  const page = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  const gmXhr =
    typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function"
        ? GM.xmlHttpRequest.bind(GM)
        : null;

  if (!gmXhr) {
    console.warn(TAG, "缺少 GM_xmlhttpRequest 授权，脚本未启用");
    return;
  }
  if (page.__oc2CorsBridge && page.__oc2CorsBridge.active) return; // 幂等

  const log = (...args) => {
    if (DEBUG) console.info(TAG, ...args);
  };

  const token = (function () {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch {
      /* 忽略 */
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  })();

  /** 正在进行的桥接请求：id -> { abort() } */
  const inflight = new Map();

  function postToPage(message) {
    message.__oc2 = 1;
    message.token = token;
    message.dir = "page";
    try {
      // Firefox 的沙箱对象不能直接跨 compartment 传递，需要 cloneInto。
      const payload = typeof cloneInto === "function" ? cloneInto(message, page) : message;
      page.postMessage(payload, "*");
    } catch (err) {
      console.warn(TAG, "回传页面失败", err);
    }
  }

  function parseHeaders(raw) {
    const out = {};
    String(raw || "")
      .split(/\r?\n/)
      .forEach((line) => {
        const at = line.indexOf(":");
        if (at <= 0) return;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key) out[key] = value;
      });
    return out;
  }

  function startBridgeRequest(msg) {
    let opened = false;
    let finished = false;
    let sentLength = 0;
    let rawHeaders = "";
    let handle = null;

    const open = (detail) => {
      if (opened) return;
      const status = Number(detail && detail.status) || 0;
      if (status < 100) return; // 还没拿到响应头
      opened = true;
      rawHeaders = String(detail.responseHeaders || "");
      postToPage({
        kind: "open",
        id: msg.id,
        status: status,
        statusText: String(detail.statusText || ""),
        headers: parseHeaders(rawHeaders),
      });
    };

    const pump = (detail) => {
      const text =
        detail && typeof detail.responseText === "string"
          ? detail.responseText
          : detail && typeof detail.response === "string"
            ? detail.response
            : "";
      if (text.length <= sentLength) return;
      postToPage({ kind: "chunk", id: msg.id, text: text.slice(sentLength) });
      sentLength = text.length;
    };

    const fail = (reason) => {
      if (finished) return;
      finished = true;
      inflight.delete(msg.id);
      postToPage({ kind: "error", id: msg.id, message: reason });
    };

    try {
      handle = gmXhr({
        method: msg.method || "GET",
        url: msg.url,
        headers: msg.headers || {},
        data: msg.body == null ? undefined : msg.body,
        responseType: "text",
        timeout: 0,
        onreadystatechange(detail) {
          if (!detail) return;
          if (detail.readyState >= 2) open(detail);
          if (detail.readyState >= 3) pump(detail);
        },
        onprogress(detail) {
          open(detail);
          pump(detail);
        },
        onload(detail) {
          if (finished) return;
          open(detail);
          pump(detail);
          finished = true;
          inflight.delete(msg.id);
          postToPage({ kind: "end", id: msg.id });
        },
        onerror(detail) {
          const extra = detail && detail.error ? "：" + detail.error : "";
          fail("网络请求失败（GM_xmlhttpRequest）" + extra);
        },
        ontimeout() {
          fail("请求超时");
        },
        onabort() {
          fail("请求已取消");
        },
      });
    } catch (err) {
      fail("桥接请求创建失败：" + (err && err.message ? err.message : String(err)));
      return;
    }

    inflight.set(msg.id, {
      abort() {
        try {
          if (handle && typeof handle.abort === "function") handle.abort();
        } catch {
          /* 忽略 */
        }
      },
    });
    log("bridge", msg.method, msg.url);
  }

  // ---- 沙箱侧：接收页面侧的桥接指令 ----
  page.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || data.__oc2 !== 1 || data.token !== token || data.dir !== "bridge") return;

    if (data.kind === "start") {
      startBridgeRequest(data);
      return;
    }
    if (data.kind === "abort") {
      const job = inflight.get(data.id);
      if (job) {
        inflight.delete(data.id);
        job.abort();
      }
    }
  });

  // ---- 页面侧代码（会被序列化后注入页面主世界） ----
  function pageBridge(cfg) {
    if (window.__oc2CorsBridge && window.__oc2CorsBridge.active) return;

    const token = cfg.token;
    const nativeFetch = window.fetch;
    const encoder = new TextEncoder();
    const pending = new Map();
    let seq = 0;
    const stats = { requests: 0, bridged: 0, failed: 0 };

    window.__oc2CorsBridge = {
      version: cfg.version,
      active: true,
      at: Date.now(),
      stats: stats,
    };

    const shouldBridge = (url) => {
      let u;
      try {
        u = new URL(url, location.href);
      } catch (err) {
        return false;
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      const hostOk = cfg.hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
      if (!hostOk) return false;
      return cfg.paths.some((p) => u.pathname.indexOf(p) === 0);
    };

    const toSandbox = (message) => {
      message.__oc2 = 1;
      message.token = token;
      message.dir = "bridge";
      window.postMessage(message, "*");
    };

    const abortError = () => {
      try {
        return new DOMException("The operation was aborted.", "AbortError");
      } catch (err) {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        return e;
      }
    };

    const headersToObject = (headers) => {
      const out = {};
      if (!headers) return out;
      try {
        if (typeof headers.forEach === "function" && typeof headers.get === "function") {
          headers.forEach((value, key) => {
            out[String(key)] = String(value);
          });
        } else if (Array.isArray(headers)) {
          headers.forEach((pair) => {
            if (pair && pair.length >= 2) out[String(pair[0])] = String(pair[1]);
          });
        } else {
          Object.keys(headers).forEach((key) => {
            out[key] = String(headers[key]);
          });
        }
      } catch (err) {
        /* 忽略畸形头 */
      }
      return out;
    };

    window.addEventListener("message", (event) => {
      const data = event && event.data;
      if (!data || data.__oc2 !== 1 || data.token !== token || data.dir !== "page") return;
      const entry = pending.get(data.id);
      if (!entry) return;

      if (data.kind === "open") {
        if (entry.opened || !data.status) return;
        entry.opened = true;
        const init = { status: data.status, statusText: data.statusText || "", headers: data.headers || {} };
        let response;
        try {
          response = new Response(entry.stream, init);
        } catch (err) {
          // 204/205/304 等不允许有响应体的状态码
          response = new Response(null, init);
        }
        entry.resolve(response);
        return;
      }

      if (data.kind === "chunk") {
        if (entry.closed || !entry.controller) return;
        try {
          entry.controller.enqueue(encoder.encode(data.text));
        } catch (err) {
          /* 流已关闭 */
        }
        return;
      }

      if (data.kind === "end") {
        if (!entry.closed) {
          entry.closed = true;
          if (entry.controller) {
            try {
              entry.controller.close();
            } catch (err) {
              /* 忽略 */
            }
          }
        }
        pending.delete(data.id);
        return;
      }

      if (data.kind === "error") {
        const error = new TypeError(data.message || "网络请求失败");
        if (!entry.opened) {
          entry.opened = true;
          entry.reject(error);
          pending.delete(data.id);
        } else if (!entry.closed) {
          entry.closed = true;
          if (entry.controller) {
            try {
              entry.controller.error(error);
            } catch (err) {
              /* 忽略 */
            }
          }
          pending.delete(data.id);
        }
      }
    });

    window.fetch = function (input, init) {
      let url = "";
      try {
        if (typeof input === "string") url = input;
        else if (input instanceof URL) url = input.href;
        else if (input && typeof input === "object" && typeof input.url === "string") url = input.url;
      } catch (err) {
        url = "";
      }

      // 只接管「字符串 URL + 简单 init」这一种形态；Request 对象（body 可能是流）交给浏览器原生 fetch。
      if (!url || !shouldBridge(url) || input instanceof Request) {
        return nativeFetch.call(window, input, init);
      }

      // 只有 POST 会被浏览器 CORS 拦截；GET /v1/models 本已开放 CORS，保持原生更快。
      const method = String((init && init.method) || "GET").toUpperCase();
      if (method !== "POST") {
        return nativeFetch.call(window, input, init);
      }

      stats.requests += 1;
      const body = init && init.body != null ? init.body : null;
      if (body != null && typeof body !== "string") {
        // 本项目只发送 JSON 字符串；其他 body 类型不做桥接，避免静默改语义。
        return nativeFetch.call(window, input, init);
      }

      const id = "oc2-" + Date.now().toString(36) + "-" + (++seq).toString(36);
      const entry = {
        opened: false,
        closed: false,
        controller: null,
        stream: null,
        resolve: null,
        reject: null,
      };

      entry.stream = new ReadableStream({
        start(controller) {
          entry.controller = controller;
        },
        cancel() {
          toSandbox({ kind: "abort", id });
          pending.delete(id);
        },
      });

      const promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });

      pending.set(id, entry);
      stats.bridged += 1;

      const failEarly = (error) => {
        if (!entry.opened) {
          entry.opened = true;
          entry.reject(error);
          pending.delete(id);
        } else if (!entry.closed) {
          entry.closed = true;
          if (entry.controller) {
            try {
              entry.controller.error(error);
            } catch (err) {
              /* 忽略 */
            }
          }
          pending.delete(id);
        }
      };

      const signal = init && init.signal;
      if (signal) {
        if (signal.aborted) {
          failEarly(abortError());
          return promise;
        }
        try {
          signal.addEventListener(
            "abort",
            () => {
              toSandbox({ kind: "abort", id });
              failEarly(abortError());
            },
            { once: true },
          );
        } catch (err) {
          /* 忽略 */
        }
      }

      toSandbox({
        kind: "start",
        id: id,
        url: url,
        method: method,
        headers: headersToObject(init && init.headers),
        body: body,
      });

      return promise;
    };
  }

  function inject() {
    const cfg = {
      version: VERSION,
      token: token,
      hosts: BRIDGE_HOSTS,
      paths: BRIDGE_PATHS,
    };
    const script = document.createElement("script");
    script.textContent = "(" + pageBridge.toString() + ")(" + JSON.stringify(cfg) + ");";
    script.setAttribute("data-oc2-bridge", VERSION);
    const parent = document.head || document.documentElement;
    if (!parent) {
      console.warn(TAG, "没有可注入的父节点，脚本未启用");
      return;
    }
    parent.appendChild(script);
    script.remove();

    // 页面有 CSP 时注入会被静默拦截，这里给出可诊断的提示。
    setTimeout(() => {
      if (!page.__oc2CorsBridge || !page.__oc2CorsBridge.active) {
        console.warn(TAG, "页面侧注入失败（可能被 CSP 拦截），直连仍会走浏览器原生 fetch");
      } else {
        console.info(TAG, "已启用 v" + VERSION + "：opencode.ai 推理请求改由扩展后台发出，绕过 CORS");
      }
    }, 0);
  }

  inject();
})();
