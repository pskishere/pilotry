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
      void message.success("流程已删除。");
    } catch (error) {
      void message.error(errorText(error));
    }
  };
  return (
    <div className="workflows-page page-enter">
      <div className="page-heading">
        <div>
          <h1>
            流程库
            <span className="heading-count">{workspace.workflows.length}</span>
          </h1>
          <p>重用已完成的操作，执行前可替换参数。</p>
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
          <span>已保存的流程</span>
          <Input
            prefix={<SearchOutlined />}
            aria-label="搜索流程"
            placeholder="搜索流程名称"
            allowClear
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!flows.length ? (
          <div className="workflow-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={query ? "没有符合条件的流程" : "尚未保存流程"}
            />
            <p>在工作台的执行记录中选择「保存流程」。</p>
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
                    {flow.steps.length} 个记录步骤 <span>·</span>{" "}
                    {flow.parameters.length} 个参数 <span>·</span>{" "}
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
                            : flow.lastRun.status === "awaiting_human"
                              ? "等待人工"
                              : "执行失败"}
                      </Tag>
                      <span>
                        {flow.lastRun.completed}/{flow.lastRun.total} 步 ·{" "}
                        {(flow.lastRun.durationMs / 1000).toFixed(1)} 秒 · AI
                        重新辨识 {flow.lastRun.repairs} 次
                      </span>
                    </div>
                  )}
                </div>
                <div className="workflow-actions">
                  <Button
                    type="text"
                    icon={<EyeOutlined />}
                    aria-label={"预览流程：" + flow.name}
                    onClick={() => setPreview(flow)}
                  />
                  <Button
                    type="text"
                    icon={<EditOutlined />}
                    aria-label={"编辑流程：" + flow.name}
                    disabled={!!workspace.runningId}
                    onClick={() => edit(flow)}
                  />
                  <Popconfirm
                    title="删除这个流程？"
                    description="已保存的步骤与默认参数会被移除。"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => remove(flow)}
                  >
                    <Button
                      type="text"
                      icon={<DeleteOutlined />}
                      aria-label={"删除流程：" + flow.name}
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
        流程独立保存在本机。正常重跑直接执行 CDP 操作，定位失效时才使用
        AI；已执行但结果不符的动作不会自动重试。
      </p>
      <Drawer
        title="流程预览"
        open={!!preview}
        onClose={() => setPreview(null)}
        size={540}
      >
        {preview && (
          <>
            <h2 className="detail-title">{preview.name}</h2>
            <p className="flow-detail-label">起始网址</p>
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
                      <small>预期网址：{step.expectedUrl}</small>
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
        title={"执行流程" + (target ? " · " + target.name : "")}
        open={!!target}
        onCancel={() => setTarget(null)}
        onOk={() => void run()}
        okText="开始重跑"
        cancelText="取消"
        okButtonProps={{
          disabled:
            !workspace.online ||
            !workspace.agentOnline ||
            !!workspace.runningId,
        }}
      >
        <p className="modal-intro">
          确认本次参数。执行进度与浏览器画面会显示在工作台。
        </p>
        <Form form={runForm} layout="vertical">
          {target?.parameters.map((parameter) => (
            <Form.Item
              key={parameter.name}
              name={["parameters", parameter.name]}
              label={parameter.label}
              rules={[
                { required: true, whitespace: true, message: "请填写参数。" },
                ...(parameter.name === "start_url"
                  ? [
                      {
                        pattern: /^https?:\/\/[^/]+/i,
                        message: "请输入 HTTP 或 HTTPS 起始网址。",
                      },
                    ]
                  : []),
              ]}
            >
              <Input />
            </Form.Item>
          ))}
          <Form.Item name="repairEnabled" valuePropName="checked">
            <Checkbox>定位失效时，由 AI 重新辨识对应控制项</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="编辑流程"
        open={!!editing}
        onCancel={saving ? undefined : () => setEditing(null)}
        onOk={() => void save()}
        confirmLoading={saving}
        okText="保存修改"
        cancelText="取消"
        width={660}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="name"
            label="流程名称"
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
            <summary>进阶：步骤、定位与预期网址</summary>
            <p>可使用已定义的双大括号参数。每一步执行后会检查预期网址。</p>
            <Form.Item name="steps" rules={[{ required: true }]}>
              <Input.TextArea
                aria-label="流程步骤 JSON"
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
