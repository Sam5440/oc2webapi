/**
 * oc2webapi — 应用装配：store 订阅、模型加载、对话引擎回调、主题、路由级布局。
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/app-sidebar";
import { ChatView } from "@/components/chat-view";
import { Composer } from "@/components/composer";
import { ExportMenu } from "@/components/export-menu";
import { ModelPicker } from "@/components/model-picker";
import { SettingsDialog } from "@/components/settings-dialog";
import { Badge } from "@/components/ui/badge";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ChatEngine } from "@/lib/chat";
import { getModels, pickDefaultModel } from "@/lib/models";
import { applyTheme } from "@/lib/theme";
import { listenQuotaErrors, store, type AppSettings } from "@/lib/store";
import type { ModelRecord } from "@/lib/oc";

const TRANSPORT_LABEL: Record<AppSettings["transportMode"], string> = {
  auto: "通道：自动",
  direct: "通道：仅直连",
  relay: "通道：仅中转",
};

const TRANSPORT_TIP: Record<AppSettings["transportMode"], string> = {
  auto: "自动：优先浏览器直连（用户 IP），CORS 失败自动回退中转",
  direct: "仅直连：请求始终从浏览器发出（需要 CORS 放行环境）",
  relay: "仅中转：请求经中转函数转发到 OpenCode",
};

export default function App() {
  // ---- 全局状态 ----
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [settings, setSettingsState] = useState<AppSettings>(() => store.getSettings());
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 流式渲染节流：引擎每帧最多触发一次重渲染
  const [streamTick, setStreamTick] = useState(0);
  const rafPending = useRef(false);

  const engineRef = useRef(new ChatEngine());
  const inputRef = useRef("");

  // ---- 引擎回调（ref 稳定，避免重挂引擎） ----
  const engineCallbacks = useRef({
    onTurnStart: () => setBusy(true),
    onDelta: () => bumpStream(),
    onToolRound: (_s: unknown, _m: unknown, round: number) => {
      toast.info(`模型尝试调用工具（第 ${round} 轮），网页端不执行工具，已自动请求纯文字回答…`, { duration: 5000 });
    },
    onTurnEnd: (_s: unknown, message: { error?: { limited?: boolean } | null }) => {
      setBusy(false);
      if (message.error?.limited) {
        toast.error("免费额度提示", {
          description:
            "OpenCode 免费通道按出口 IP 限额，当前网络/中转出口的额度可能已耗尽。可稍后再试、切换网络、在设置中填入自己的 Key，或参考 README 自建中转。",
          duration: 12000,
        });
      }
    },
  }).current;

  const activeSession = state.sessions.find((s) => s.id === state.activeId) ?? null;

  const patchSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettingsState(store.saveSettings(patch));
  }, []);

  const bumpStream = useCallback(() => {
    if (rafPending.current) return;
    rafPending.current = true;
    requestAnimationFrame(() => {
      rafPending.current = false;
      setStreamTick((t) => t + 1);
    });
  }, []);

  // ---- 主题 ----
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // ---- 模型目录 ----
  useEffect(() => {
    let cancelled = false;
    getModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        // 尚未选过模型时挑选默认模型，并同步到活跃会话
        if (list.length && !store.getSettings().currentModel) {
          const modelId = pickDefaultModel(list);
          patchSettings({ currentModel: modelId });
        }
        const active = store.getActive();
        if (active && !active.model && store.getSettings().currentModel) {
          store.update(active.id, { model: store.getSettings().currentModel });
        }
      })
      .catch((err) => {
        if (!cancelled) toast.error(`模型列表获取失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patchSettings]);

  // ---- 存储配额错误 ----
  useEffect(() => listenQuotaErrors(() => {
    toast.warning("本地存储空间不足，较早的对话可能无法保存。请导出后清理旧会话。");
  }), []);

  // ---- 首次访问提示 ----
  useEffect(() => {
    try {
      if (!localStorage.getItem("oc2webapi.visited")) {
        localStorage.setItem("oc2webapi.visited", "1");
        toast.info("欢迎使用 oc2webapi", {
          description:
            "请求默认由你的浏览器直连 OpenCode（用户 IP），CORS 受限时自动经同源中转转发；对话仅保存在你的浏览器本地。",
          duration: 9000,
        });
      }
    } catch {
      /* 忽略存储失败 */
    }
  }, []);

  // ---- 会话操作 ----
  const ensureActiveSession = useCallback((): NonNullable<typeof activeSession> => {
    let session = store.getActive();
    if (!session) {
      session = store.createSession({ model: store.getSettings().currentModel });
    }
    return session;
  }, []);

  const handleNewChat = useCallback(() => {
    store.createSession({ model: store.getSettings().currentModel });
  }, []);

  const handleModelChange = useCallback(
    (modelId: string) => {
      const active = store.getActive();
      if (!active) return;
      store.update(active.id, { model: modelId });
      patchSettings({ currentModel: modelId });
    },
    [patchSettings],
  );

  const handleRegenerate = useCallback(() => {
    const session = store.getActive();
    if (!session || engineRef.current.busy) return;
    void engineRef.current.regenerate({ sessionId: session.id, callbacks: engineCallbacks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = useCallback(() => {
    if (engineRef.current.busy) return;
    const text = inputRef.current.trim();
    if (!text) return;
    const session = ensureActiveSession();
    if (!session.model) {
      toast.warning("请先在顶部选择一个模型。");
      return;
    }
    inputRef.current = "";
    setInput("");
    void engineRef.current.send({ sessionId: session.id, text, callbacks: engineCallbacks });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureActiveSession]);

  const inputRefSync = (value: string) => {
    inputRef.current = value;
    setInput(value);
  };

  const cycleTheme = () => {
    const order: AppSettings["theme"][] = ["auto", "light", "dark"];
    const next = order[(order.indexOf(settings.theme) + 1) % order.length];
    patchSettings({ theme: next });
  };

  return (
    <SidebarProvider>
      <AppSidebar
        sessions={store.orderedSessions()}
        activeId={state.activeId}
        theme={settings.theme}
        busy={busy}
        onSelect={(id) => store.setActive(id)}
        onNewChat={handleNewChat}
        onDelete={(id) => {
          store.remove(id);
          if (!store.getActive()) ensureActiveSession();
        }}
        onPin={(id, pinned) => store.update(id, { pinned })}
        onRename={(id, title) => store.update(id, { title })}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleTheme={cycleTheme}
      />
      <SidebarInset className="flex h-svh flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur">
          <SidebarTrigger />
          <ModelPicker
            models={models}
            currentModel={activeSession?.model ?? settings.currentModel}
            loading={modelsLoading}
            onSelect={handleModelChange}
          />
          <div className="ml-auto flex items-center gap-2">
            <Badge variant="outline" className="hidden text-[11px] text-muted-foreground sm:inline-flex" title={TRANSPORT_TIP[settings.transportMode]}>
              {TRANSPORT_LABEL[settings.transportMode]}
            </Badge>
            <ExportMenu session={activeSession} />
          </div>
        </header>

        <ChatView
          streamTick={streamTick /* 流式期间驱动重渲染；消息组件按内容指纹 memo */}
          session={activeSession}
          busy={busy}
          onRegenerate={handleRegenerate}
          onSuggestion={(text) => {
            inputRefSync(text);
            handleSend();
          }}
        />

        <Composer value={input} onChange={inputRefSync} busy={busy} onSend={handleSend} onStop={() => engineRef.current.stop()} />
      </SidebarInset>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={patchSettings}
      />
    </SidebarProvider>
  );
}
