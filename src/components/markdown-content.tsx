/**
 * oc2webapi — Markdown 内容块。
 * renderMarkdown 输出消毒后的 HTML；代码块复制按钮用事件委托绑定。
 */

import { useMemo } from "react";
import { renderMarkdown } from "@/lib/markdown";

export function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  const handleClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>("[data-code-copy]");
    if (!button) return;
    const block = button.closest<HTMLElement>(".code-block");
    const code = block?.getAttribute("data-code") ?? "";
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败";
    }
    setTimeout(() => {
      button.textContent = "复制";
    }, 1500);
  };

  return <div className="md" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
