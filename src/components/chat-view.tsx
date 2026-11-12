/**
 * oc2webapi — 消息流与空态。
 */

import { useEffect, useRef } from "react";
import { ChatMessageView, messageRev } from "@/components/chat-message";
import { Button } from "@/components/ui/button";
import type { ChatMessage, Session } from "@/lib/store";

const SUGGESTIONS = [
  "用通俗的语言解释一下什么是 WebSocket，以及它和 HTTP 长轮询的区别",
  "帮我写一个 Python 脚本：遍历指定目录，找出所有重复文件（按内容哈希），输出分组报告",
  "把这句话翻译成地道英文：「这个方案还不够成熟，我们需要更多数据来支撑决策。」",
  "为初学者制定一份 4 周的 Go 语言学习计划，每周给出目标和练手项目",
];

interface Props {
  /** 流式版本号：App 在 rAF 节流后递增，驱动消息流重渲染（内容按指纹 memo）。 */
  streamTick: number;
  session: Session | null;
  busy: boolean;
  onRegenerate: () => void;
  onSuggestion: (text: string) => void;
}

export function ChatView({ streamTick, session, busy, onRegenerate, onSuggestion }: Props) {
  void streamTick;
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const visible = session?.messages.filter((m) => m.role !== "tool") ?? [];
  const last = visible[visible.length - 1];

  // 新消息出现/内容增长时，若用户在底部附近则跟随滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visible.length, last && messageRev(last)]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  if (!session || visible.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-[640px] text-center">
          <div className="mb-4 inline-block rounded-2xl bg-primary px-5 py-3 font-mono text-2xl font-extrabold text-primary-foreground">
            oc2
          </div>
          <h1 className="mb-2 text-[22px] font-bold">OpenCode 免费模型 · 网页直聊</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            无需注册、无需服务器账号——请求由你的浏览器发出，对话只保存在本地。
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {SUGGESTIONS.map((text) => (
              <Button
                key={text}
                variant="outline"
                className="h-auto justify-start py-3 text-left text-[13px] font-normal"
                onClick={() => onSuggestion(text)}
              >
                {text}
              </Button>
            ))}
          </div>
          <p className="mt-6 text-xs text-muted-foreground/70">
            提示：若出现「Free usage limit reached」，说明当前网络或中转出口的免费额度已耗尽——
            可稍后再试、切换网络、在设置中填入自己的 Key，或自建中转。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-5 py-5">
        {visible.map((message) => {
          // 空的助手占位（首个 chunk 未到）不渲染气泡，由思考指示器代替
          const isPendingPlaceholder =
            busy && message === last && message.role === "assistant" && !message.content && !message.reasoning && !message.error;
          return isPendingPlaceholder ? (
            <div key={message.id} className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex size-6 items-center justify-center rounded-md bg-emerald-600 text-[11px] font-bold text-primary-foreground">
                AI
              </span>
              <span className="typing-dots">思考中</span>
            </div>
          ) : (
            <ChatMessageView
              key={message.id}
              message={message}
              rev={messageRev(message)}
              isLastAssistant={message === last && message.role === "assistant"}
              busy={busy}
              onRegenerate={onRegenerate}
            />
          );
        })}
      </div>
    </div>
  );
}

export type { ChatMessage };
