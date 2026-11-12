/**
 * oc2webapi — 输入区：自适应高度输入、Enter 发送、停止/发送按钮。
 */

import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
}

export function Composer({ value, onChange, busy, onSend, onStop }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  return (
    <div className="mx-auto w-full max-w-[820px] px-4 pb-3">
      <div className="rounded-2xl border bg-background p-2.5 shadow-sm transition-colors focus-within:border-ring">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行…"
          className="max-h-[200px] resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-center gap-2 px-1 pt-1">
          <span className="text-[11px] text-muted-foreground/70">
            {busy ? "正在生成…" : "内容由 AI 生成，请注意甄别"}
          </span>
          {busy ? (
            <Button size="sm" variant="destructive" className="ml-auto rounded-xl" onClick={onStop} aria-label="停止生成">
              <Square className="size-3.5" /> 停止
            </Button>
          ) : (
            <Button
              size="icon"
              className="ml-auto size-9 rounded-xl"
              onClick={onSend}
              disabled={!value.trim()}
              aria-label="发送"
              title="发送 (Enter)"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
        由社区逆向的 OpenCode 免费通道驱动 · 仅供学习研究 · 对话仅存于你的浏览器 ·{" "}
        <a href="https://github.com/Sam5440/oc2webapi" target="_blank" rel="noopener" className="underline">
          GitHub
        </a>
      </p>
    </div>
  );
}
