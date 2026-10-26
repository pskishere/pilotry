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
          <h1>设置</h1>
          <p>管理本机连接与工作台显示方式。</p>
        </div>
      </div>
      <BrowserSettings workspace={workspace} />
      <section className="settings-section panel">
        <div className="settings-section-title">
          <ApiOutlined />
          <div>
            <h2>服务连接</h2>
            <p>浏览器引擎、流式服务与模型状态</p>
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
            检查连接
          </Button>
        </div>
        <div className="setting-row">
          <div>
            <strong>浏览器引擎</strong>
            <span>{ENGINE_URL}</span>
          </div>
          <Tag color={workspace.online ? "success" : "default"}>
            {workspace.online ? "已连接" : "未连接"}
          </Tag>
        </div>
        <div className="setting-row">
          <div>
            <strong>Agent 流式服务</strong>
            <span>{AGENT_URL} · AI SDK streamText</span>
          </div>
          <Tag color={workspace.agentOnline ? "success" : "default"}>
            {workspace.agentOnline ? "已连接" : "未连接"}
          </Tag>
        </div>
        <div className="setting-row">
          <div>
            <strong>模型</strong>
            <span>{workspace.ai?.model ?? "尚未取得模型信息"}</span>
          </div>
          <Tag color={workspace.ai?.available ? "success" : "default"}>
            {workspace.ai?.available ? "可用" : "未连接"}
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
            <h2>Agent 执行预算</h2>
            <p>限制单次工作的资源使用，不是模型使用额度</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>工具回合预算</strong>
            <span>每回合可呼叫工具；复杂任务可调高，连续失败仍会暂停</span>
          </div>
          <Select
            aria-label="工具回合预算"
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
            <strong>单次执行时间</strong>
            <span>达限后保留目前页面与记录，可从目前位置继续</span>
          </div>
          <Select
            aria-label="单次执行时间"
            value={workspace.preferences.agentTimeoutMinutes}
            disabled={!!workspace.runningId}
            options={[5, 15, 30, 60].map((value) => ({
              label: `${value} 分钟`,
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
            <p>偏好设置会保存在这台设备</p>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>即时浏览器画面</strong>
            <span>在工作台内显示浏览器截图</span>
          </div>
          <Switch
            aria-label="即时浏览器画面"
            checked={workspace.preferences.livePreview}
            onChange={(livePreview) =>
              workspace.setPreferences((value) => ({ ...value, livePreview }))
            }
          />
        </div>
        <div className="setting-row">
          <div>
            <strong>画面更新间隔</strong>
            <span>较长的间隔可减少本机资源使用</span>
          </div>
          <Select
            aria-label="画面更新间隔"
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
            <h2>操作范围</h2>
            <p>目前引擎支持的执行方式</p>
          </div>
        </div>
        <div className="scope-grid">
          <div>
            <strong>页面分析</strong>
            <p>读取真实页面的内容、链接与表单。</p>
          </div>
          <div>
            <strong>页面导航</strong>
            <p>通过 CDP 点选链接或一般按钮，并验证执行结果。</p>
          </div>
          <div>
            <strong>需要人工处理</strong>
            <p>登录、验证码与付款。</p>
          </div>
        </div>
      </section>
      <p className="settings-version">
        Pilotry 0.1.0 <span>·</span>{" "}
        对话记录保存在此设备；引擎任务目前只保存在内存。
      </p>
    </div>
  );
}
