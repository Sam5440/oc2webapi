/**
 * oc2webapi — Markdown 渲染（marked + DOMPurify + highlight.js）。
 *
 * 渲染管线：marked(GFM) → DOMPurify 消毒 → 代码块高亮 + 复制按钮。
 * 复制按钮的事件绑定由 React 组件内的委托监听处理（见 MarkdownContent）。
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";

let ready = false;

function init(): void {
  if (ready) return;
  marked.setOptions({ gfm: true, breaks: true, async: false });
  marked.use({
    renderer: {
      code(code: string, lang: string) {
        const language = (lang || "").trim().split(/\s+/)[0] ?? "";
        let highlighted = "";
        let shownLang = language || "text";
        if (language && hljs.getLanguage(language)) {
          try {
            highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
          } catch {
            highlighted = "";
          }
        } else {
          try {
            const auto = hljs.highlightAuto(code);
            highlighted = auto.value;
            if (auto.language) shownLang = auto.language;
          } catch {
            highlighted = escapeHTML(code);
          }
        }
        return (
          `<div class="code-block" data-code="${escapeAttr(code)}">`
          + `<div class="code-block-head"><span class="code-lang">${escapeHTML(shownLang)}</span>`
          + `<button type="button" class="code-copy" data-code-copy>复制</button></div>`
          + `<pre><code class="hljs">${highlighted}</code></pre></div>`
        );
      },
    } as never,
  });
  ready = true;
}

function escapeHTML(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function escapeAttr(text: string): string {
  return escapeHTML(text).replace(/\n/g, "&#10;");
}

/** 解析 + 消毒，返回可直接 dangerouslySetInnerHTML 的 HTML 字符串。 */
export function renderMarkdown(text: string): string {
  init();
  const raw = marked.parse(text || "") as string;
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target", "data-code"],
    FORBID_TAGS: ["style", "form", "input", "iframe"],
  });
}
