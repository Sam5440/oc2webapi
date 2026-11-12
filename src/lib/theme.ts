/**
 * oc2webapi — 主题（亮 / 暗 / 跟随系统）。
 * shadcn 以 <html> 上的 .dark 类驱动暗色变量。
 */

import type { AppSettings } from "./store";

export type ThemeMode = AppSettings["theme"];

let mediaBound = false;

export function applyTheme(mode: ThemeMode): () => void {
  const resolve = () =>
    mode === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;

  const apply = () => {
    const resolved = resolve();
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  };

  apply();
  if (!mediaBound) {
    mediaBound = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      // 仅当处于 auto 时跟随系统（由 App 在 settings 变化时重新 applyTheme，
      // 这里直接读当前 settings 会造成循环依赖，改为读取 data-theme-mode）
      if (document.documentElement.dataset.themeMode === "auto") apply();
    });
  }
  document.documentElement.dataset.themeMode = mode;
  return apply;
}
