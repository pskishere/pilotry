import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  RightOutlined,
} from "@ant-design/icons";
import type { Workspace } from "../hooks/useWorkspace";
import { ActivityPanel } from "./ActivityPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ChatPanel } from "./ChatPanel";

export type WorkspaceView = "split" | "chat" | "browser";
type DockView = "browser" | "activity" | "page";
const RATIO_KEY = "pilotry:chat-width:v1";
const clamp = (value: number) => Math.max(40, Math.min(75, value));

export function WorkspaceLayout({
  workspace,
  view,
  onSave,
  onSettings,
  active = true,
}: {
  workspace: Workspace;
  view: WorkspaceView;
  onSave: () => void;
  onSettings: () => void;
  active?: boolean;
}) {
  const [dock, setDock] = useState<DockView>("browser");
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(RATIO_KEY));
      return saved >= 40 && saved <= 75 ? saved : 60;
    } catch {
      return 60;
    }
  });
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const liveRatio = useRef(ratio);
  const persist = (value: number) => {
    setRatio(value);
    liveRatio.current = value;
    try {
      localStorage.setItem(RATIO_KEY, String(value));
    } catch {
      /* 保留目前版面。 */
    }
  };
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !container.current) return;
    const bounds = container.current.getBoundingClientRect();
    if (bounds.width < 1) return;
    liveRatio.current = clamp(
      Math.round(((event.clientX - bounds.left) / bounds.width) * 100),
    );
    container.current.style.setProperty(
      "--chat-share",
      liveRatio.current + "%",
    );
  };
  const keyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? ratio - 2
        : event.key === "ArrowRight"
          ? ratio + 2
          : event.key === "Home"
            ? 40
            : event.key === "End"
              ? 75
              : null;
    if (next === null) return;
    event.preventDefault();
    persist(clamp(next));
  };
  const dockKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const views: DockView[] = ["browser", "activity", "page"];
    const index = views.indexOf(dock);
    const next =
      event.key === "ArrowRight"
        ? views[(index + 1) % views.length]
        : event.key === "ArrowLeft"
          ? views[(index + 2) % views.length]
          : event.key === "Home"
            ? views[0]
            : event.key === "End"
              ? views[2]
              : null;
    if (!next) return;
    event.preventDefault();
    setDock(next);
    requestAnimationFrame(() =>
      container.current
        ?.querySelector<HTMLButtonElement>(
          (next === "browser" ? ".dock-browser" : ".activity-panel") +
            " .dock-tabs button[aria-selected=true]",
        )
        ?.focus(),
    );
  };
  const tabs = (
    <div
      className="dock-tabs"
      role="tablist"
      aria-label="執行工作區"
      onKeyDown={dockKey}
    >
      {(
        [
          { key: "browser", label: "瀏覽器" },
          { key: "activity", label: "執行記錄" },
          { key: "page", label: "頁面資訊" },
        ] as const
      ).map((item) => (
        <button
          key={item.key}
          role="tab"
          tabIndex={dock === item.key ? 0 : -1}
          aria-selected={dock === item.key}
          onClick={() => setDock(item.key)}
        >
          {item.label}
          {item.key === "activity" && workspace.session.steps.length > 0 && (
            <span>{workspace.session.steps.length}</span>
          )}
        </button>
      ))}
    </div>
  );
  const latest = workspace.session.steps[workspace.session.steps.length - 1];
  const running = workspace.runningId === workspace.session.id;
  return (
    <div
      className={"workspace-layout view-" + view}
      ref={container}
      style={{ "--chat-share": ratio + "%" } as CSSProperties}
    >
      <div className="conversation-area" hidden={view === "browser"}>
        <ChatPanel
          workspace={workspace}
          onSettings={onSettings}
          visible={active && view !== "browser"}
          onSave={onSave}
        />
      </div>
      <div
        className="workspace-divider"
        role="separator"
        tabIndex={0}
        aria-label="調整對話區寬度"
        aria-orientation="vertical"
        aria-valuemin={40}
        aria-valuemax={75}
        aria-valuenow={ratio}
        hidden={view !== "split"}
        onKeyDown={keyResize}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          liveRatio.current = ratio;
          event.currentTarget.setPointerCapture(event.pointerId);
          container.current?.classList.add("is-resizing");
        }}
        onPointerMove={resize}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          resize(event);
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
          container.current?.classList.remove("is-resizing");
          persist(liveRatio.current);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          container.current?.classList.remove("is-resizing");
          persist(liveRatio.current);
        }}
      >
        <span />
      </div>
      <aside
        className="execution-area"
        hidden={view === "chat"}
        aria-label="瀏覽器與執行工作區"
      >
        <div className="dock-browser" hidden={dock !== "browser"}>
          <BrowserPanel
            workspace={workspace}
            headerTabs={tabs}
            active={active && view !== "chat" && dock === "browser"}
          />
        </div>
        {dock !== "browser" && (
          <ActivityPanel
            workspace={workspace}
            onSave={onSave}
            view={dock}
            headerTabs={tabs}
          />
        )}
        <button
          className="execution-peek"
          onClick={() => setDock(dock === "browser" ? "activity" : "browser")}
          aria-label={dock === "browser" ? "查看執行記錄" : "返回瀏覽器"}
        >
          {running ? (
            <LoadingOutlined />
          ) : latest?.status === "error" ? (
            <CloseCircleOutlined />
          ) : (
            <CheckCircleOutlined />
          )}
          <span>
            {running
              ? workspace.phase || "執行中"
              : latest
                ? latest.status === "error"
                  ? "步驟未完成"
                  : "已完成 " +
                    workspace.session.steps.filter(
                      (step) => step.status === "success",
                    ).length +
                    " 步"
                : "尚無執行記錄"}
          </span>
          <span className="execution-peek-summary">
            {latest?.summary || ""}
          </span>
          <RightOutlined />
        </button>
      </aside>
    </div>
  );
}
