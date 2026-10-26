import { Button, Popconfirm, Tooltip } from "antd";
import {
  AppstoreOutlined,
  CommentOutlined,
  DeleteOutlined,
  DesktopOutlined,
  HistoryOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  SettingOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { Workspace } from "../hooks/useWorkspace";
import { PilotryMark } from "./Brand";

export type Navigation =
  | "workspace"
  | "workflows"
  | "tasks"
  | "orders"
  | "settings";
export const NAVIGATION = [
  { key: "workspace" as const, label: "工作台", icon: <AppstoreOutlined /> },
  { key: "workflows" as const, label: "流程库", icon: <NodeIndexOutlined /> },
  { key: "tasks" as const, label: "任务管理", icon: <UnorderedListOutlined /> },
];

export function ConversationHistory({
  workspace,
  nav,
  onNavigate,
}: {
  workspace: Workspace;
  nav: Navigation;
  onNavigate: (nav: Navigation) => void;
}) {
  const sessions = workspace.sessions.filter((item) => item.messages.length);
  return (
    <div className="shell-history-list">
      {sessions.length ? (
        sessions.map((item) => (
          <div className="shell-history-entry" key={item.id}>
            <Tooltip title={item.title} placement="right">
              <button
                className={
                  workspace.activeId === item.id && nav === "workspace"
                    ? "active"
                    : ""
                }
                onClick={() => {
                  workspace.setActiveId(item.id);
                  onNavigate("workspace");
                }}
              >
                <CommentOutlined />
                <span>{item.title}</span>
                {workspace.runningId === item.id && (
                  <i className="status-dot online pulsing" />
                )}
              </button>
            </Tooltip>
            <Popconfirm
              title="删除这段对话？"
              description="对话及执行记录会从此设备移除。"
              okText="删除"
              cancelText="取消"
              onConfirm={() => workspace.removeSession(item.id)}
            >
              <button
                className="shell-history-delete"
                disabled={!!workspace.runningId}
                aria-label={"删除对话：" + item.title}
              >
                <DeleteOutlined />
              </button>
            </Popconfirm>
          </div>
        ))
      ) : (
        <p className="shell-history-empty">尚无对话记录</p>
      )}
    </div>
  );
}

export function AppSidebar({
  workspace,
  nav,
  collapsed,
  onNavigate,
  onHistory,
}: {
  workspace: Workspace;
  nav: Navigation;
  collapsed: boolean;
  onNavigate: (nav: Navigation) => void;
  onHistory: () => void;
}) {
  return (
    <div className={"shell-sidebar-content " + (collapsed ? "is-compact" : "")}>
      <a
        className="shell-brand"
        href="#workspace"
        aria-label="Pilotry 工作台"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("workspace");
        }}
      >
        <PilotryMark />
        {!collapsed && (
          <span>
            <b>Pilotry</b>
          </span>
        )}
      </a>
      <Tooltip title={collapsed ? "新增对话" : ""} placement="right">
        <Button
          type="primary"
          className="shell-new-chat"
          aria-label="新增对话"
          icon={<PlusOutlined />}
          disabled={!!workspace.runningId}
          onClick={() => {
            workspace.createSession();
            onNavigate("workspace");
          }}
        >
          {!collapsed && "新增对话"}
        </Button>
      </Tooltip>
      <nav className="shell-navigation" aria-label="主要导航">
        {NAVIGATION.map((item) => (
          <Tooltip
            key={item.key}
            title={collapsed ? item.label : ""}
            placement="right"
          >
            <button
              aria-label={item.label}
              aria-current={nav === item.key ? "page" : undefined}
              className={nav === item.key ? "selected" : ""}
              onClick={() => onNavigate(item.key)}
            >
              {item.icon}
              {!collapsed && <span>{item.label}</span>}
            </button>
          </Tooltip>
        ))}
      </nav>
      {collapsed ? (
        <Tooltip title="对话记录" placement="right">
          <button
            className="shell-history-toggle"
            aria-label="打开对话记录"
            onClick={onHistory}
          >
            <HistoryOutlined />
          </button>
        </Tooltip>
      ) : (
        <>
          <div className="shell-history-heading">
            <span>对话记录</span>
            <span>
              {workspace.sessions.filter((item) => item.messages.length).length}
            </span>
          </div>
          <ConversationHistory
            workspace={workspace}
            nav={nav}
            onNavigate={onNavigate}
          />
        </>
      )}
      <div className="shell-sidebar-bottom">
        <Tooltip title={collapsed ? "设置" : ""} placement="right">
          <button
            aria-label="设置"
            className={
              "shell-settings " + (nav === "settings" ? "selected" : "")
            }
            onClick={() => onNavigate("settings")}
          >
            <SettingOutlined />
            {!collapsed && <span>设置</span>}
          </button>
        </Tooltip>
        <Tooltip
          title={workspace.online ? "本机引擎已连接" : "本机引擎未连接"}
          placement="right"
        >
          <div className="shell-engine">
            <i className={"status-dot " + (workspace.online ? "online" : "")} />
            {!collapsed && (
              <>
                <DesktopOutlined />
                <span>本机工作空间</span>
              </>
            )}
          </div>
        </Tooltip>
      </div>
    </div>
  );
}
