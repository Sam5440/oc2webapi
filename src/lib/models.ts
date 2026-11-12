/**
 * oc2webapi — 模型目录。
 *
 * /v1/models 是 GET 接口、上游完全开放 CORS，因此任何通道模式下都直接从
 * 浏览器获取（模型列表这一步始终是真实用户 IP）。结果缓存 6 小时。
 */

import * as transport from "./transport";
import { isFreeModel, type ModelRecord } from "./oc";
import { store } from "./store";

let inflight: Promise<ModelRecord[]> | null = null;

export async function getModels(opts: { force?: boolean } = {}): Promise<ModelRecord[]> {
  if (!opts.force) {
    const cached = store.getCachedModels() as ModelRecord[] | null;
    if (cached) return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const settings = transport.loadTransportSettings(store.getSettings() as never);
    const list = await transport.fetchModels(settings.relayBase);
    const usable = list.filter((m) => m && typeof m.id === "string" && (m as ModelRecord).type !== "embedding") as ModelRecord[];
    store.saveModels(usable);
    return usable;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface ModelGroups {
  free: ModelRecord[];
  others: ModelRecord[];
}

/** 排序：免费模型在前，其余按名称。 */
export function groupModels(list: ModelRecord[]): ModelGroups {
  const free: ModelRecord[] = [];
  const others: ModelRecord[] = [];
  for (const model of list) {
    (isFreeModel(model) ? free : others).push(model);
  }
  const byName = (a: ModelRecord, b: ModelRecord) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id));
  free.sort(byName);
  others.sort(byName);
  return { free, others };
}

/** 默认模型：优先 GLM-5.3-Flash Free / MiniMax M3.1，否则第一个免费模型。 */
export function pickDefaultModel(list: ModelRecord[]): string {
  const free = list.filter((m) => /free/i.test(m.id));
  if (!free.length) return list[0]?.id ?? "";
  const preferred = free.find((m) => m.id === "glm-5.3-flash-free") || free.find((m) => m.id === "minimax-m3.1-flash-free") || free[0];
  return preferred.id;
}
