import { invoke, isTauri } from "@tauri-apps/api/core";
import { api } from "./api";

export const desktopHost = isTauri();
export interface NativeHostInfo {
  available: boolean;
  endpoint: string;
  marker: string;
}
export async function nativeHostInfo() {
  return desktopHost ? invoke<NativeHostInfo>("native_browser_info") : null;
}
export async function connectEmbedded() {
  const info = await invoke<NativeHostInfo>("native_browser_open");
  const deadline = Date.now() + 8000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await api.browserTargets(info.endpoint);
      const target = targets.find((item) => item.url === info.marker);
      if (target)
        return await api.configureBrowser({
          id: "embedded",
          endpoint: info.endpoint,
          targetId: target.id,
        });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("内嵌网页尚未就绪，请稍后再试。");
}

export function positionNative(element: HTMLElement | null, visible: boolean) {
  const box = element?.getBoundingClientRect();
  return invoke("native_browser_layout", {
    x: Math.max(0, box?.x ?? 0),
    y: Math.max(0, box?.y ?? 0),
    width: Math.max(1, box?.width ?? 1),
    height: Math.max(1, box?.height ?? 1),
    visible: visible && Boolean(box?.width && box?.height),
  });
}
