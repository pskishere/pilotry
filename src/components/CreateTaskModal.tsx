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
      void message.success("任务已保存，可在任务管理开始对话。");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="新增网页任务"
      open={open}
      onCancel={saving ? undefined : onClose}
      closable={!saving}
      mask={{ closable: !saving }}
      keyboard={!saving}
      onOk={() => void create()}
      okText="保存任务"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: !workspace.online }}
      cancelButtonProps={{ disabled: saving }}
      width={540}
    >
      <p className="modal-intro">保存网址与操作目标，不会自动启动背景工作。</p>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ platform: "web" }}
        requiredMark="optional"
      >
        <Form.Item
          name="event"
          label="任务名称"
          rules={[
            { required: true, whitespace: true, message: "请输入任务名称" },
            { max: 120, message: "最多 120 个字元" },
          ]}
        >
          <Input placeholder="例如：整理网站数据" maxLength={120} />
        </Form.Item>
        <Form.Item
          name="url"
          label="起始网址"
          rules={[
            {
              required: true,
              type: "url",
              message: "请输入完整的 HTTP(S) 网址",
            },
          ]}
        >
          <Input placeholder="https://" />
        </Form.Item>
        <Form.Item
          name="goal"
          label="操作目标"
          rules={[
            { required: true, whitespace: true, message: "请描述要完成的操作" },
            { max: 4000, message: "最多 4000 个字元" },
          ]}
        >
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 7 }}
            placeholder="描述要浏览的内容、提取的数据或要完成的操作"
          />
        </Form.Item>
        <Form.Item name="platform" label="场景标签">
          <Select
            options={[
              { label: "一般操作", value: "web" },
              { label: "网页浏览", value: "browse" },
              { label: "数据提取", value: "extract" },
              { label: "表单操作", value: "form" },
              { label: "购票流程", value: "ticket" },
            ]}
          />
        </Form.Item>
        {scene === "ticket" && (
          <div className="form-grid">
            <Form.Item name="ticketNumber" label="票数" preserve={false}>
              <InputNumber min={1} max={10} precision={0} />
            </Form.Item>
            <Form.Item name="maxPrice" label="单价上限" preserve={false}>
              <InputNumber min={0} />
            </Form.Item>
          </div>
        )}
      </Form>
    </Modal>
  );
}
