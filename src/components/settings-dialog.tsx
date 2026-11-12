/**
 * oc2webapi — 设置弹窗（shadcn Dialog + Select）。
 * 全部配置即改即存于本地浏览器。
 */

import { useEffect, useRef, useState } from "react";
import { Download, RotateCcw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { exportSession } from "@/lib/export";
import { store, DEFAULT_INSTRUCTIONS, type AppSettings, type Session } from "@/lib/store";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppSettings;
  onSettingsChange: (patch: Partial<AppSettings>) => void;
}

export function SettingsDialog({ open, onOpenChange, settings, onSettingsChange }: Props) {
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) onSettingsChange({}); // 触发外部与最新设置同步
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportAll = () => {
    const payload = { app: "oc2webapi", version: 1, exportedAt: new Date().toISOString(), sessions: store.sessions };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "oc2webapi-sessions-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const importAll = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text());
      const sessions = Array.isArray(payload) ? payload : payload.sessions;
      if (!Array.isArray(sessions)) throw new Error("格式不正确");
      const imported = store.importSessions(sessions as Session[]);
      onSettingsChange({});
      toast.success(`已导入 ${imported} 个会话`);
    } catch (err) {
      toast.error("导入失败：" + (err instanceof Error ? err.message : String(err)));
    }
  };

  const clearAll = () => {
    if (!confirm("确定删除本地全部对话？此操作不可恢复。")) return;
    store.clearAll();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>全部配置只保存在你的浏览器本地。</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2.5">
            <Label>请求通道</Label>
            <p className="text-xs text-muted-foreground">
              OpenCode 推理接口未开放 CORS：「自动」先尝试浏览器直连（真实用户 IP），失败后走中转。
            </p>
            <Select value={settings.transportMode} onValueChange={(v) => onSettingsChange({ transportMode: v as AppSettings["transportMode"] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动（推荐）</SelectItem>
                <SelectItem value="direct">仅直连</SelectItem>
                <SelectItem value="relay">仅中转</SelectItem>
              </SelectContent>
            </Select>
          </section>

          <section className="space-y-2.5">
            <Label htmlFor="relay-base">中转地址</Label>
            <Input
              id="relay-base"
              type="url"
              placeholder="默认同源 /api（Vercel Edge 函数）"
              defaultValue={settings.relayBase}
              onBlur={(e) => onSettingsChange({ relayBase: e.target.value.trim() })}
            />
            <p className="text-xs text-muted-foreground">可指向任意自建中转（需放行 /inference/* 与 /zen/* 路径并回传流式响应）。</p>
          </section>

          <section className="space-y-2.5">
            <Label htmlFor="api-key">OpenCode Key（选填）</Label>
            <Input
              id="api-key"
              type="password"
              placeholder="留空使用匿名免费通道（Bearer public）"
              defaultValue={settings.apiKey}
              onBlur={(e) => onSettingsChange({ apiKey: e.target.value.trim() })}
            />
            <p className="text-xs text-muted-foreground">填入 Zen / Go Key 可绕过免费额度限制，仅保存在本地浏览器。</p>
          </section>

          <section className="space-y-2.5">
            <Label htmlFor="custom-instructions">自定义指令（追加在官方提示词之后）</Label>
            <Textarea
              id="custom-instructions"
              rows={6}
              defaultValue={settings.customInstructions}
              onBlur={(e) => onSettingsChange({ customInstructions: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              免费档强制要求官方 OpenCode CLI 系统提示词，你的指令会接在其后。
            </p>
            <Button variant="outline" size="sm" onClick={() => onSettingsChange({ customInstructions: DEFAULT_INSTRUCTIONS })}>
              <RotateCcw className="size-3.5" /> 恢复默认
            </Button>
          </section>

          <Separator />

          <section className="space-y-2.5">
            <Label>数据</Label>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={exportAll}>
                <Download className="size-3.5" /> 导出全部会话 (JSON)
              </Button>
              <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
                <Upload className="size-3.5" /> 导入会话 (JSON)
              </Button>
              <Button variant="outline" size="sm" className="text-destructive" onClick={clearAll}>
                <Trash2 className="size-3.5" /> 清空全部对话
              </Button>
            </div>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void importAll(file);
              }}
            />
          </section>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// 供外部（如设置外的导出入口）复用的单会话导出包装
export { exportSession };
