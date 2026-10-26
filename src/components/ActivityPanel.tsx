import { useState } from "react";
import type { ReactNode } from "react";
import {
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  CodeOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Button, Empty, Tag } from "antd";
import type { Workspace } from "../hooks/useWorkspace";
import { ACTION_LABELS, formatTime, PAGE_LABELS } from "../model";
import { recordableSteps } from "./SaveWorkflowModal";
import { DatasetResult } from "./DatasetResult";

export function ActivityPanel({
  workspace,
  onSave,
  view,
  headerTabs,
}: {
  workspace: Workspace;
  onSave: () => void;
  view?: "activity" | "page";
  headerTabs?: ReactNode;
}) {
  const [localTab, setTab] = useState("activity");
  const tab = view ?? localTab;
  const { session, browser } = workspace;
  return (
    <section className="activity-panel panel" aria-label="执行与页面信息">
      <div className="activity-tabs">
        {headerTabs || (
          <div
            className="activity-tab-buttons"
            role="tablist"
            aria-label="记录类型"
          >
            <button
              role="tab"
              id="activity-tab"
              aria-selected={tab === "activity"}
              aria-controls="activity-content"
              onClick={() => setTab("activity")}
            >
              <FileTextOutlined />
              执行记录
              {session.steps.length > 0 && (
                <span className="count-label">{session.steps.length}</span>
              )}
            </button>
            <button
              role="tab"
              id="page-tab"
              aria-selected={tab === "page"}
              aria-controls="activity-content"
              onClick={() => setTab("page")}
            >
              <InfoCircleOutlined />
              页面信息
            </button>
          </div>
        )}
        <Button
          type="text"
          size="small"
          className="save-flow-trigger"
          icon={<SaveOutlined />}
          disabled={
            !!workspace.runningId ||
            !workspace.agentOnline ||
            !recordableSteps(session.steps).length
          }
          onClick={onSave}
        >
          保存流程
        </Button>
      </div>
      <div
        className="activity-content"
        id="activity-content"
        role="tabpanel"
        aria-labelledby={
          headerTabs
            ? undefined
            : tab === "activity"
              ? "activity-tab"
              : "page-tab"
        }
        aria-label={
          headerTabs
            ? tab === "activity"
              ? "执行记录内容"
              : "页面信息内容"
            : undefined
        }
      >
        {tab === "activity" ? (
          session.steps.length ? (
            <ol className="step-list">
              {session.steps.map((step) => (
                <li key={step.id} className={`step-${step.status}`}>
                  <span className="step-indicator">
                    {step.status === "running" ? (
                      <LoadingOutlined />
                    ) : step.status === "awaiting_human" ? (
                      <PauseCircleOutlined />
                    ) : step.status === "success" ? (
                      <CheckOutlined />
                    ) : (
                      <CloseOutlined />
                    )}
                  </span>
                  <div className="step-body">
                    <div className="step-title">
                      <strong>
                        {ACTION_LABELS[step.action] ?? step.action}
                      </strong>
                      <span>{formatTime(step.timestamp)}</span>
                      <span className="step-status">
                        {step.status === "running"
                          ? "执行中"
                          : step.status === "awaiting_human"
                            ? "等待人工"
                            : step.status === "success"
                              ? "已完成"
                              : "失败"}
                      </span>
                    </div>
                    <p>{step.summary}</p>
                    <DatasetResult value={step.result?.dataset} />
                    {(step.mode === "replay" || step.repaired) && (
                      <span className="step-mode">
                        {step.repaired ? "本次由 AI 重新辨识定位" : "直接重跑"}
                      </span>
                    )}
                    <details>
                      <summary>
                        <CodeOutlined />
                        参数与执行结果
                      </summary>
                      <pre>
                        {JSON.stringify(
                          {
                            arguments: step.args,
                            result: step.result ?? "等待执行结果",
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="compact-empty">
              <FileTextOutlined />
              <p>尚无执行记录</p>
              <span>操作开始后，这里会即时显示工具呼叫与结果。</span>
            </div>
          )
        ) : browser.connected ? (
          <div className="page-inspector">
            <dl>
              <div>
                <dt>页面标题</dt>
                <dd>{browser.title || "未取得"}</dd>
              </div>
              <div>
                <dt>网址</dt>
                <dd>{browser.url}</dd>
              </div>
              <div>
                <dt>页面类型</dt>
                <dd>{PAGE_LABELS[browser.pageType] ?? browser.pageType}</dd>
              </div>
              <div>
                <dt>表单</dt>
                <dd>{browser.forms.length} 个</dd>
              </div>
            </dl>
            <h4>
              可见操作项目 <span>{browser.buttons.length}</span>
            </h4>
            <div className="button-tags">
              {browser.buttons.map((item) => (
                <Tag
                  key={`${item.index}-${item.text}`}
                  color={item.disabled ? "default" : undefined}
                >
                  {item.text || item.tag}
                  {item.disabled ? "（停用）" : ""}
                </Tag>
              ))}
            </div>
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="打开页面后查看辨识结果"
          />
        )}
      </div>
    </section>
  );
}
