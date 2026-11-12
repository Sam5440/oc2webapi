/**
 * oc2webapi — 导出菜单（shadcn DropdownMenu）。
 */

import { Download, FileCode2, FileText, Printer, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { exportSession } from "@/lib/export";
import type { Session } from "@/lib/store";

const FORMATS: { format: "md" | "html" | "txt" | "print"; label: string; icon: typeof FileText }[] = [
  { format: "md", label: "Markdown (.md)", icon: FileText },
  { format: "html", label: "HTML 文档 (.html)", icon: FileCode2 },
  { format: "txt", label: "纯文本 (.txt)", icon: ScrollText },
  { format: "print", label: "打印 / PDF", icon: Printer },
];

export function ExportMenu({ session, disabled }: { session: Session | null; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || !session}>
          <Download className="size-4" /> 导出
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {FORMATS.map(({ format, label, icon: Icon }) => (
          <DropdownMenuItem key={format} onClick={() => session && exportSession(session, format)}>
            <Icon className="size-4" /> {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
