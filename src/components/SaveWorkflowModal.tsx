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
      void message.warning("請至少選擇一個成功步驟。");
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
                "步驟 " +
                (index + 1) +
                " · " +
                ({ text: "點選文字", href: "連結目標", url: "網址" }[field] ||
                  field),
            })),
        ),
      });
      workspace.setWorkflows((current) => [
        flow,
        ...current.filter((item) => item.id !== flow.id),
      ]);
      onClose();
      void message.success("流程已儲存，可在流程庫重跑。");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="儲存流程"
      open={open}
      onCancel={saving ? undefined : onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okText="儲存流程"
      cancelText="取消"
      okButtonProps={{ disabled: !records.length || !workspace.agentOnline }}
      mask={{ closable: !saving }}
      cancelButtonProps={{ disabled: saving }}
      closable={!saving}
      width={640}
    >
      <p className="modal-intro">
        選擇要重用的成功步驟。保存定位與結果網址，不保存整頁內容。
      </p>
      <Form form={form} layout="vertical">
        <Form.Item
          name="name"
          label="流程名稱"
          rules={[
            { required: true, whitespace: true, message: "請輸入流程名稱。" },
          ]}
        >
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          name="startUrl"
          label="起始網址"
          rules={[
            { required: true, type: "url", message: "請輸入完整的起始網址。" },
          ]}
        >
          <Input placeholder="https://" />
        </Form.Item>
      </Form>
      <div className="flow-selection-header">
        <strong>
          步驟{" "}
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
          全選
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
                  <summary>可替換參數</summary>
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
                          {field === "text" ? "點選文字" : "目標網址"}
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
        <Tag>起始網址可替換</Tag>
        <span>參數可在每次執行前修改；頁面不符時會停止。</span>
      </div>
    </Modal>
  );
}
