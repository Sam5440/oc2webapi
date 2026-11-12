/**
 * oc2webapi — 侧栏（shadcn Sidebar）：会话列表 + 数据操作入口。
 */

import { useState } from "react";
import { MessageSquarePlus, Moon, Pin, PinOff, Pencil, Settings, Sun, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Session } from "@/lib/store";

interface Props {
  sessions: Session[];
  activeId: string;
  theme: "auto" | "light" | "dark";
  busy: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}

export function AppSidebar(props: Props) {
  const { sessions, activeId } = props;
  const pinned = sessions.filter((s) => s.pinned);
  const rest = sessions.filter((s) => !s.pinned);

  return (
    <TooltipProvider>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="gap-2 p-3">
          <div className="flex items-center gap-2 px-1">
            <span className="rounded-lg bg-primary px-2 py-0.5 font-mono text-[13px] font-bold text-primary-foreground">oc2</span>
            <span className="text-[15px] font-semibold">oc2webapi</span>
            <Badge variant="outline" className="ml-auto text-[10px]">
              shadcn/ui
            </Badge>
          </div>
          <Button onClick={props.onNewChat} disabled={props.busy} className="justify-start">
            <MessageSquarePlus className="size-4" /> 新对话
          </Button>
        </SidebarHeader>

        <SidebarContent>
          {pinned.length > 0 && (
            <SidebarGroup>
              <SidebarGroupLabel>已置顶</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{pinned.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeId} {...props} />)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
          <SidebarGroup>
            <SidebarGroupLabel>全部对话</SidebarGroupLabel>
            <SidebarGroupContent>
              {sessions.length === 0 ? (
                <p className="px-2 py-4 text-center text-xs text-muted-foreground">还没有对话，点上方「新对话」开始</p>
              ) : (
                <SidebarMenu>{rest.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeId} {...props} />)}</SidebarMenu>
              )}
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="gap-2 p-3">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={props.onOpenSettings}>
              <Settings className="size-4" /> 设置
            </Button>
            <Button variant="outline" size="sm" onClick={props.onToggleTheme} title="切换主题">
              {props.theme === "dark" ? <Moon className="size-4" /> : props.theme === "light" ? <Sun className="size-4" /> : <Sun className="size-4" />}
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>
    </TooltipProvider>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
  onPin,
  onRename,
}: Props & { session: Session; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  const commit = () => {
    setEditing(false);
    const value = draft.trim();
    if (value && value !== session.title) onRename(session.id, value);
    else setDraft(session.title);
  };

  return (
    <SidebarMenuItem>
      {editing ? (
        <Input
          autoFocus
          className="h-8 text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(session.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <>
          <SidebarMenuButton isActive={active} onClick={() => onSelect(session.id)} tooltip={session.title}>
            <span className="min-w-0 flex-1 truncate text-left">{session.pinned ? "📌 " : ""}{session.title || "新对话"}</span>
          </SidebarMenuButton>
          <div className="absolute right-1.5 hidden gap-0.5 group-hover/menu-item:flex">
            <SidebarMenuAction onClick={() => onPin(session.id, !session.pinned)} title={session.pinned ? "取消置顶" : "置顶"}>
              {session.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </SidebarMenuAction>
            <SidebarMenuAction onClick={() => { setDraft(session.title); setEditing(true); }} title="重命名">
              <Pencil className="size-3.5" />
            </SidebarMenuAction>
            <SidebarMenuAction
              onClick={() => {
                if (confirm(`删除「${session.title || "新对话"}」？`)) onDelete(session.id);
              }}
              title="删除"
              className="text-destructive"
            >
              <Trash2 className="size-3.5" />
            </SidebarMenuAction>
          </div>
        </>
      )}
    </SidebarMenuItem>
  );
}
