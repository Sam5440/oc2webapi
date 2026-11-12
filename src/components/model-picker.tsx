/**
 * oc2webapi — 模型选择器（shadcn Popover + Command 组合框）。
 * 免费模型与需 Key 模型分组展示，带搜索与能力徽章。
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isFreeModel, type ModelRecord } from "@/lib/oc";
import { groupModels } from "@/lib/models";
import { cn } from "@/lib/utils";

function contextLimit(model: ModelRecord): string | null {
  const context = model.limit?.context;
  if (!context) return null;
  return Math.round(context / 1000) + "K";
}

export function ModelPicker({
  models,
  currentModel,
  loading,
  onSelect,
}: {
  models: ModelRecord[];
  currentModel: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = useMemo(() => models.find((m) => m.id === currentModel), [models, currentModel]);
  const groups = useMemo(() => groupModels(models), [models]);

  const renderGroup = (title: string, list: ModelRecord[]) => {
    if (!list.length) return null;
    return (
      <CommandGroup heading={title}>
        {list.map((model) => (
          <CommandItem
            key={model.id}
            value={`${model.name || ""} ${model.id}`}
            onSelect={() => {
              setOpen(false);
              onSelect(model.id);
            }}
            className="items-center gap-2"
          >
            <Check className={cn("size-4 shrink-0", model.id === currentModel ? "opacity-100" : "opacity-0")} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{model.name || model.id}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{model.id}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isFreeModel(model) ? <Badge className="bg-primary/10 text-primary">免费</Badge> : null}
              {model.capabilities?.reasoning?.supported ? <Badge variant="secondary">推理</Badge> : null}
              {contextLimit(model) ? <Badge variant="outline">{contextLimit(model)}</Badge> : null}
            </div>
          </CommandItem>
        ))}
      </CommandGroup>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="max-w-[46vw] justify-between font-normal">
          <span className="truncate">
            {loading ? "加载模型中…" : (current?.name || currentModel || "选择模型")}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[430px] max-w-[92vw] p-0">
        <Command>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <CommandInput placeholder="搜索模型…" className="pl-8" />
          </div>
          <CommandList className="max-h-[50vh]">
            <CommandEmpty>没有匹配的模型</CommandEmpty>
            {renderGroup("免费模型", groups.free)}
            {renderGroup("其他模型（需 Key）", groups.others)}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
