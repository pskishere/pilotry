import { useState } from "react";
import { App, Form, Input, InputNumber, Modal, Select } from "antd";
import { api } from "../api";
import type { TicketTask } from "../types";
import type { Workspace } from "../hooks/useWorkspace";
import { errorText } from "../model";

export function CreateTaskModal({
  open,
  onClose,
  workspace,
}: {
  open: boolean;
  onClose: () => void;
  workspace: Workspace;
}) {
  const [form] = Form.useForm();
  const scene = Form.useWatch("platform", form);
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const create = async () => {
    let values: Partial<TicketTask>;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSaving(true);
    try {
      const task = await api.createTask(values);
      workspace.setTasks((current) => [
        task,
        ...current.filter((item) => item.id !== task.id),
      ]);
      onClose();
      form.resetFields();
      void message.success("任務已儲存，可在任務管理開始對話。");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="新增網頁任務"
      open={open}
      onCancel={saving ? undefined : onClose}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      onOk={() => void create()}
      okText="儲存任務"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: !workspace.online }}
      cancelButtonProps={{ disabled: saving }}
      width={540}
    >
      <p className="modal-intro">儲存網址與操作目標，不會自動啟動背景工作。</p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ platform: "web" }}
        requiredMark="optional"
      >
        <Form.Item
          name="event"
          label="任務名稱"
          rules={[
            { required: true, whitespace: true, message: "請輸入任務名稱" },
            { max: 120, message: "最多 120 個字元" },
          ]}
        >
          <Input placeholder="例如：整理網站資料" maxLength={120} />
        </Form.Item>
        <Form.Item
          name="url"
          label="起始網址"
          rules={[
            {
              required: true,
              type: "url",
              message: "請輸入完整的 HTTP(S) 網址",
            },
          ]}
        >
          <Input placeholder="https://" />
        </Form.Item>
        <Form.Item
          name="goal"
          label="操作目標"
          rules={[
            { required: true, whitespace: true, message: "請描述要完成的操作" },
            { max: 4000, message: "最多 4000 個字元" },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 7 }}
            placeholder="描述要瀏覽的內容、擷取的資料或要完成的操作"
          />
        </Form.Item>
        <Form.Item name="platform" label="場景標籤">
          <Select
            options={[
              { label: "一般操作", value: "web" },
              { label: "網頁瀏覽", value: "browse" },
              { label: "資料擷取", value: "extract" },
              { label: "表單操作", value: "form" },
              { label: "購票流程", value: "ticket" },
            ]}
          />
        </Form.Item>
        {scene === "ticket" && (
          <div className="form-grid">
            <Form.Item name="ticketNumber" label="票數" preserve={false}>
              <InputNumber min={1} max={10} precision={0} />
            </Form.Item>
            <Form.Item name="maxPrice" label="單價上限" preserve={false}>
              <InputNumber min={0} />
            </Form.Item>
          </div>
        )}
      </Form>
    </Modal>
  );
}
