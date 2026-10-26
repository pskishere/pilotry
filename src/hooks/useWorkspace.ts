import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamAgent, streamWorkflow } from "../api";
import type { AgentEvent, AiStatus, BrowserStateDetail } from "../api";
import type {
  ChatMessage,
  Conversation,
  Preferences,
  TicketOrder,
  TicketTask,
  Workflow,
} from "../types";
import { errorText, newConversation, OFFLINE_BROWSER } from "../model";

const SESSION_KEY = "pilotry:sessions:v1";
const PREFS_KEY = "pilotry:preferences:v1";

function loadSessions(): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(SESSION_KEY) ?? "null",
    );
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(
        (item): item is Conversation =>
          typeof item?.id === "string" &&
          typeof item?.title === "string" &&
          Array.isArray(item.messages) &&
          Array.isArray(item.steps),
      );
      if (valid.length)
        return valid.slice(0, 12).map((item) => ({
          ...item,
          steps: item.steps.map((step) =>
            step.status === "running"
              ? {
                  ...step,
                  status: "error" as const,
                  result: { error: "前次连接已结束，请先确认页面状态。" },
                }
              : step,
          ),
        }));
    }
  } catch {
    /* 保存空间不可用时仍可使用当前工作阶段。 */
  }
  return [newConversation()];
}

export function useWorkspace() {
  const [online, setOnline] = useState(false);
  const [agentOnline, setAgentOnline] = useState(false);
  const [checking, setChecking] = useState(true);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [browser, setBrowser] = useState<BrowserStateDetail>(OFFLINE_BROWSER);
  const [tasks, setTasks] = useState<TicketTask[]>([]);
  const [orders, setOrders] = useState<TicketOrder[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowError, setWorkflowError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [sessions, setSessions] = useState(loadSessions);
  const [activeId, setActiveId] = useState(() => sessions[0].id);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
      return {
        livePreview: saved.livePreview !== false,
        frameInterval: [1200, 2500, 5000].includes(saved.frameInterval)
          ? saved.frameInterval
          : 2500,
        agentMaxSteps: [32, 64, 128, 256].includes(saved.agentMaxSteps)
          ? saved.agentMaxSteps
          : 64,
        agentTimeoutMinutes: [5, 15, 30, 60].includes(saved.agentTimeoutMinutes)
          ? saved.agentTimeoutMinutes
          : 15,
      };
    } catch {
      return {
        livePreview: true,
        frameInterval: 2500,
        agentMaxSteps: 64,
        agentTimeoutMinutes: 15,
      };
    }
  });
  const refreshing = useRef(false);
  const runRef = useRef<AbortController | null>(null);
  const session = sessions.find((item) => item.id === activeId) ?? sessions[0];

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify(
            sessions.slice(0, 12).map((item) => ({
              ...item,
              messages: item.messages.slice(-60),
              steps: item.steps.slice(-256).map((step, index, records) => {
                const page = step.result?.page as
                  | { url?: string; title?: string; pageType?: string }
                  | undefined;
                const dataset = step.result?.dataset;
                const keepDataset =
                  dataset &&
                  !records
                    .slice(index + 1)
                    .some((record) => Boolean(record.result?.dataset)) &&
                  JSON.stringify(dataset).length <= 131072;
                return {
                  ...step,
                  result: step.result
                    ? {
                        ...step.result,
                        page: page
                          ? {
                              url: page.url,
                              title: page.title,
                              pageType: page.pageType,
                            }
                          : undefined,
                        dataset: keepDataset ? dataset : undefined,
                        ...(dataset && !keepDataset
                          ? {
                              dataNote:
                                "数据未快取至对话；请于提取完成后下载保留。",
                            }
                          : {}),
                      }
                    : undefined,
                };
              }),
            })),
          ),
        );
      } catch {
        /* 不阻断对话。 */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [sessions]);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    } catch {
      /* 不阻断设置。 */
    }
  }, [preferences]);
  useEffect(
    () => () => {
      runRef.current?.abort();
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const signal = AbortSignal.timeout(12000);
    const [health, page, taskList, orderList, agent, flowList] =
      await Promise.allSettled([
        api.health(signal),
        api.browserState(signal),
        api.listTasks(signal),
        api.listOrders(signal),
        api.agentHealth(signal),
        api.listWorkflows(signal),
      ]);
    setOnline(health.status === "fulfilled" && health.value.status === "ok");
    setAi(health.status === "fulfilled" ? (health.value.ai ?? null) : null);
    setBrowser(page.status === "fulfilled" ? page.value : OFFLINE_BROWSER);
    if (taskList.status === "fulfilled") setTasks(taskList.value);
    if (orderList.status === "fulfilled") setOrders(orderList.value);
    if (flowList.status === "fulfilled") setWorkflows(flowList.value);
    setWorkflowError(
      flowList.status === "rejected"
        ? "流程库暂时无法读取，请检查流式服务。"
        : "",
    );
    setAgentOnline(agent.status === "fulfilled" && agent.value.status === "ok");
    setLoadError(
      taskList.status === "rejected" || orderList.status === "rejected"
        ? "任务或订单暂时无法同步，画面保留上次取得的数据。"
        : "",
    );
    setChecking(false);
    refreshing.current = false;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (!disposed) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  const updateSession = (
    id: string,
    update: (current: Conversation) => Conversation,
  ) => {
    setSessions((current) =>
      current.map((item) => (item.id === id ? update(item) : item)),
    );
  };

  const send = async (
    text: string,
    replay?: {
      flow: Workflow;
      parameters: Record<string, string>;
      repairEnabled: boolean;
      startIndex?: number;
      resume?: boolean;
    },
    options?: {
      history?: ChatMessage[];
      recordedSteps?: import("../types").AgentStep[];
      turnId?: string;
      appendUser?: boolean;
      reuseConversationId?: boolean;
    },
  ) => {
    if (!text.trim() || runRef.current) return;
    if (!online || !agentOnline)
      throw new Error("引擎或流式服务未连接，请至设置检查连接。");
    const conversation = replay
      ? options?.reuseConversationId
        ? session
        : newConversation()
      : session;
    const id = conversation.id;
    const turnId = options?.turnId ?? crypto.randomUUID();
    const appendUser = options?.appendUser !== false;
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text.trim(),
      createdAt: new Date().toISOString(),
      turnId,
    };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      turnId,
    };
    const controller = new AbortController();
    runRef.current = controller;
    setRunningId(id);
    setPhase(replay ? "开始直接重跑流程" : "正在连接模型");
    if (replay) {
      if (options?.reuseConversationId) {
        updateSession(id, (item) => ({
          ...item,
          agentRun: undefined,
          workflowRun: undefined,
          workflowResume: undefined,
          messages: [...item.messages, user, assistant],
          updatedAt: new Date().toISOString(),
        }));
      } else {
        setSessions((current) =>
          [
            {
              ...conversation,
              title: "流程 · " + replay.flow.name,
              messages: [user, assistant],
            },
            ...current,
          ].slice(0, 12),
        );
        setActiveId(id);
      }
    } else {
      updateSession(id, (item) => ({
        ...item,
        agentRun: undefined,
        title: item.messages.length ? item.title : text.trim().slice(0, 24),
        messages: appendUser
          ? [...item.messages, user, assistant]
          : [...item.messages, assistant],
        updatedAt: new Date().toISOString(),
      }));
    }
    const invoke = (
      onEvent: (event: AgentEvent) => void,
      signal: AbortSignal,
    ) =>
      replay
        ? streamWorkflow(
            replay.flow.id,
            replay.parameters,
            replay.repairEnabled,
            onEvent,
            signal,
            replay.startIndex,
            replay.resume,
          )
        : streamAgent(
            text,
            options?.history ?? session.messages,
            onEvent,
            signal,
            options?.recordedSteps ?? session.steps,
            {
              maxSteps: preferences.agentMaxSteps,
              timeoutMinutes: preferences.agentTimeoutMinutes,
            },
          );
    try {
      await invoke((rawEvent) => {
        const event =
          rawEvent.type === "step"
            ? {
                ...rawEvent,
                step: { ...rawEvent.step, turnId },
              }
            : rawEvent;
        if (event.type === "run-state")
          updateSession(id, (item) => ({ ...item, agentRun: event.run }));
        if (event.type === "status") setPhase(event.message);
        if (event.type === "text-delta") {
          setPhase("正在回复");
          updateSession(id, (item) => ({
            ...item,
            messages: item.messages.map((msg) =>
              msg.id === assistant.id
                ? { ...msg, content: msg.content + event.text }
                : msg,
            ),
          }));
        }
        if (event.type === "step") {
          setPhase(
            event.step.status === "running"
              ? event.step.summary
              : "正在处理执行结果",
          );
          updateSession(id, (item) => ({
            ...item,
            steps: item.steps.some((step) => step.id === event.step.id)
              ? item.steps.map((step) =>
                  step.id === event.step.id ? event.step : step,
                )
              : [...item.steps, event.step],
          }));
          if (event.step.status !== "running") void refresh();
        }
        if (event.type === "workflow") {
          updateSession(id, (item) => ({
            ...item,
            workflowRun: event.run,
            workflowResume:
              event.run.status === "awaiting_human" && replay
                ? {
                    flowId: replay.flow.id,
                    parameters: replay.parameters,
                    repairEnabled: replay.repairEnabled,
                    startIndex: event.run.resumeIndex ?? 0,
                  }
                : undefined,
            steps: event.run.steps?.length ? event.run.steps : item.steps,
          }));
          if (event.state === "finished")
            setWorkflows((current) =>
              current.map((flow) =>
                flow.id === event.workflowId
                  ? { ...flow, lastRun: event.run }
                  : flow,
              ),
            );
        }
      }, controller.signal);
    } catch (error) {
      const content = controller.signal.aborted
        ? "已停止执行；已送出的浏览器操作可能仍会完成，请查看页面状态。"
        : errorText(error);
      updateSession(id, (item) => ({
        ...item,
        messages: [
          ...item.messages.filter(
            (msg) => msg.id !== assistant.id || msg.content,
          ),
          {
            id: crypto.randomUUID(),
            role: "system",
            content,
            createdAt: new Date().toISOString(),
          },
        ],
        steps: item.steps.map((step) =>
          step.status === "running"
            ? { ...step, status: "error", result: { error: content } }
            : step,
        ),
      }));
    } finally {
      updateSession(id, (item) => ({
        ...item,
        messages: item.messages.filter(
          (msg) => msg.id !== assistant.id || msg.content,
        ),
      }));
      runRef.current = null;
      setRunningId(null);
      setPhase("");
      void refresh();
    }
  };

  const createSession = () => {
    const next = newConversation();
    setSessions((current) => [next, ...current].slice(0, 12));
    setActiveId(next.id);
  };

  const turnIdsFrom = (messageId: string) => {
    const index = session.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return { index, ids: [] as string[] };
    return {
      index,
      ids: session.messages
        .slice(index)
        .map((item) => item.turnId)
        .filter((value): value is string => Boolean(value)),
    };
  };

  const editMessage = async (messageId: string, content: string) => {
    if (runRef.current) throw new Error("另一个工作正在执行，请稍后再试。");
    const trimmed = content.trim();
    if (!trimmed) throw new Error("请输入要送出的内容。");
    if (trimmed.length > 12000)
      throw new Error("请输入 1 至 12000 个字元。");
    if (!online || !agentOnline)
      throw new Error("引擎或流式服务未连接，请至设置检查连接。");
    const { index, ids } = turnIdsFrom(messageId);
    const target = session.messages[index];
    if (!target || target.role !== "user")
      throw new Error("找不到可编辑的用户消息。");
    const history = session.messages.slice(0, index);
    const turnId = target.turnId ?? crypto.randomUUID();
    const recordedSteps = session.steps.filter(
      (step) => !step.turnId || !ids.includes(step.turnId),
    );
    updateSession(session.id, (item) => ({
      ...item,
      agentRun: undefined,
      workflowRun: undefined,
      messages: [
        ...history,
        {
          ...target,
          content: trimmed,
          createdAt: target.createdAt,
          turnId,
        },
      ],
      steps: recordedSteps,
      updatedAt: new Date().toISOString(),
    }));
    await send(trimmed, undefined, {
      history,
      recordedSteps,
      turnId,
      appendUser: false,
    });
  };

  const retryMessage = async (messageId: string) => {
    if (runRef.current) throw new Error("另一个工作正在执行，请稍后再试。");
    if (!online || !agentOnline)
      throw new Error("引擎或流式服务未连接，请至设置检查连接。");
    const target = session.messages.find((item) => item.id === messageId);
    const userIndex = target
      ? target.role === "user"
        ? session.messages.findIndex((item) => item.id === messageId)
        : Math.max(
            -1,
            session.messages
              .slice(0, session.messages.findIndex((item) => item.id === messageId))
              .map((item) => item.role)
              .lastIndexOf("user"),
          )
      : -1;
    const user =
      target?.role === "user"
        ? target
        : userIndex >= 0
          ? session.messages[userIndex]
          : undefined;
    if (!user) throw new Error("找不到要重试的指令。");
    const { index, ids } = turnIdsFrom(user.id);
    if (index < 0) throw new Error("找不到要重试的指令。");
    const history = session.messages.slice(0, index);
    const turnId = user.turnId ?? crypto.randomUUID();
    const recordedSteps = session.steps.filter(
      (step) => !step.turnId || !ids.includes(step.turnId),
    );
    updateSession(session.id, (item) => ({
      ...item,
      agentRun: undefined,
      workflowRun: undefined,
      messages: [...history, { ...user, turnId }],
      steps: recordedSteps,
      updatedAt: new Date().toISOString(),
    }));
    await send(user.content, undefined, {
      history,
      recordedSteps,
      turnId,
      appendUser: false,
    });
  };

  const resumeHuman = async () => {
    const run = session.agentRun;
    if (!run || run.state !== "awaiting_human") return;
    const reason = run.human?.reason || run.reason || "login";
    const instruction = run.human?.instruction
      ? run.human.instruction + " "
      : "";
    await send(
      "用户已完成人工处理（" +
        reason +
        "）。" +
        instruction +
        "请先分析当前页面，确认状态后继续之前未完成的目标；不要从起始网址重跑，也不要重复已成功的操作。",
    );
  };

  const trustCurrentPage = async () => {
    if (!browser.url) throw new Error("当前没有已打开的页面。");
    await api.trustPage(browser.url, true);
    await refresh();
  };

  const trustAndResumeHuman = async () => {
    await trustCurrentPage();
    await resumeHuman();
  };

  const resumeWorkflow = async () => {
    if (runRef.current) throw new Error("另一个工作正在执行，请稍后再试。");
    const resume = session.workflowResume;
    if (!resume) throw new Error("没有可继续的流程。");
    const flow = workflows.find((item) => item.id === resume.flowId);
    if (!flow) throw new Error("找不到原流程，请重新打开流程库。");
    await send(
      "继续执行流程「" + flow.name + "」（人工步骤已完成）",
      {
        flow,
        parameters: resume.parameters,
        repairEnabled: resume.repairEnabled,
        startIndex: resume.startIndex,
        resume: true,
      },
      { reuseConversationId: true },
    );
  };

  const trustAndResumeWorkflow = async () => {
    await trustCurrentPage();
    await resumeWorkflow();
  };

  const removeSession = (id: string) => {
    if (runRef.current) return;
    const remaining = sessions.filter((item) => item.id !== id);
    const next = remaining.length ? remaining : [newConversation()];
    setSessions(next);
    if (activeId === id) setActiveId(next[0].id);
  };

  return {
    online,
    agentOnline,
    checking,
    ai,
    browser,
    setBrowser,
    tasks,
    setTasks,
    orders,
    workflows,
    setWorkflows,
    workflowError,
    loadError,
    refresh,
    sessions,
    session,
    activeId,
    setActiveId,
    createSession,
    removeSession,
    runningId,
    phase,
    send,
    editMessage,
    retryMessage,
    runWorkflow: (
      flow: Workflow,
      parameters: Record<string, string>,
      repairEnabled: boolean,
    ) =>
      send(
        "执行流程「" +
          flow.name +
          "」\n" +
          flow.parameters
            .map(
              (parameter) =>
                parameter.label +
                "：" +
                (parameters[parameter.name] ?? parameter.defaultValue),
            )
            .join("\n"),
        { flow, parameters, repairEnabled },
      ),
    resumeHuman,
    resumeWorkflow,
    trustAndResumeHuman,
    trustAndResumeWorkflow,
    stop: () => runRef.current?.abort(),
    preferences,
    setPreferences,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
