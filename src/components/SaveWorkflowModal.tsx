import { useEffect, useMemo, useState } from "react";
import { App, Checkbox, Form, Input, Modal, Tag } from "antd";
import { api } from "../api";
import type { AgentStep } from "../types";
import type { Workspace } from "../hooks/useWorkspace";
import { ACTION_LABELS, errorText } from "../model";

const ACTIONS = new Set([
  "open_url",
  "analyze_page",
  "wait_for_page",
  "click_link",
  "click_element",
  "extract_data",
]);
export function recordableSteps(steps: AgentStep[]) {
  return steps.filter(
    (step) => step.status === "success" && ACTIONS.has(step.action),
  );
}
function startUrl(step?: AgentStep) {
  const page = step?.result?.page as { url?: string } | undefined;
  return String(
    step?.action === "open_url"
      ? step.args.url
      : step?.before?.url || step?.args.snapshotUrl || page?.url || "",
  );
}

export function SaveWorkflowModal({
  open,
  onClose,
  workspace,
}: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const available = useMemo(
    () => recordableSteps(workspace.session.steps),
    [workspace.session.steps],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [bindings, setBindings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSelected(available.map((step) => step.id));
    setBindings([]);
    form.setFieldsValue({
      name: workspace.session.title.slice(0, 60),
      startUrl: startUrl(available[0]),
    });
  }, [open, available, form, workspace.session.title]);
  const records = available.filter((step) => selected.includes(step.id));

  const save = async () => {
    let values: { name: string; startUrl: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!records.length) {
      void message.warning("请至少选择一个成功步骤。");
      return;
    }
    setSaving(true);
    try {
      const flow = await api.saveWorkflow({
        ...values,
        records,
        bindings: records.flatMap((step, index) =>
          Object.keys(step.args)
            .filter((field) => bindings.includes(step.id + ":" + field))
            .map((field) => ({
              stepId: step.id,
              field,
              name: "step_" + (index + 1) + "_" + field,
              label:
                "步骤 " +
                (index + 1) +
                " · " +
                ({ text: "点选文字", href: "链接目标", url: "网址" }[field] ||
                  field),
            })),
        ),
      });
      workspace.setWorkflows((current) => [
        flow,
        ...current.filter((item) => item.id !== flow.id),
      ]);
      onClose();
      void message.success("流程已保存，可在流程库重跑。");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="保存流程"
      open={open}
      onCancel={saving ? undefined : onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okText="保存流程"
      cancelText="取消"
      okButtonProps={{ disabled: !records.length || !workspace.agentOnline }}
      mask={{ closable: !saving }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      width={640}
    >
      <p className="modal-intro">
        选择要重用的成功步骤。保存定位与结果网址，不保存整页内容。
      </p>
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="流程名称"
          rules={[
            { required: true, whitespace: true, message: "请输入流程名称。" },
          ]}
        >
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          name="startUrl"
          label="起始网址"
          rules={[
            { required: true, type: "url", message: "请输入完整的起始网址。" },
          ]}
        >
          <Input placeholder="https://" />
        </Form.Item>
      </Form>
      <div className="flow-selection-header">
        <strong>
          步骤{" "}
          <span>
            {records.length} / {available.length}
          </span>
        </strong>
        <Checkbox
          checked={selected.length === available.length && !!available.length}
          indeterminate={
            !!selected.length && selected.length < available.length
          }
          onChange={(event) =>
            setSelected(
              event.target.checked ? available.map((step) => step.id) : [],
            )
          }
        >
          全选
        </Checkbox>
      </div>
      <div className="flow-step-selection">
        {available.map((step, index) => (
          <div className="flow-select-row" key={step.id}>
            <Checkbox
              checked={selected.includes(step.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, step.id]
                    : current.filter((id) => id !== step.id),
                )
              }
            >
              <span className="flow-step-number">{index + 1}</span>
              <strong>{ACTION_LABELS[step.action] || step.action}</strong>
              <span className="flow-select-summary">{step.summary}</span>
            </Checkbox>
            {selected.includes(step.id) &&
              ["click_link", "click_element", "open_url"].includes(
                step.action,
              ) && (
                <details className="flow-parameter-options">
                  <summary>可替换参数</summary>
                  {Object.entries(step.args)
                    .filter(
                      ([field, value]) =>
                        ["text", "href", "url"].includes(field) &&
                        typeof value === "string",
                    )
                    .map(([field, value]) => (
                      <div key={field}>
                        <Checkbox
                          disabled={step.action === "open_url" && index === 0}
                          checked={
                            (step.action === "open_url" && index === 0) ||
                            bindings.includes(step.id + ":" + field)
                          }
                          onChange={(event) =>
                            setBindings((current) =>
                              event.target.checked
                                ? [...current, step.id + ":" + field]
                                : current.filter(
                                    (key) => key !== step.id + ":" + field,
                                  ),
                            )
                          }
                        >
                          {field === "text" ? "点选文字" : "目标网址"}
                        </Checkbox>
                        <code>{String(value)}</code>
                      </div>
                    ))}
                </details>
              )}
          </div>
        ))}
      </div>
      <div className="flow-save-note">
        <Tag>起始网址可替换</Tag>
        <span>参数可在每次执行前修改；页面不符时会停止。</span>
      </div>
    </Modal>
  );
}
