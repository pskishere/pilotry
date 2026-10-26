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
import { ACTION_LABELS, errorText, formatTime } from "../model";
import { recordableSteps } from "./SaveWorkflowModal";

const HUMAN_REASON_LABELS: Record<string, string> = {
  login: "登录",
  captcha: "验证码",
  "2fa": "两步验证",
  payment: "付款确认",
  confirm: "确认操作",
  other: "人工处理",
};

const SUGGESTIONS = [
  {
    key: "analyze",
    icon: <FileSearchOutlined />,
    title: "分析页面",
  },
  {
    key: "browse",
    icon: <GlobalOutlined />,
    title: "浏览网站",
  },
  {
    key: "record",
    icon: <SlidersOutlined />,
    title: "记录流程",
  },
];

function stepDetail(step: Conversation["steps"][number]) {
  const lines: string[] = [];
  const args = Object.entries(step.args ?? {}).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  const argText = args.length ? JSON.stringify(Object.fromEntries(args)) : "";
  if (argText) lines.push(`输入 ${argText}`);
  const before = step.before?.url;
  if (before) lines.push(`执行前 ${before}`);
  if (typeof step.result?.error === "string")
    lines.push(`错误 ${step.result.error}`);
  if (step.result?.page) {
    const page = step.result.page as { url?: string; title?: string };
    if (page.url) lines.push(`执行后 ${page.url}`);
    if (page.title) lines.push(`标题 ${page.title}`);
  }
  if (step.result?.run) {
    const run = step.result.run as {
      completed?: number;
      total?: number;
      repairs?: number;
    };
    if (typeof run.total === "number")
      lines.push(
        `流程 ${run.completed ?? 0}/${run.total} 完成，修复 ${
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
  const canTrust = Boolean(
    browser.challenge &&
      ["payment", "captcha", "2fa"].includes(browser.challenge.type),
  );
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
                <Tag className="repair-tag">已修复定位</Tag>
              )}
              {step.status === "awaiting_human" && (
                <Tag color="warning" className="human-tag">
                  等待人工
                </Tag>
              )}
            </span>
          ),
          description: step.summary,
          status:
            step.status === "running" || step.status === "awaiting_human"
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
      if (!available) throw new Error("引擎或流式服务未连接，请检查连接设置。");
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
          ? `分析目前页面 ${browser.url}，列出活动信息与可操作项目。`
          : "请分析这个活动页面："
          : key === "browse"
          ? "打开这个网址并分析可以操作的项目："
            : "连续完成这个页面的操作；完成后列出可保存的成功步骤。";
    setDraft(content);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
        ?.focus(),
    );
  };

  return (
    <section className="chat-panel panel" aria-label="Pilotry 对话">
      <div
        className="chat-content"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        }}
        role="log"
        aria-label="对话记录"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!session.messages.length ? (
          <div className="chat-welcome">
            <h3>新的对话</h3>
            <p>输入网址、操作需求，或指定要重跑的流程。</p>
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
                  content={item.content || "正在处理…"}
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
                            编辑
                          </Button>
                        ) : (
                          <Button size="small" type="text" icon={<RedoOutlined />} onClick={() => void retry(item.id)}>
                            重试
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
                <strong>执行思考链</strong>
                {running && session.agentRun && (
                  <span>
                    第 {session.agentRun.rounds} /{" "}
                    {session.agentRun.limits.maxSteps} 回合
                  </span>
                )}
                {!running && <span>{thoughtItems.length} 个工具步骤</span>}
              </div>
              <button
                className="agent-thought-toggle"
                onClick={() => setThoughtOpen((open) => !open)}
                aria-expanded={thoughtOpen}
              >
                {thoughtOpen ? "收起" : "展开"}
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
                  <span>{phase || "正在处理"}</span>
                </div>
              )
            )}
          </div>
        )}
      </div>
      <div className="chat-composer">
        {editingId && !running && (
          <div className="conversation-tools edit-notice">
            <span>正在编辑消息；送出后将取代原对话分支。</span>
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
              保存成功步骤为流程
            </Button>
          </div>
        )}
        {!runningId && session.agentRun?.state === "awaiting_human" && (
          <div className="run-pause-control run-human-control" role="status">
            <span>
              需要人工处理（
              {HUMAN_REASON_LABELS[session.agentRun.human?.reason ?? ""] ??
                "登录或验证"}
              ）：
              {session.agentRun.human?.instruction ||
                session.agentRun.message ||
                "请在浏览器窗口中完成操作后继续。"}
            </span>
            <Button
              size="small"
              type="primary"
              disabled={!available}
              onClick={() => {
                void workspace
                  .resumeHuman()
                  .catch((error) => void message.error(errorText(error)));
              }}
            >
              我已完成，继续
            </Button>
            {canTrust && (
              <Button
                size="small"
                disabled={!available}
                onClick={() => {
                  void workspace
                    .trustAndResumeHuman()
                    .catch((error) => void message.error(errorText(error)));
                }}
              >
                误判？信任此页继续
              </Button>
            )}
          </div>
        )}
        {!runningId && session.workflowRun?.status === "awaiting_human" && (
          <div className="run-pause-control run-human-control" role="status">
            <span>
              流程已暂停：
              {session.workflowRun.human?.instruction ||
                session.workflowRun.error ||
                "请在浏览器窗口中完成操作后继续。"}
            </span>
            <Button
              size="small"
              type="primary"
              disabled={!available}
              onClick={() => {
                void workspace
                  .resumeWorkflow()
                  .catch((error) => void message.error(errorText(error)));
              }}
            >
              从当前步骤继续
            </Button>
            {canTrust && (
              <Button
                size="small"
                disabled={!available}
                onClick={() => {
                  void workspace
                    .trustAndResumeWorkflow()
                    .catch((error) => void message.error(errorText(error)));
                }}
              >
                误判？信任此页继续
              </Button>
            )}
          </div>
        )}
        {!runningId && session.agentRun?.state === "paused" && (
          <div className="run-pause-control">
            <span>
              {session.agentRun.reason === "step_budget"
                ? "工具预算已用完"
                : session.agentRun.reason === "timeout"
                  ? "执行时间已到"
                  : "执行已暂停"}
            </span>
            <Button
              size="small"
              disabled={!available}
              onClick={() =>
                void workspace.send(
                  "从目前浏览器页面与已记录步骤继续上一个未完成要求；先分析目前页面，不要从起始网址重跑，不要重复已成功的提交或点选。若原本目标已达成，直接回报结果。",
                )
              }
            >
              从目前页面继续
            </Button>
          </div>
        )}
        {!available && !workspace.checking && (
          <button className="connection-hint" onClick={onSettings}>
            流式服务尚未就绪，前往设置检查 <ArrowRightOutlined />
          </button>
        )}
        <Sender
          value={draft}
          onChange={setDraft}
          onSubmit={() => void submit()}
          placeholder={
            editingId
              ? "编辑原消息后按 Enter 送出…"
              : "输入网址、操作需求，或重跑流程名称…"
          }
          autoSize={{ minRows: 3, maxRows: 8 }}
          readOnly={!!runningId}
          suffix={false}
          footer={
            <div className="composer-footer">
              <Tooltip title="将目前页面网址带入输入框">
                <Button
                  type="text"
                  size="small"
                  icon={<LinkOutlined />}
                  aria-label="加入目前页面网址"
                  disabled={!browser.url || !!runningId}
                  onClick={() =>
                    setDraft(
                      (value) => `${value}${value ? "\n" : ""}${browser.url}`,
                    )
                  }
                />
              </Tooltip>
              <span>Enter 发送 · Shift + Enter 换行</span>
              {running ? (
                <Button
                  className="send-button"
                  icon={<StopOutlined />}
                  aria-label="停止执行"
                  onClick={workspace.stop}
                />
              ) : (
                <Button
                  type="primary"
                  className="send-button"
                  icon={<ArrowUpOutlined />}
                  aria-label="发送消息"
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
