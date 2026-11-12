/**
 * oc2webapi — 单条消息（用户气泡 / 助手回复 + 思考过程 + 工具提示 + 错误卡）。
 *
 * 流式期间引擎原地累加 message.content，对象引用不变，因此以 rev
 * （内容长度指纹）作为 memo 比较值，只有正在生成的消息会重渲染。
 */

import { memo } from "react";
import { Bot, CircleAlert, Copy, RefreshCw, Wrench } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/lib/store";

export function messageRev(message: ChatMessage): string {
  return [
    message.content.length,
    message.reasoning?.length ?? 0,
    message.toolNotes?.length ?? 0,
    message.toolCalls?.length ?? 0,
    message.error?.kind ?? "",
    message.usage?.output ?? -1,
  ].join("|");
}

interface Props {
  message: ChatMessage;
  rev: string;
  isLastAssistant: boolean;
  busy: boolean;
  onRegenerate: () => void;
}

export const ChatMessageView = memo(function ChatMessageView({ message, isLastAssistant, busy, onRegenerate }: Props) {
  const isUser = message.role === "user";

  const copy = async () => {
    await navigator.clipboard.writeText(message.content || "");
  };

  return (
    <div className={`group flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <div className={`flex items-center gap-2 text-xs text-muted-foreground ${isUser ? "flex-row-reverse" : ""}`}>
        <span
          className={`inline-flex size-6 items-center justify-center rounded-md text-[11px] font-bold text-primary-foreground ${
            isUser ? "bg-primary" : "bg-emerald-600"
          }`}
        >
          {isUser ? "你" : <Bot className="size-3.5" />}
        </span>
        {!isUser && message.model && (
          <span className="font-mono text-[11px]">{message.model}</span>
        )}
        <span>{formatTime(message.ts)}</span>
        <span className="hidden gap-0.5 group-hover:flex">
          <Button variant="ghost" size="icon" className="size-6" onClick={copy} title="复制">
            <Copy className="size-3.5" />
          </Button>
          {!isUser && isLastAssistant && (
            <Button variant="ghost" size="icon" className="size-6" onClick={onRegenerate} disabled={busy} title="重新生成">
              <RefreshCw className="size-3.5" />
            </Button>
          )}
        </span>
      </div>

      {message.reasoning ? (
        <details className="w-full max-w-full rounded-lg border border-dashed bg-muted/40 text-[13px] text-muted-foreground">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-xs">💭 思考过程</summary>
          <div className="max-h-80 overflow-y-auto whitespace-pre-wrap px-3 pb-2.5">{message.reasoning}</div>
        </details>
      ) : null}

      {message.toolNotes?.length ? (
        <div className="flex max-w-full flex-wrap gap-1.5">
          {message.toolNotes.map((note) => (
            <Badge key={note} variant="outline" className="border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-400">
              <Wrench className="size-3" /> {note}（网页端不执行工具）
            </Badge>
          ))}
        </div>
      ) : null}

      {isUser ? (
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-primary-foreground">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      ) : (
        <div className="w-full min-w-0">
          <MarkdownContent content={message.content} />
        </div>
      )}

      {message.error ? <ErrorCard error={message.error} /> : null}

      {!isUser && (message.usage || message.upstreamSession) ? (
        <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground/80">
          {message.usage ? (
            <span>
              ↑ {message.usage.input} tokens · ↓ {message.usage.output} tokens
            </span>
          ) : null}
          {message.upstreamSession ? <span className="font-mono">会话 {message.upstreamSession.slice(0, 11)}…</span> : null}
        </div>
      ) : null}
    </div>
  );
}, (prev, next) => prev.rev === next.rev && prev.isLastAssistant === next.isLastAssistant && prev.busy === next.busy);

function ErrorCard({ error }: { error: NonNullable<ChatMessage["error"]> }) {
  return (
    <div className="mt-1 w-full rounded-lg border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-[13px] text-destructive">
      <div className="mb-1 flex items-center gap-1.5 font-semibold">
        <CircleAlert className="size-3.5" /> 生成失败（{error.kind}）
      </div>
      <p className="whitespace-pre-wrap">{error.message}</p>
      {error.limited ? (
        <p className="mt-1.5 opacity-90">
          免费额度按出口 IP 记账：当前网络的免费配额可能已用完。可稍后重试、切换网络、在设置中填入自己的 OpenCode Key，或参考 README 自建中转。
        </p>
      ) : null}
    </div>
  );
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
