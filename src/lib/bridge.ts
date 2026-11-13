/**
 * oc2webapi — 检测「浏览器直连增强」油猴脚本是否已接管 fetch。
 *
 * 脚本在 document-start 注入页面主世界，并挂上 window.__oc2CorsBridge 标记；
 * README 与本仓库 public/userscripts/ 提供安装入口。
 */

export interface CorsBridgeInfo {
  version: string;
  active: boolean;
  at?: number;
  stats?: { requests: number; bridged: number; failed: number };
}

/** 已安装并生效时返回信息，否则返回 null。 */
export function detectCorsBridge(): CorsBridgeInfo | null {
  try {
    const raw = (window as unknown as Record<string, unknown>).__oc2CorsBridge;
    if (!raw || typeof raw !== "object") return null;
    const info = raw as Partial<CorsBridgeInfo>;
    if (!info.active) return null;
    return {
      version: typeof info.version === "string" ? info.version : "unknown",
      active: true,
      at: typeof info.at === "number" ? info.at : undefined,
      stats: info.stats,
    };
  } catch {
    return null;
  }
}

/** 脚本安装地址（随站点一起部署，点击即触发油猴安装）。 */
export const CORS_BRIDGE_URL = "/userscripts/oc2webapi-cors-bridge.user.js";

/** 源码地址（便于审阅，GPL 许可）。 */
export const CORS_BRIDGE_SOURCE = "https://github.com/Sam5440/oc2webapi/blob/main/public/userscripts/oc2webapi-cors-bridge.user.js";
