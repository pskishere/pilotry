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
  { key: "workflows" as const, label: "流程庫", icon: <NodeIndexOutlined /> },
  { key: "tasks" as const, label: "任務管理", icon: <UnorderedListOutlined /> },
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
              title="刪除這段對話？"
              description="對話及執行記錄會從此裝置移除。"
              okText="刪除"
              cancelText="取消"
              onConfirm={() => workspace.removeSession(item.id)}
            >
              <button
                className="shell-history-delete"
                disabled={!!workspace.runningId}
                aria-label={"刪除對話：" + item.title}
              >
                <DeleteOutlined />
              </button>
            </Popconfirm>
          </div>
        ))
      ) : (
        <p className="shell-history-empty">尚無對話記錄</p>
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
      <Tooltip title={collapsed ? "新增對話" : ""} placement="right">
        <Button
          type="primary"
          className="shell-new-chat"
          aria-label="新增對話"
          icon={<PlusOutlined />}
          disabled={!!workspace.runningId}
          onClick={() => {
            workspace.createSession();
            onNavigate("workspace");
          }}
        >
          {!collapsed && "新增對話"}
        </Button>
      </Tooltip>
      <nav className="shell-navigation" aria-label="主要導覽">
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
        <Tooltip title="對話記錄" placement="right">
          <button
            className="shell-history-toggle"
            aria-label="開啟對話記錄"
            onClick={onHistory}
          >
            <HistoryOutlined />
          </button>
        </Tooltip>
      ) : (
        <>
          <div className="shell-history-heading">
            <span>對話記錄</span>
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
        <Tooltip title={collapsed ? "設定" : ""} placement="right">
          <button
            aria-label="設定"
            className={
              "shell-settings " + (nav === "settings" ? "selected" : "")
            }
            onClick={() => onNavigate("settings")}
          >
            <SettingOutlined />
            {!collapsed && <span>設定</span>}
          </button>
        </Tooltip>
        <Tooltip
          title={workspace.online ? "本機引擎已連線" : "本機引擎未連線"}
          placement="right"
        >
          <div className="shell-engine">
            <i className={"status-dot " + (workspace.online ? "online" : "")} />
            {!collapsed && (
              <>
                <DesktopOutlined />
                <span>本機工作空間</span>
              </>
            )}
          </div>
        </Tooltip>
      </div>
    </div>
  );
}
