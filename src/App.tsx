import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  ConfigProvider,
  Drawer,
  Spin,
  Tooltip,
} from "antd";
import zhTW from "antd/locale/zh_TW";
import {
  CommentOutlined,
  DesktopOutlined,
  LayoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useWorkspace } from "./hooks/useWorkspace";
import {
  AppSidebar,
  ConversationHistory,
  NAVIGATION,
} from "./components/AppSidebar";
import type { Navigation } from "./components/AppSidebar";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import type { WorkspaceView } from "./components/WorkspaceLayout";
import { CreateTaskModal } from "./components/CreateTaskModal";
import { SaveWorkflowModal } from "./components/SaveWorkflowModal";
import { connectEmbedded, desktopHost, nativeHostInfo } from "./browserHost";
import "@fontsource-variable/manrope/index.css";
import "./App.css";
import "./Workspace.css";

const RecordsPage = lazy(() =>
  import("./components/RecordsPage").then((module) => ({
    default: module.RecordsPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const WorkflowsPage = lazy(() =>
  import("./components/WorkflowsPage").then((module) => ({
    default: module.WorkflowsPage,
  })),
);
const LAYOUT_KEY = "pilotry:layout:v1";

function initialLayout(): { collapsed: boolean; view: WorkspaceView } {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    return {
      collapsed: saved.collapsed !== false,
      view: ["split", "chat", "browser"].includes(saved.view)
        ? saved.view
        : "split",
    };
  } catch {
    return { collapsed: true, view: "split" };
  }
}

function AppShell() {
  const workspace = useWorkspace();
  const nativeStarted = useRef(false);
  useEffect(() => {
    if (
      !desktopHost ||
      !workspace.online ||
      workspace.checking ||
      nativeStarted.current
    )
      return;
    nativeStarted.current = true;
    if (workspace.browser.connected || workspace.browser.runtime?.id !== "auto")
      return;
    void nativeHostInfo()
      .then(async (info) => {
        if (info?.available) {
          workspace.setBrowser(await connectEmbedded());
          await workspace.refresh();
        }
      })
      .catch(() => {});
  }, [
    workspace.online,
    workspace.checking,
    workspace.browser.connected,
    workspace.browser.runtime?.id,
    workspace.setBrowser,
    workspace.refresh,
  ]);
  const [nav, setNav] = useState<Navigation>("workspace");
  const [layout, setLayout] = useState(initialLayout);
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width: 959px)").matches,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [saveFlowOpen, setSaveFlowOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const view = narrow && layout.view === "split" ? "chat" : layout.view;
  const title =
    nav === "settings"
      ? "设置"
      : NAVIGATION.find((item) => item.key === nav)?.label || "工作台";
  useEffect(() => {
    const query = matchMedia("(max-width: 959px)");
    const listener = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* 保留目前版面。 */
    }
  }, [layout]);
  const navigate = (next: Navigation) => {
    setNav(next);
    setMobileOpen(false);
    setHistoryOpen(false);
  };

  return (
    <div
      className={
        "layout-shell " + (layout.collapsed ? "is-compact" : "rail-expanded")
      }
    >
      <aside className="shell-sidebar">
        <AppSidebar
          workspace={workspace}
          nav={nav}
          collapsed={layout.collapsed}
          onNavigate={navigate}
          onHistory={() => setHistoryOpen(true)}
        />
      </aside>
      <Drawer
        placement="left"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        className="shell-nav-drawer"
        size={232}
        title="导航"
      >
        <AppSidebar
          workspace={workspace}
          nav={nav}
          collapsed={false}
          onNavigate={navigate}
          onHistory={() => setHistoryOpen(true)}
        />
      </Drawer>
      <Drawer
        placement="left"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        className="shell-history-drawer"
        size={340}
        title="对话记录"
      >
        <ConversationHistory
          workspace={workspace}
          nav={nav}
          onNavigate={navigate}
        />
      </Drawer>
      <div className="layout-main">
        <header className="layout-header">
          <Button
            type="text"
            className="rail-toggle"
            icon={
              narrow ? (
                <MenuOutlined />
              ) : layout.collapsed ? (
                <MenuUnfoldOutlined />
              ) : (
                <MenuFoldOutlined />
              )
            }
            aria-label={
              narrow ? "打开导航" : layout.collapsed ? "展开侧栏" : "收合侧栏"
            }
            onClick={() =>
              narrow
                ? setMobileOpen(true)
                : setLayout((current) => ({
                    ...current,
                    collapsed: !current.collapsed,
                  }))
            }
          />
          <div className="layout-location">
            <strong>{title}</strong>
            {nav === "workspace" && (
              <>
                <span>/</span>
                <span className="active-session-title">
                  {workspace.session.title}
                </span>
              </>
            )}
          </div>
          <div className="layout-header-actions">
            <Tooltip title={workspace.ai?.model || "模型尚未连接"}>
              <span className="layout-provider">Magpie</span>
            </Tooltip>
            <button
              className="layout-connection"
              aria-label="查看服务连接状态"
              onClick={() => navigate("settings")}
            >
              <i
                className={
                  "status-dot " +
                  (workspace.online && workspace.agentOnline ? "online" : "")
                }
              />
              <span>
                {workspace.checking
                  ? "连接中"
                  : workspace.runningId
                    ? "执行中"
                    : workspace.online && workspace.agentOnline
                      ? "已连接"
                      : "未连接"}
              </span>
            </button>
            {nav === "workspace" && (
              <div
                className="workspace-view-switch"
                role="group"
                aria-label="工作区查看"
              >
                {(
                  [
                    {
                      key: "chat",
                      label: "对话",
                      name: "专注对话",
                      icon: <CommentOutlined />,
                    },
                    {
                      key: "split",
                      label: "分屏",
                      name: "分屏查看",
                      icon: <LayoutOutlined />,
                    },
                    {
                      key: "browser",
                      label: "浏览器",
                      name: "专注浏览器",
                      icon: <DesktopOutlined />,
                    },
                  ] as const
                )
                  .filter((item) => !narrow || item.key !== "split")
                  .map((item) => (
                    <button
                      key={item.key}
                      aria-label={item.name}
                      aria-pressed={view === item.key}
                      onClick={() =>
                        setLayout((current) => ({ ...current, view: item.key }))
                      }
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
              </div>
            )}
            <Button
              className="header-new-task"
              icon={<PlusOutlined />}
              aria-label="新增任务"
              disabled={!workspace.online}
              onClick={() => setCreateOpen(true)}
            >
              <span>新增任务</span>
            </Button>
          </div>
        </header>
        <main
          className={
            "layout-content " +
            (nav === "workspace" ? "workspace-route" : "page-route")
          }
        >
          <div className="workspace-host" hidden={nav !== "workspace"}>
            <h1 className="visually-hidden">对话工作台</h1>
            {!workspace.checking &&
              (!workspace.online || !workspace.agentOnline) && (
                <Alert
                  className="layout-connection-alert"
                  type="warning"
                  showIcon
                  title={
                    !workspace.online ? "本机引擎未连接" : "流式服务未连接"
                  }
                  action={
                    <Button size="small" onClick={() => navigate("settings")}>
                      检查设置
                    </Button>
                  }
                />
              )}
            <WorkspaceLayout
              workspace={workspace}
              view={view}
              active={nav === "workspace"}
              onSave={() => setSaveFlowOpen(true)}
              onSettings={() => navigate("settings")}
            />
          </div>
          {nav !== "workspace" && (
            <Suspense
              fallback={
                <div className="page-loading">
                  <Spin />
                </div>
              }
            >
              {nav === "workflows" ? (
                <WorkflowsPage
                  workspace={workspace}
                  onWorkspace={() => navigate("workspace")}
                />
              ) : nav === "settings" ? (
                <SettingsPage workspace={workspace} />
              ) : (
                <RecordsPage
                  key={nav}
                  workspace={workspace}
                  kind={nav}
                  onCreate={() => setCreateOpen(true)}
                  onWorkspace={() => navigate("workspace")}
                />
              )}
            </Suspense>
          )}
          {workspace.loadError && nav !== "workspace" && (
            <Alert
              className="sync-alert"
              type="warning"
              title={workspace.loadError}
              showIcon
            />
          )}
        </main>
      </div>
      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workspace={workspace}
      />
      <SaveWorkflowModal
        open={saveFlowOpen}
        onClose={() => setSaveFlowOpen(false)}
        workspace={workspace}
      />
    </div>
  );
}

export default function App() {
  return (
    <ConfigProvider
      locale={zhTW}
      theme={{
        token: {
          colorPrimary: "#a2d8be",
          colorInfo: "#399c7e",
          colorSuccess: "#399c7e",
          colorText: "#263630",
          colorTextSecondary: "#738078",
          colorBorder: "#e2e8e5",
          colorBgLayout: "#f7f9f8",
          borderRadius: 8,
          controlHeight: 36,
          fontFamily:
            "'Manrope Variable', 'Microsoft JhengHei', 'PingFang TC', sans-serif",
          fontSize: 14,
        },
        components: {
          Button: {
            primaryColor: "#24573f",
            primaryShadow: "none",
            defaultShadow: "none",
            fontWeight: 600,
          },
          Table: { headerBg: "#f8faf9", cellPaddingBlock: 16 },
          Modal: { titleFontSize: 20 },
          Input: { activeShadow: "0 0 0 3px #399c7e12" },
        },
      }}
    >
      <AntApp>
        <AppShell />
      </AntApp>
    </ConfigProvider>
  );
}
