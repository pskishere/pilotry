import { useState } from "react";
import { Button, Select, Switch, Tag } from "antd";
import {
  ReloadOutlined,
  ApiOutlined,
  DesktopOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import type { Workspace } from "../hooks/useWorkspace";
import { AGENT_URL, ENGINE_URL } from "../api";
import { BrowserSettings } from "./BrowserSettings";

export function SettingsPage({ workspace }: { workspace: Workspace }) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="settings-page page-enter">
      <div className="page-heading">
        <div>
          <h1>設定</h1>
          <p>管理本機連線與工作台顯示方式。</p>
        </div>
      </div>
      <BrowserSettings workspace={workspace} />
      <section className="settings-section panel">
        <div className="settings-section-title">
          <ApiOutlined />
          <div>
            <h2>服務連線</h2>
            <p>瀏覽器引擎、串流服務與模型狀態</p>
          </div>
          <Button
            icon={<ReloadOutlined />}
            loading={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await workspace.refresh();
              } finally {
                setChecking(false);
              }
            }}
          >
            檢查連線
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <strong>瀏覽器引擎</strong>
            <span>{ENGINE_URL}</span>
          </div>
          <Tag color={workspace.online ? "success" : "default"}>
            {workspace.online ? "已連線" : "未連線"}
          </Tag>
        </div>
        <div className="setting-row">
          <div>
            <strong>Agent 串流服務</strong>
            <span>{AGENT_URL} · AI SDK streamText</span>
          </div>
          <Tag color={workspace.agentOnline ? "success" : "default"}>
            {workspace.agentOnline ? "已連線" : "未連線"}
          </Tag>
        </div>
        <div className="setting-row">
          <div>
            <strong>模型</strong>
            <span>{workspace.ai?.model ?? "尚未取得模型資訊"}</span>
          </div>
          <Tag color={workspace.ai?.available ? "success" : "default"}>
            {workspace.ai?.available ? "可用" : "未連線"}
          </Tag>
        </div>
        {workspace.ai?.error && (
          <p className="settings-error" role="status">
            {workspace.ai.error}
          </p>
        )}
      </section>
      <section className="settings-section panel">
        <div className="settings-section-title">
          <ApiOutlined />
          <div>
            <h2>Agent 執行預算</h2>
            <p>限制單次工作的資源使用，不是模型使用額度</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>工具回合預算</strong>
            <span>每回合可呼叫工具；複雜任務可調高，連續失敗仍會暫停</span>
          </div>
          <Select
            aria-label="工具回合預算"
            value={workspace.preferences.agentMaxSteps}
            disabled={!!workspace.runningId}
            options={[32, 64, 128, 256].map((value) => ({
              label: `${value} 回合`,
              value,
            }))}
            onChange={(agentMaxSteps) =>
              workspace.setPreferences((value) => ({ ...value, agentMaxSteps }))
            }
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>單次執行時間</strong>
            <span>達限後保留目前頁面與記錄，可從目前位置繼續</span>
          </div>
          <Select
            aria-label="單次執行時間"
            value={workspace.preferences.agentTimeoutMinutes}
            disabled={!!workspace.runningId}
            options={[5, 15, 30, 60].map((value) => ({
              label: `${value} 分鐘`,
              value,
            }))}
            onChange={(agentTimeoutMinutes) =>
              workspace.setPreferences((value) => ({
                ...value,
                agentTimeoutMinutes,
              }))
            }
          />
        </div>
      </section>
      <section className="settings-section panel">
        <div className="settings-section-title">
          <DesktopOutlined />
          <div>
            <h2>工作台</h2>
            <p>偏好設定會保存在這台裝置</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>即時瀏覽器畫面</strong>
            <span>在工作台內顯示瀏覽器截圖</span>
          </div>
          <Switch
            aria-label="即時瀏覽器畫面"
            checked={workspace.preferences.livePreview}
            onChange={(livePreview) =>
              workspace.setPreferences((value) => ({ ...value, livePreview }))
            }
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>畫面更新間隔</strong>
            <span>較長的間隔可減少本機資源使用</span>
          </div>
          <Select
            aria-label="畫面更新間隔"
            value={workspace.preferences.frameInterval}
            disabled={!workspace.preferences.livePreview}
            options={[
              { label: "1.2 秒", value: 1200 },
              { label: "2.5 秒", value: 2500 },
              { label: "5 秒", value: 5000 },
            ]}
            onChange={(frameInterval) =>
              workspace.setPreferences((value) => ({ ...value, frameInterval }))
            }
          />
        </div>
      </section>
      <section className="settings-section panel">
        <div className="settings-section-title">
          <SafetyOutlined />
          <div>
            <h2>操作範圍</h2>
            <p>目前引擎支援的執行方式</p>
          </div>
        </div>
        <div className="scope-grid">
          <div>
            <strong>頁面分析</strong>
            <p>讀取真實頁面的內容、連結與表單。</p>
          </div>
          <div>
            <strong>頁面導覽</strong>
            <p>透過 CDP 點選連結或一般按鈕，並驗證執行結果。</p>
          </div>
          <div>
            <strong>需要人工處理</strong>
            <p>登入、驗證碼與付款。</p>
          </div>
        </div>
      </section>
      <p className="settings-version">
        Pilotry 0.1.0 <span>·</span>{" "}
        對話記錄保存在此裝置；引擎任務目前只保存在記憶體。
      </p>
    </div>
  );
}
