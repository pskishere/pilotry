import { useMemo, useState } from "react";
import {
  App,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Popconfirm,
  Segmented,
  Table,
  Tag,
} from "antd";
import {
  ArrowRightOutlined,
  CheckOutlined,
  PlusOutlined,
  SearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { Workspace } from "../hooks/useWorkspace";
import type { TicketOrder, TicketTask } from "../types";
import { api } from "../api";
import { errorText, formatTime, platformName, STATUS_META } from "../model";

export function RecordsPage({
  workspace,
  kind,
  onCreate,
  onWorkspace,
}: {
  workspace: Workspace;
  kind: "tasks" | "orders";
  onCreate: () => void;
  onWorkspace: () => void;
}) {
  const { message } = App.useApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<TicketTask | TicketOrder | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const isTasks = kind === "tasks";
  const records = isTasks ? workspace.tasks : workspace.orders;
  const filtered = useMemo(
    () =>
      records.filter((item) => {
        const textMatches =
          `${item.event} ${item.platform} ${platformName(item.platform)} ${item.id}`
            .toLowerCase()
            .includes(query.toLowerCase());
        const statusMatches =
          filter === "all" ||
          (filter === "human"
            ? item.needsHuman
            : filter === "stopped"
              ? item.status === "stopped"
              : ["monitoring", "selecting"].includes(item.status));
        return textMatches && statusMatches;
      }),
    [records, query, filter],
  );

  const act = async (id: string, action: "approve" | "stop") => {
    setBusy(id);
    try {
      await api[action](id);
      await workspace.refresh();
      void message.success(action === "stop" ? "任务已停止" : "任务状态已更新");
    } catch (error) {
      void message.error(errorText(error));
    } finally {
      setBusy(null);
    }
  };

  const status = (value: string) => {
    const meta =
      value === "awaiting_manual_payment"
        ? { color: "warning", label: "待人工付款" }
        : (STATUS_META[value as TicketTask["status"]] ?? {
            color: "default",
            label: value,
          });
    return <Tag color={meta.color}>{meta.label}</Tag>;
  };

  return (
    <div className="records-page page-enter" key={kind}>
      <div className="page-heading">
        <div>
          <h1>
            {isTasks ? "任务管理" : "订单记录"}
            <span className="heading-count">{records.length}</span>
          </h1>
          <p>
            {isTasks
              ? "管理网址与操作目标，通过对话执行，成功后可保存流程。"
              : "查看已提取的网站订单与处理状态。"}
          </p>
        </div>
        {isTasks && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onCreate}
            disabled={!workspace.online}
          >
            新增任务
          </Button>
        )}
      </div>
      <section className="panel records-panel">
        <div className="records-toolbar">
          <Segmented
            value={filter}
            onChange={(value) => setFilter(String(value))}
            options={
              isTasks
                ? [
                    { label: "全部", value: "all" },
                    { label: "进行中", value: "active" },
                    { label: "待处理", value: "human" },
                    { label: "已停止", value: "stopped" },
                  ]
                : [
                    { label: "全部订单", value: "all" },
                    { label: "待处理", value: "human" },
                  ]
            }
          />
          <Input
            prefix={<SearchOutlined />}
            placeholder={isTasks ? "搜索任务或场景" : "搜索活动或订单编号"}
            aria-label={isTasks ? "搜索任务" : "搜索订单"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            allowClear
          />
        </div>
        <Table<TicketTask | TicketOrder>
          rowKey="id"
          dataSource={filtered}
          scroll={{ x: 720 }}
          pagination={{
            pageSize: 8,
            hideOnSinglePage: true,
            showSizeChanger: false,
          }}
          locale={{
            emptyText: (
              <div className="records-empty">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    query || filter !== "all"
                      ? "没有符合条件的项目"
                      : isTasks
                        ? "尚无任务"
                        : "尚无订单"
                  }
                />
                {!query && filter === "all" && (
                  <p>
                    {isTasks
                      ? "新增任务，保存网址与操作目标。"
                      : "目前尚未接入网站订单提取，操作结果请查看工作台的执行记录。"}
                  </p>
                )}
              </div>
            ),
          }}
          columns={[
            {
              title: isTasks ? "任务" : "活动",
              dataIndex: "event",
              key: "event",
              render: (value, record) => (
                <button
                  className="record-name"
                  onClick={() => setSelected(record)}
                >
                  <strong>{value}</strong>
                  <small>
                    {isTasks && "ticketNumber" in record
                      ? `${record.ticketNumber} 张票${record.maxPrice ? ` · 单价上限 ${record.maxPrice.toLocaleString()}` : ""}`
                      : `#${record.id.slice(0, 10)}`}
                  </small>
                </button>
              ),
            },
            {
              title: isTasks ? "场景" : "平台",
              dataIndex: "platform",
              width: 120,
              render: platformName,
            },
            { title: "状态", dataIndex: "status", width: 140, render: status },
            {
              title: "更新时间",
              dataIndex: "updatedAt",
              width: 150,
              render: formatTime,
            },
            {
              title: "操作",
              key: "actions",
              width: 150,
              render: (_, record) => (
                <div className="record-actions">
                  {isTasks && "goal" in record && record.goal && (
                    <Button
                      size="small"
                      disabled={
                        !workspace.online ||
                        !workspace.agentOnline ||
                        !!workspace.runningId
                      }
                      onClick={() => {
                        onWorkspace();
                        void workspace.send(
                          `任务：${record.event}\n网址：${record.url}\n操作目标：${record.goal}`,
                        );
                      }}
                    >
                      开始对话
                    </Button>
                  )}
                  {isTasks && record.needsHuman && (
                    <Button
                      size="small"
                      icon={<CheckOutlined />}
                      loading={busy === record.id}
                      disabled={!workspace.online}
                      onClick={() => void act(record.id, "approve")}
                    >
                      已处理
                    </Button>
                  )}
                  {isTasks &&
                    ![
                      "stopped",
                      "failed",
                      "manual_payment",
                      "order_created",
                    ].includes(record.status) && (
                      <Popconfirm
                        title="停止这个任务？"
                        description="只更新任务状态，不会撤销已完成的网页操作。"
                        okText="停止任务"
                        cancelText="返回"
                        onConfirm={() => act(record.id, "stop")}
                      >
                        <Button
                          type="text"
                          size="small"
                          icon={<StopOutlined />}
                          aria-label={`停止 ${record.event}`}
                          disabled={!workspace.online || !!busy}
                        />
                      </Popconfirm>
                    )}
                  <Button
                    type="text"
                    size="small"
                    icon={<ArrowRightOutlined />}
                    aria-label={`查看 ${record.event}`}
                    onClick={() => setSelected(record)}
                  />
                </div>
              ),
            },
          ]}
        />
      </section>
      <Drawer
        title={isTasks ? "任务详情" : "订单详情"}
        open={!!selected}
        onClose={() => setSelected(null)}
        size="default"
      >
        {selected && (
          <>
            <h2 className="detail-title">{selected.event}</h2>
            <Descriptions
              column={1}
              layout="vertical"
              items={[
                {
                  key: "id",
                  label: "编号",
                  children: (
                    <span className="mono break-all">{selected.id}</span>
                  ),
                },
                {
                  key: "platform",
                  label: "平台",
                  children: platformName(selected.platform),
                },
                {
                  key: "status",
                  label: "状态",
                  children: status(
                    records.find((item) => item.id === selected.id)?.status ??
                      selected.status,
                  ),
                },
                ...("ticketNumber" in selected
                  ? [
                      {
                        key: "quantity",
                        label: "票数",
                        children: selected.ticketNumber,
                      },
                      {
                        key: "budget",
                        label: "单价上限",
                        children:
                          selected.maxPrice?.toLocaleString() ?? "未设置",
                      },
                      {
                        key: "url",
                        label: "活动网址",
                        children: (
                          <span className="break-all">
                            {selected.url || "未设置"}
                          </span>
                        ),
                      },
                    ]
                  : []),
                {
                  key: "created",
                  label: "操作目标",
                  children:
                    "goal" in selected ? selected.goal || "未设置" : "未设置",
                },
                {
                  key: "createdAt",
                  label: "建立时间",
                  children: formatTime(selected.createdAt),
                },
              ]}
            />
            {!isTasks && (
              <p className="detail-note">请以原网站显示的订单状态为准。</p>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
