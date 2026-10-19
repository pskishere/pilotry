import { useEffect, useMemo, useRef, useState } from "react";
import { Bubble, Sender, ThoughtChain } from "@ant-design/x";
import type { ThoughtChainItemType } from "@ant-design/x";
import XMarkdown from "@ant-design/x-markdown";
import {
  ArrowUpOutlined,
  CloseOutlined,
  ArrowRightOutlined,
  FileSearchOutlined,
  GlobalOutlined,
  RedoOutlined,
  EditOutlined,
  SlidersOutlined,
  StopOutlined,
  LinkOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Tag, Tooltip } from "antd";
import type { Workspace } from "../hooks/useWorkspace";
import type { Conversation } from "../types";
import { PilotryMark } from "./Brand";
import { ACTION_LABELS, errorText, formatTime } from "../model";
import { recordableSteps } from "./SaveWorkflowModal";

const SUGGESTIONS = [
  {
    key: "analyze",
    icon: <FileSearchOutlined />,
    title: "分析頁面",
  },
  {
    key: "browse",
    icon: <GlobalOutlined />,
    title: "瀏覽網站",
  },
  {
    key: "record",
    icon: <SlidersOutlined />,
    title: "記錄流程",
  },
];

function stepDetail(step: Conversation["steps"][number]) {
  const lines: string[] = [];
  const args = Object.entries(step.args ?? {}).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  const argText = args.length ? JSON.stringify(Object.fromEntries(args)) : "";
  if (argText) lines.push(`輸入 ${argText}`);
  const before = step.before?.url;
  if (before) lines.push(`執行前 ${before}`);
  if (typeof step.result?.error === "string")
    lines.push(`錯誤 ${step.result.error}`);
  if (step.result?.page) {
    const page = step.result.page as { url?: string; title?: string };
    if (page.url) lines.push(`執行後 ${page.url}`);
    if (page.title) lines.push(`標題 ${page.title}`);
  }
  if (step.result?.run) {
    const run = step.result.run as {
      completed?: number;
      total?: number;
      repairs?: number;
    };
    if (typeof run.total === "number")
      lines.push(
        `流程 ${run.completed ?? 0}/${run.total} 完成，修復 ${
          run.repairs ?? 0
        } 次`,
      );
  }
  return lines.length ? (
    <pre className="agent-thought-detail">{lines.join("\n")}</pre>
  ) : undefined;
}

export function ChatPanel({
  workspace,
  onSettings,
  visible = true,
  onSave,
}: {
  workspace: Workspace;
  onSettings: () => void;
  visible?: boolean;
  onSave: () => void;
}) {
  const { message } = App.useApp();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const { session, runningId, phase, online, agentOnline, browser } = workspace;
  const running = runningId === session.id;
  const available = online && agentOnline;
  const lastMessage = session.messages[session.messages.length - 1];
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const visibleSteps = useMemo(() => {
    const replaying = Boolean(session.workflowRun?.steps?.length);
    const source =
      replaying && session.workflowRun?.steps
        ? session.workflowRun.steps
        : session.steps;
    return source
      .filter((step) => step.action !== "run_workflow")
      .map((step) =>
        replaying && !step.mode ? { ...step, mode: "replay" as const } : step,
      )
      .slice(-12);
  }, [session.steps, session.workflowRun]);
  const lastStep = visibleSteps[visibleSteps.length - 1];
  const thoughtItems: ThoughtChainItemType[] = useMemo(
    () =>
      visibleSteps.map((step, index) => {
        const detail = stepDetail(step);
        return {
          key: step.id,
          title: (
            <span className="agent-thought-title">
              {ACTION_LABELS[step.action] ?? step.action}
              {step.mode === "replay" && <Tag className="replay-tag">重播</Tag>}
              {step.repaired && (
                <Tag className="repair-tag">已修復定位</Tag>
              )}
            </span>
          ),
          description: step.summary,
          status:
            step.status === "running"
              ? "loading"
              : step.status === "success"
                ? "success"
                : "error",
          content: detail ? detail : undefined,
          collapsible: Boolean(detail),
          blink: running && index === visibleSteps.length - 1,
          footer: (
            <span className="agent-thought-time">
              {formatTime(step.timestamp)}
            </span>
          ),
        };
      }),
    [visibleSteps, running],
  );

  useEffect(() => {
    setDraft("");
    pinned.current = true;
    setThoughtOpen(false);
    setExpandedKeys([]);
    setEditingId(null);
  }, [session.id]);
  useEffect(() => {
    if (visible && scrollRef.current) {
      if (!session.messages.length) scrollRef.current.scrollTop = 0;
      else if (pinned.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastMessage?.content, phase, session.id, visible]);
  useEffect(() => {
    if (running && lastStep) {
      setThoughtOpen(true);
      setExpandedKeys((keys) =>
        keys.includes(lastStep.id) ? keys : [...keys, lastStep.id].slice(-6),
      );
    }
  }, [running, lastStep?.id]);

  const submit = async () => {
    if (!draft.trim() || runningId) return;
    const text = draft;
    const messageId = editingId;
    try {
      if (!available) throw new Error("引擎或串流服務未連線，請檢查連線設定。");
      setDraft("");
      if (messageId) await workspace.editMessage(messageId, text);
      else await workspace.send(text);
      setEditingId(null);
    } catch (error) {
      setDraft(text);
      void message.error(errorText(error));
    }
  };

  const beginEdit = (id: string, content: string) => {
    setEditingId(id);
    setDraft(content);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
        ?.focus(),
    );
  };

  const retry = async (id: string) => {
    try {
      await workspace.retryMessage(id);
    } catch (error) {
      void message.error(errorText(error));
    }
  };

  const suggest = (key: string) => {
    const content =
      key === "analyze"
        ? browser.url
          ? `分析目前頁面 ${browser.url}，列出活動資訊與可操作項目。`
          : "請分析這個活動頁面："
          : key === "browse"
          ? "開啟這個網址並分析可以操作的項目："
            : "連續完成這個頁面的操作；完成後列出可保存的成功步驟。";
    setDraft(content);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
        ?.focus(),
    );
  };

  return (
    <section className="chat-panel panel" aria-label="Pilotry 對話">
      <div
        className="chat-content"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        }}
        role="log"
        aria-label="對話記錄"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!session.messages.length ? (
          <div className="chat-welcome">
            <PilotryMark />
            <h3>新的對話</h3>
            <p>輸入網址、操作需求，或指定要重跑的流程。</p>
            <div className="suggestions">
              {SUGGESTIONS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => suggest(item.key)}
                  className="suggestion"
                >
                  <span className="suggestion-icon">{item.icon}</span>
                  <span>
                    <strong>{item.title}</strong>
                  </span>
                  <ArrowRightOutlined />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {session.messages.map((item) =>
              item.role === "system" ? (
                <Alert
                  key={item.id}
                  type="warning"
                  title={item.content}
                  showIcon
                />
              ) : (
                <Bubble
                  key={item.id}
                  content={item.content || "正在處理…"}
                  contentRender={(content) =>
                    item.role === "assistant" ? (
                      <XMarkdown
                        content={String(content)}
                        escapeRawHtml
                        openLinksInNewTab
                        streaming={{
                          hasNextChunk: running && item.id === lastMessage?.id,
                        }}
                      />
                    ) : (
                      <span>{String(content)}</span>
                    )
                  }
                  placement={item.role === "user" ? "end" : "start"}
                  variant={item.role === "user" ? "filled" : "borderless"}
                  avatar={
                    item.role === "assistant" ? (
                      <PilotryMark small />
                    ) : undefined
                  }
                  header={item.role === "assistant" ? "Pilotry" : undefined}
                  footer={
                    !running && item.content ? (
                      <div className="message-actions">
                        {item.role === "user" ? (
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => beginEdit(item.id, item.content)}
                          >
                            編輯
                          </Button>
                        ) : (
                          <Button size="small" type="text" icon={<RedoOutlined />} onClick={() => void retry(item.id)}>
                            重試
                            </Button>
                        )}
                      </div>
                    ) : undefined
                  }
                  className={`message-${item.role}`}
                  styles={{
                    content: {
                      whiteSpace: item.role === "user" ? "pre-wrap" : "normal",
                      overflowWrap: "anywhere",
                    },
                  }}
                />
              ),
            )}
          </div>
        )}
        {(running || thoughtItems.length > 0) && (
          <div className="agent-thought" role="status">
            <div className="agent-thought-header">
              <div className="agent-thought-meta">
                <strong>執行思考鏈</strong>
                {running && session.agentRun && (
                  <span>
                    第 {session.agentRun.rounds} /{" "}
                    {session.agentRun.limits.maxSteps} 回合
                  </span>
                )}
                {!running && <span>{thoughtItems.length} 個工具步驟</span>}
              </div>
              <button
                className="agent-thought-toggle"
                onClick={() => setThoughtOpen((open) => !open)}
                aria-expanded={thoughtOpen}
              >
                {thoughtOpen ? "收起" : "展開"}
              </button>
            </div>
            {thoughtOpen && (
              thoughtItems.length ? (
                <ThoughtChain
                  items={thoughtItems}
                  line="dashed"
                  expandedKeys={expandedKeys}
                  onExpand={setExpandedKeys}
                  className="agent-thought-chain"
                />
              ) : (
                <div className="agent-phase">
                  <span className="working-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{phase || "正在處理"}</span>
                </div>
              )
            )}
          </div>
        )}
      </div>
      <div className="chat-composer">
        {editingId && !running && (
          <div className="conversation-tools edit-notice">
            <span>正在編輯訊息；送出後將取代原對話分支。</span>
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={() => setEditingId(null)}
            >
              取消
            </Button>
          </div>
        )}
        {!runningId && recordableSteps(session.steps).length > 0 && (
          <div className="conversation-tools">
            <Button
              size="small"
              type="text"
              icon={<SaveOutlined />}
              onClick={onSave}
              disabled={!workspace.agentOnline}
            >
              儲存成功步驟為流程
            </Button>
          </div>
        )}
        {!runningId && session.agentRun?.state === "paused" && (
          <div className="run-pause-control">
            <span>
              {session.agentRun.reason === "step_budget"
                ? "工具預算已用完"
                : session.agentRun.reason === "timeout"
                  ? "執行時間已到"
                  : "執行已暫停"}
            </span>
            <Button
              size="small"
              disabled={!available}
              onClick={() =>
                void workspace.send(
                  "從目前瀏覽器頁面與已記錄步驟繼續上一個未完成要求；先分析目前頁面，不要從起始網址重跑，不要重複已成功的提交或點選。若原本目標已達成，直接回報結果。",
                )
              }
            >
              從目前頁面繼續
            </Button>
          </div>
        )}
        {!available && !workspace.checking && (
          <button className="connection-hint" onClick={onSettings}>
            串流服務尚未就緒，前往設定檢查 <ArrowRightOutlined />
          </button>
        )}
        <Sender
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          placeholder={
            editingId
              ? "編輯原訊息後按 Enter 送出…"
              : "輸入網址、操作需求，或重跑流程名稱…"
          }
          autoSize={{ minRows: 3, maxRows: 8 }}
          readOnly={!!runningId}
          suffix={false}
          footer={
            <div className="composer-footer">
              <Tooltip title="將目前頁面網址帶入輸入框">
                <Button
                  type="text"
                  size="small"
                  icon={<LinkOutlined />}
                  aria-label="加入目前頁面網址"
                  disabled={!browser.url || !!runningId}
                  onClick={() =>
                    setDraft(
                      (value) => `${value}${value ? "\n" : ""}${browser.url}`,
                    )
                  }
                />
              </Tooltip>
              <span>Enter 傳送 · Shift + Enter 換行</span>
              {running ? (
                <Button
                  className="send-button"
                  icon={<StopOutlined />}
                  aria-label="停止執行"
                  onClick={workspace.stop}
                />
              ) : (
                <Button
                  type="primary"
                  className="send-button"
                  icon={<ArrowUpOutlined />}
                  aria-label="傳送訊息"
                  disabled={!draft.trim() || !available || !!runningId}
                  onClick={() => void submit()}
                />
              )}
            </div>
          }
        />
      </div>
    </section>
  );
}
