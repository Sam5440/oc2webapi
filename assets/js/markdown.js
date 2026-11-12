/**
 * oc2webapi — Markdown 渲染（marked + DOMPurify + highlight.js）。
 *
 * 渲染管线：marked(GFM) → DOMPurify 消毒 → 代码块高亮 + 复制按钮。
 * 流式期间对增量 HTML 重渲染；marked 的异步高亮关闭，全部同步完成。
 */

let ready = false;

export function initMarkdown() {
  if (ready) return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    async: false,
  });
  ready = true;
}

const renderer = {
  code(code, lang) {
    const language = (lang || '').trim().split(/\s+/)[0];
    let highlighted = '';
    let shownLang = language || 'text';
    if (language && hljs.getLanguage(language)) {
      try {
        highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
      } catch { highlighted = ''; }
    } else {
      try {
        const auto = hljs.highlightAuto(code);
        highlighted = auto.value;
        if (auto.language) shownLang = auto.language;
      } catch { highlighted = escapeHTML(code); }
    }
    const safeLang = escapeHTML(shownLang);
    return `<div class="code-block" data-code="${escapeAttr(code)}">`
      + `<div class="code-block-head"><span class="code-lang">${safeLang}</span>`
      + `<button type="button" class="code-copy" aria-label="复制代码">复制</button></div>`
      + `<pre><code class="hljs">${highlighted}</code></pre></div>`;
  },
};

marked.use({ renderer });

function escapeHTML(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(text) {
  return escapeHTML(text).replace(/\n/g, '&#10;');
}

/** 解析 + 消毒，返回可直接插入 DOM 的 HTML 字符串。 */
export function renderMarkdown(text) {
  initMarkdown();
  const raw = marked.parse(text || '');
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'data-code'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  });
}

/** 消毒后 HTML 的后处理：链接新开、绑定复制按钮。 */
export function enhanceMarkdownDOM(rootElement) {
  for (const a of rootElement.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const button of rootElement.querySelectorAll('.code-copy')) {
    if (button.dataset.bound) continue;
    button.dataset.bound = '1';
    button.addEventListener('click', async () => {
      const block = button.closest('.code-block');
      const code = block ? block.getAttribute('data-code') || '' : '';
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
      } catch {
        button.textContent = '复制失败';
      }
      setTimeout(() => { button.textContent = '复制'; }, 1500);
    });
  }
}

/** 导出用：从渲染文本生成完整独立 HTML 文档字符串。 */
export function markdownToStandaloneHTML(title, bodyMarkdown) {
  const body = renderMarkdown(bodyMarkdown);
  const css = Array.from(document.styleSheets)
    .filter((sheet) => { try { return !sheet.href || sheet.href.startsWith(location.origin); } catch { return false; } })
    .map((sheet) => { try { return Array.from(sheet.cssRules).map((r) => r.cssText).join('\n'); } catch { return ''; } })
    .join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>${css}</style>
<style>body{max-width:860px;margin:0 auto;padding:32px 20px;background:#fff;color:#1f2328}</style>
</head>
<body>
<h1>${escapeHTML(title)}</h1>
<div class="md">${body}</div>
</body>
</html>`;
}
