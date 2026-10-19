import { useState } from "react";
import {
  App,
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Tag,
} from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  NodeIndexOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type { Workflow } from "../types";
import type { Workspace } from "../hooks/useWorkspace";
import { api } from "../api";
import { ACTION_LABELS, errorText, formatTime } from "../model";

export function WorkflowsPage({
  workspace,
  onWorkspace,
}: {
  workspace: Workspace;
  onWorkspace: () => void;
}) {
  const { message } = App.useApp();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Workflow | null>(null);
  const [target, setTarget] = useState<Workflow | null>(null);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [saving, setSaving] = useState(false);
  const [runForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const flows = workspace.workflows.filter((flow) =>
    flow.name.toLowerCase().includes(query.toLowerCase()),
  );
  const openRun = (flow: Workflow) => {
    runForm.resetFields();
    runForm.setFieldsValue({
      parameters: Object.fromEntries(
        flow.parameters.map((item) => [item.name, item.defaultValue]),
      ),
      repairEnabled: true,
    });
    setTarget(flow);
  };
  const run = async () => {
    if (!target) return;
    let values: { parameters: Record<string, string>; repairEnabled: boolean };
    try {
      values = await runForm.validateFields();
    } catch {
      return;
    }
    const flow = target;
    setTarget(null);
    const execution = workspace.runWorkflow(
      flow,
      values.parameters || {},
      values.repairEnabled,
    );
    onWorkspace();
    void execution.catch((error) => message.error(errorText(error)));
  };
  const edit = (flow: Workflow) => {
    editForm.resetFields();
    editForm.setFieldsValue({
      name: flow.name,
      parameters: flow.parameters.map((item) => item.defaultValue),
      steps: JSON.stringify(flow.steps, null, 2),
    });
    setEditing(flow);
  };
  const save = async () => {
    if (!editing) return;
    let values: { name: string; parameters: string[]; steps: string };
    try {
      values = await editForm.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const flow = await api.updateWorkflow({
        ...editing,
        name: values.name,
        parameters: editing.parameters.map((item, index) => ({
          ...item,
          defaultValue: values.parameters[index],
        })),
        steps: JSON.parse(values.steps),
      });
      workspace.setWorkflows((current) =>
        current.map((item) => (item.id === flow.id ? flow : item)),
      );
      setEditing(null);
      void message.success("流程已更新。");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (flow: Workflow) => {
    try {
      await api.deleteWorkflow(flow.id);
      workspace.setWorkflows((current) =>
        current.filter((item) => item.id !== flow.id),
      );
      void message.success("流程已刪除。");
    } catch (error) {
      void message.error(errorText(error));
    }
  };
  return (
    <div className="workflows-page page-enter">
      <div className="page-heading">
        <div>
          <h1>
            流程庫
            <span className="heading-count">{workspace.workflows.length}</span>
          </h1>
          <p>重用已完成的操作，執行前可替換參數。</p>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void workspace.refresh()}
        >
          重新整理
        </Button>
      </div>
      {workspace.workflowError && (
        <Alert type="warning" title={workspace.workflowError} showIcon />
      )}
      <section className="panel workflows-panel">
        <div className="workflow-toolbar">
          <span>已儲存的流程</span>
          <Input
            prefix={<SearchOutlined />}
            aria-label="搜尋流程"
            placeholder="搜尋流程名稱"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!flows.length ? (
          <div className="workflow-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={query ? "沒有符合條件的流程" : "尚未儲存流程"}
            />
            <p>在工作台的執行記錄中選擇「儲存流程」。</p>
            <Button onClick={onWorkspace}>前往工作台</Button>
          </div>
        ) : (
          <div className="workflow-list">
            {flows.map((flow) => (
              <article key={flow.id} className="workflow-row">
                <div className="workflow-icon">
                  <NodeIndexOutlined />
                </div>
                <div className="workflow-description">
                  <button
                    onClick={() => setPreview(flow)}
                    className="workflow-name"
                  >
                    {flow.name}
                  </button>
                  <p>
                    {flow.steps.length} 個記錄步驟 <span>·</span>{" "}
                    {flow.parameters.length} 個參數 <span>·</span>{" "}
                    {formatTime(flow.updatedAt)}
                  </p>
                  {flow.lastRun && (
                    <div className="workflow-last-run">
                      <Tag
                        color={
                          flow.lastRun.status === "success"
                            ? "success"
                            : "warning"
                        }
                      >
                        {flow.lastRun.status === "success"
                          ? "已完成"
                          : flow.lastRun.status === "cancelled"
                            ? "已停止"
                            : "執行失敗"}
                      </Tag>
                      <span>
                        {flow.lastRun.completed}/{flow.lastRun.total} 步 ·{" "}
                        {(flow.lastRun.durationMs / 1000).toFixed(1)} 秒 · AI
                        重新辨識 {flow.lastRun.repairs} 次
                      </span>
                    </div>
                  )}
                </div>
                <div className="workflow-actions">
                  <Button
                    type="text"
                    icon={<EyeOutlined />}
                    aria-label={"預覽流程：" + flow.name}
                    onClick={() => setPreview(flow)}
                  />
                  <Button
                    type="text"
                    icon={<EditOutlined />}
                    aria-label={"編輯流程：" + flow.name}
                    disabled={!!workspace.runningId}
                    onClick={() => edit(flow)}
                  />
                  <Popconfirm
                    title="刪除這個流程？"
                    description="已保存的步驟與預設參數會被移除。"
                    okText="刪除"
                    cancelText="取消"
                    onConfirm={() => remove(flow)}
                  >
                    <Button
                      type="text"
                      icon={<DeleteOutlined />}
                      aria-label={"刪除流程：" + flow.name}
                      disabled={!!workspace.runningId}
                    />
                  </Popconfirm>
                  <Button
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    disabled={
                      !workspace.online ||
                      !workspace.agentOnline ||
                      !!workspace.runningId
                    }
                    onClick={() => openRun(flow)}
                  >
                    重跑
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <p className="workflow-storage-note">
        流程獨立保存在本機。正常重跑直接執行 CDP 操作，定位失效時才使用
        AI；已執行但結果不符的動作不會自動重試。
      </p>
      <Drawer
        title="流程預覽"
        open={!!preview}
        onClose={() => setPreview(null)}
        size={540}
      >
        {preview && (
          <>
            <h2 className="detail-title">{preview.name}</h2>
            <p className="flow-detail-label">起始網址</p>
            <p className="flow-url">
              {preview.parameters.find((item) => item.name === "start_url")
                ?.defaultValue || preview.startUrl}
            </p>
            <ol className="flow-preview-steps">
              {preview.steps.map((step, index) => (
                <li key={step.id}>
                  <span className="flow-step-number">{index + 1}</span>
                  <div>
                    <strong>{ACTION_LABELS[step.action] || step.action}</strong>
                    <p>{step.summary}</p>
                    <pre>{JSON.stringify(step.args, null, 2)}</pre>
                    {step.expectedUrl && (
                      <small>預期網址：{step.expectedUrl}</small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              disabled={!workspace.online || !!workspace.runningId}
              onClick={() => {
                setPreview(null);
                openRun(preview);
              }}
            >
              重跑此流程
            </Button>
          </>
        )}
      </Drawer>
      <Modal
        title={"執行流程" + (target ? " · " + target.name : "")}
        open={!!target}
        onCancel={() => setTarget(null)}
        onOk={() => void run()}
        okText="開始重跑"
        cancelText="取消"
        okButtonProps={{
          disabled:
            !workspace.online ||
            !workspace.agentOnline ||
            !!workspace.runningId,
        }}
      >
        <p className="modal-intro">
          確認本次參數。執行進度與瀏覽器畫面會顯示在工作台。
        </p>
        <Form form={runForm} layout="vertical">
          {target?.parameters.map((parameter) => (
            <Form.Item
              key={parameter.name}
              name={["parameters", parameter.name]}
              label={parameter.label}
              rules={[
                { required: true, whitespace: true, message: "請填寫參數。" },
                ...(parameter.name === "start_url"
                  ? [
                      {
                        pattern: /^https?:\/\/[^/]+/i,
                        message: "請輸入 HTTP 或 HTTPS 起始網址。",
                      },
                    ]
                  : []),
              ]}
            >
              <Input />
            </Form.Item>
          ))}
          <Form.Item name="repairEnabled" valuePropName="checked">
            <Checkbox>定位失效時，由 AI 重新辨識對應控制項</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="編輯流程"
        open={!!editing}
        onCancel={saving ? undefined : () => setEditing(null)}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="儲存修改"
        cancelText="取消"
        width={660}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="name"
            label="流程名稱"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input maxLength={120} />
          </Form.Item>
          {editing?.parameters.map((parameter, index) => (
            <Form.Item
              key={parameter.name}
              name={["parameters", index]}
              label={parameter.label}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
          ))}
          <details className="flow-advanced">
            <summary>進階：步驟、定位與預期網址</summary>
            <p>可使用已定義的雙大括號參數。每一步執行後會檢查預期網址。</p>
            <Form.Item name="steps" rules={[{ required: true }]}>
              <Input.TextArea
                aria-label="流程步驟 JSON"
                className="mono"
                autoSize={{ minRows: 8, maxRows: 18 }}
              />
            </Form.Item>
          </details>
        </Form>
      </Modal>
    </div>
  );
}
