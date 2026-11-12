/**
 * oc2webapi — 对话导出。
 *
 * 三种格式：
 *   Markdown — 纯文本 .md，代码块/思考过程原样保留
 *   HTML     — 独立样式文档（已渲染），可用浏览器打开或导入 Word
 *   纯文本   — .txt，最通用
 */

import { markdownToStandaloneHTML } from './markdown.js';

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFilename(name) {
  return (name || '对话').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60).trim() || '对话';
}

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ROLE_LABEL = { user: '用户', assistant: '助手', tool: '工具' };

function buildSections(session) {
  const sections = [];
  for (const message of session.messages) {
    if (message.role === 'tool') continue;
    const label = ROLE_LABEL[message.role] || message.role;
    const parts = [];
    if (message.reasoning && message.reasoning.trim()) {
      parts.push('<details open>\n<summary>思考过程</summary>\n\n' + message.reasoning.trim() + '\n\n</details>');
    }
    parts.push((message.content || '').trim());
    if (message.toolNotes && message.toolNotes.length) {
      parts.push('> 模型尝试调用工具：' + message.toolNotes.join('、') + '（网页客户端不执行工具）');
    }
    if (message.usage) {
      parts.push(`<!-- tokens: ${message.usage.input} in / ${message.usage.output} out -->`);
    }
    sections.push({ role: label, time: message.ts, text: parts.join('\n\n') });
  }
  return sections;
}

function headerLine(session) {
  const lines = [`# ${session.title || '对话'}`, ''];
  lines.push(`- 模型：${session.model || '未知'}`);
  lines.push(`- 导出时间：${formatTime(Date.now())}`);
  lines.push(`- 消息数：${session.messages.filter((m) => m.role !== 'tool').length}`);
  lines.push('');
  return lines.join('\n');
}

export function exportMarkdown(session) {
  const parts = [headerLine(session)];
  for (const section of buildSections(session)) {
    parts.push(`## ${section.role}  ·  ${formatTime(section.time)}\n\n${section.text}\n`);
  }
  download(safeFilename(session.title) + '.md', parts.join('\n'), 'text/markdown');
}

export function exportHTML(session) {
  const body = buildSections(session)
    .map((section) => `## ${section.role} · ${formatTime(section.time)}\n\n${section.text}`)
    .join('\n\n---\n\n');
  const html = markdownToStandaloneHTML(session.title || '对话', headerLine(session) + '\n' + body);
  download(safeFilename(session.title) + '.html', html, 'text/html');
}

export function exportText(session) {
  const parts = [session.title || '对话', '='.repeat(30), ''];
  for (const section of buildSections(session)) {
    const plain = section.text
      .replace(/<details>[\s\S]*?<summary>(.*?)<\/summary>/g, '[$1]')
      .replace(/<\/?details>/g, '')
      .replace(/```(\w*)\n?/g, '')
      .replace(/```/g, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1 ($2)');
    parts.push(`【${section.role}】${formatTime(section.time)}`, plain, '');
  }
  download(safeFilename(session.title) + '.txt', parts.join('\n'), 'text/plain');
}

export function exportSession(session, format) {
  if (format === 'md') exportMarkdown(session);
  else if (format === 'html') exportHTML(session);
  else if (format === 'txt') exportText(session);
  else if (format === 'print') printSession(session);
}

function printSession(session) {
  const body = buildSections(session)
    .map((section) => `## ${section.role} · ${formatTime(section.time)}\n\n${section.text}`)
    .join('\n\n---\n\n');
  const html = markdownToStandaloneHTML(session.title || '对话', headerLine(session) + '\n' + body);
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}
