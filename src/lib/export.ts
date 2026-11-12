/**
 * oc2webapi — 对话导出。
 *
 * 三种格式：Markdown / 独立样式 HTML（可导入 Word）/ 纯文本，另支持打印为 PDF。
 */

import { renderMarkdown } from "./markdown";
import type { Session } from "./store";

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFilename(name: string): string {
  return (name || "对话").replace(/[\\/:*?"<>|\n\r]/g, "_").slice(0, 60).trim() || "对话";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ROLE_LABEL: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具" };

interface Section {
  role: string;
  time: number;
  text: string;
}

function buildSections(session: Session): Section[] {
  const sections: Section[] = [];
  for (const message of session.messages) {
    if (message.role === "tool") continue;
    const label = ROLE_LABEL[message.role] ?? message.role;
    const parts: string[] = [];
    if (message.reasoning && message.reasoning.trim()) {
      parts.push("<details open>\n<summary>思考过程</summary>\n\n" + message.reasoning.trim() + "\n\n</details>");
    }
    parts.push((message.content || "").trim());
    if (message.toolNotes?.length) {
      parts.push("> 模型尝试调用工具：" + message.toolNotes.join("、") + "（网页客户端不执行工具）");
    }
    sections.push({ role: label, time: message.ts, text: parts.join("\n\n") });
  }
  return sections;
}

function headerLine(session: Session): string {
  const lines = [`# ${session.title || "对话"}`, ""];
  lines.push(`- 模型：${session.model || "未知"}`);
  lines.push(`- 导出时间：${formatTime(Date.now())}`);
  lines.push(`- 消息数：${session.messages.filter((m) => m.role !== "tool").length}`);
  lines.push("");
  return lines.join("\n");
}

export function exportMarkdown(session: Session): void {
  const parts = [headerLine(session)];
  for (const section of buildSections(session)) {
    parts.push(`## ${section.role}  ·  ${formatTime(section.time)}\n\n${section.text}\n`);
  }
  download(safeFilename(session.title) + ".md", parts.join("\n"), "text/markdown");
}

function standaloneHTML(title: string, bodyMarkdown: string): string {
  const body = renderMarkdown(bodyMarkdown);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
${hljsLightCss}
${hljsDarkScoped}
body{max-width:860px;margin:0 auto;padding:32px 20px;background:#fff;color:#1f2328;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  font-size:15px;line-height:1.65}
.md p{margin:.55em 0}.md h1,.md h2,.md h3{margin:1.1em 0 .5em}
.md blockquote{margin:.6em 0;padding:.4em 1em;border-left:3px solid #e4e4ea;color:#555;background:#f8f8fa;border-radius:0 8px 8px 0}
.md table{border-collapse:collapse;margin:.7em 0}.md th,.md td{border:1px solid #d8d8de;padding:6px 12px}
.md th{background:#f2f2f6}.md code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:#f2f2f6;border-radius:5px;padding:.15em .4em}
.code-block{margin:.7em 0;border:1px solid #d8d8de;border-radius:10px;overflow:hidden;background:#f8f9fb}
.code-block-head{display:flex;justify-content:space-between;padding:5px 12px;border-bottom:1px solid #e4e4ea;background:#f2f3f6;font-size:12px;color:#777}
.code-block pre{margin:0;padding:12px 14px;overflow-x:auto;font-size:13px}
h1{font-size:1.6em}
</style>
</head>
<body>
<h1>${escapeHTML(title)}</h1>
<div class="md">${body}</div>
</body>
</html>`;
}

// 高亮样式内联进导出文档（亮色 + 暗色跟随 prefers-color-scheme）
import hljsLight from "highlight.js/styles/github.css?inline";
import hljsDark from "highlight.js/styles/github-dark.css?inline";
const hljsLightCss = String(hljsLight);
const hljsDarkScoped = `@media (prefers-color-scheme: dark){${String(hljsDark)}}`;

function escapeHTML(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export function exportHTML(session: Session): void {
  const body = buildSections(session)
    .map((section) => `## ${section.role} · ${formatTime(section.time)}\n\n${section.text}`)
    .join("\n\n---\n\n");
  download(safeFilename(session.title) + ".html", standaloneHTML(session.title || "对话", headerLine(session) + "\n" + body), "text/html");
}

export function exportText(session: Session): void {
  const parts: string[] = [session.title || "对话", "=".repeat(30), ""];
  for (const section of buildSections(session)) {
    const plain = section.text
      .replace(/<details>[\s\S]*?<summary>(.*?)<\/summary>/g, "[$1]")
      .replace(/<\/?details>/g, "")
      .replace(/```(\w*)\n?/g, "")
      .replace(/```/g, "")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1 ($2)");
    parts.push(`【${section.role}】${formatTime(section.time)}`, plain, "");
  }
  download(safeFilename(session.title) + ".txt", parts.join("\n"), "text/plain");
}

export function exportSession(session: Session, format: "md" | "html" | "txt" | "print"): void {
  if (format === "md") exportMarkdown(session);
  else if (format === "html") exportHTML(session);
  else if (format === "txt") exportText(session);
  else if (format === "print") printSession(session);
}

function printSession(session: Session): void {
  const body = buildSections(session)
    .map((section) => `## ${section.role} · ${formatTime(section.time)}\n\n${section.text}`)
    .join("\n\n---\n\n");
  const html = standaloneHTML(session.title || "对话", headerLine(session) + "\n" + body);
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}
