import { useEffect, useRef, useState } from "react";
import { desktopHost, positionNative } from "../browserHost";

export function useNativeViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktopHost) return;
    let frame = 0;
    let previous = "";
    let disposed = false;
    let queue = Promise.resolve();
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = ref.current;
        const overlay = [
          ...document.querySelectorAll<HTMLElement>(
            ".ant-modal-wrap, .ant-drawer-open, .ant-image-preview",
          ),
        ].some((node) => node.getClientRects().length > 0);
        const visible =
          enabled &&
          !document.hidden &&
          !overlay &&
          Boolean(element?.getClientRects().length);
        const box = element?.getBoundingClientRect();
        const key = JSON.stringify([
          visible,
          box?.x,
          box?.y,
          box?.width,
          box?.height,
        ]);
        if (key === previous) return;
        previous = key;
        queue = queue.then(async () => {
          if (disposed) return;
          try {
            await positionNative(element, visible);
            if (!disposed) setError("");
          } catch {
            if (!disposed) setError("內嵌網頁位置同步失敗，請切換檢視後再試。");
          }
        });
      });
    };
    const resize = new ResizeObserver(update);
    if (ref.current) resize.observe(ref.current);
    const mutation = new MutationObserver(update);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void positionNative(null, false).catch(() => {});
    };
  }, [enabled]);
  return { ref, error };
}
