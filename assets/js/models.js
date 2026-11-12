/**
 * oc2webapi — 模型目录。
 *
 * /v1/models 是 GET 接口、上游完全开放 CORS，因此任何通道模式下都直接从
 * 浏览器获取（这也意味着模型列表这一步始终是真实用户 IP）。结果缓存 6 小时。
 */

import * as transport from './transport.js';
import { store } from './store.js';
import { isFreeModel } from './oc.js';

let inflight = null;

export async function getModels({ force = false } = {}) {
  if (!force) {
    const cached = store.getCachedModels();
    if (cached) return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    const settings = transport.loadTransportSettings(store);
    const list = await transport.fetchModels({ relayBase: settings.relayBase });
    const usable = list.filter((m) => m && m.id && m.type !== 'embedding');
    store.saveModels(usable);
    return usable;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 排序：免费模型在前，其余按名称；返回 { free, others } 两组。 */
export function groupModels(list) {
  const free = [];
  const others = [];
  for (const model of list) {
    (isFreeModel(model) ? free : others).push(model);
  }
  const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id));
  free.sort(byName);
  others.sort(byName);
  return { free, others };
}
