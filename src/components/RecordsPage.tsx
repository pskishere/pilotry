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
      void message.success(action === "stop" ? "任務已停止" : "任務狀態已更新");
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
            {isTasks ? "任務管理" : "訂單記錄"}
            <span className="heading-count">{records.length}</span>
          </h1>
          <p>
            {isTasks
              ? "管理網址與操作目標，透過對話執行，成功後可儲存流程。"
              : "查看已擷取的網站訂單與處理狀態。"}
          </p>
        </div>
        {isTasks && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={onCreate}
            disabled={!workspace.online}
          >
            新增任務
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
                    { label: "進行中", value: "active" },
                    { label: "待處理", value: "human" },
                    { label: "已停止", value: "stopped" },
                  ]
                : [
                    { label: "全部訂單", value: "all" },
                    { label: "待處理", value: "human" },
                  ]
            }
          />
          <Input
            prefix={<SearchOutlined />}
            placeholder={isTasks ? "搜尋任務或場景" : "搜尋活動或訂單編號"}
            aria-label={isTasks ? "搜尋任務" : "搜尋訂單"}
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
                      ? "沒有符合條件的項目"
                      : isTasks
                        ? "尚無任務"
                        : "尚無訂單"
                  }
                />
                {!query && filter === "all" && (
                  <p>
                    {isTasks
                      ? "新增任務，儲存網址與操作目標。"
                      : "目前尚未接入網站訂單擷取，操作結果請查看工作台的執行記錄。"}
                  </p>
                )}
              </div>
            ),
          }}
          columns={[
            {
              title: isTasks ? "任務" : "活動",
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
                      ? `${record.ticketNumber} 張票${record.maxPrice ? ` · 單價上限 ${record.maxPrice.toLocaleString()}` : ""}`
                      : `#${record.id.slice(0, 10)}`}
                  </small>
                </button>
              ),
            },
            {
              title: isTasks ? "場景" : "平台",
              dataIndex: "platform",
              width: 120,
              render: platformName,
            },
            { title: "狀態", dataIndex: "status", width: 140, render: status },
            {
              title: "更新時間",
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
                          `任務：${record.event}\n網址：${record.url}\n操作目標：${record.goal}`,
                        );
                      }}
                    >
                      開始對話
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
                      已處理
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
                        title="停止這個任務？"
                        description="只更新任務狀態，不會撤銷已完成的網頁操作。"
                        okText="停止任務"
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
        title={isTasks ? "任務詳情" : "訂單詳情"}
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
                  label: "編號",
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
                  label: "狀態",
                  children: status(
                    records.find((item) => item.id === selected.id)?.status ??
                      selected.status,
                  ),
                },
                ...("ticketNumber" in selected
                  ? [
                      {
                        key: "quantity",
                        label: "票數",
                        children: selected.ticketNumber,
                      },
                      {
                        key: "budget",
                        label: "單價上限",
                        children:
                          selected.maxPrice?.toLocaleString() ?? "未設定",
                      },
                      {
                        key: "url",
                        label: "活動網址",
                        children: (
                          <span className="break-all">
                            {selected.url || "未設定"}
                          </span>
                        ),
                      },
                    ]
                  : []),
                {
                  key: "created",
                  label: "操作目標",
                  children:
                    "goal" in selected ? selected.goal || "未設定" : "未設定",
                },
                {
                  key: "createdAt",
                  label: "建立時間",
                  children: formatTime(selected.createdAt),
                },
              ]}
            />
            {!isTasks && (
              <p className="detail-note">請以原網站顯示的訂單狀態為準。</p>
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
