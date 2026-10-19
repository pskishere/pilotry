import type {
  AgentStep,
  AgentRun,
  ChatMessage,
  SaveWorkflowInput,
  TicketOrder,
  TicketTask,
  Workflow,
  WorkflowRun,
  RunLimits,
} from "./types";

export const ENGINE_URL = import.meta.env.VITE_ENGINE_URL || "http://127.0.0.1:8765";
export const AGENT_URL = import.meta.env.VITE_AGENT_URL || "http://127.0.0.1:8766";

function serializeSteps(steps: AgentStep[]) {
  return steps.map((step) => {
    const page = step.result?.page as
      | { url?: string; title?: string }
      | undefined;
    return {
      id: step.id,
      action: step.action,
      status: step.status,
      summary: step.summary,
      args: step.args,
      before: step.before,
      result: page ? { page: { url: page.url, title: page.title } } : undefined,
    };
  });
}

async function request<T>(
  path: string,
  init?: RequestInit,
  base = ENGINE_URL,
): Promise<T> {
  const response = await fetch(base + path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(60000),
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `請求失敗（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export interface AiStatus {
  provider: string;
  available: boolean;
  model: string;
  models: string[];
  error: string;
}

export interface BrowserButton {
  index: number;
  tag: string;
  text: string;
  id: string;
  cls: string;
  href: string;
  disabled: boolean;
  type?: string;
  role?: string;
  formAction?: string;
}

export interface BrowserStateDetail {
  runtime?: BrowserRuntime["current"];
  connected: boolean;
  url: string;
  pageType: string;
  confidence: number;
  title: string;
  buttons: BrowserButton[];
  forms: unknown[];
  error?: string;
}

export interface BrowserRuntime {
  current: {
    id: string;
    label: string;
    mode: "embedded" | "external";
    endpoint?: string;
  };
  browsers: { id: string; label: string; available: boolean; path: string }[];
}

export type AgentEvent =
  | { type: "run-state"; run: AgentRun }
  | { type: "status"; message: string }
  | { type: "text-delta"; text: string }
  | { type: "step"; step: AgentStep }
  | {
      type: "workflow";
      workflowId: string;
      state: "running" | "finished";
      run: WorkflowRun;
    }
  | { type: "error"; message: string }
  | { type: "done"; finishReason: string };

export const api = {
  browserRuntime: () => request<BrowserRuntime>("/api/browser/runtime"),
  configureBrowser: (configuration: Record<string, string>) =>
    request<BrowserStateDetail>("/api/browser/runtime", {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  browserTargets: (endpoint: string) =>
    request<{ id: string; title: string; url: string }[]>(
      "/api/browser/targets",
      { method: "POST", body: JSON.stringify({ endpoint }) },
    ),
  listWorkflows: (signal?: AbortSignal) =>
    request<Workflow[]>("/workflows", { signal }, AGENT_URL),
  saveWorkflow: (input: SaveWorkflowInput) =>
    request<Workflow>(
      "/workflows",
      {
        method: "POST",
        body: JSON.stringify({
          ...input,
          records: input.records.map((step) => {
            const page = step.result?.page as
              | { url?: string; title?: string }
              | undefined;
            return {
              id: step.id,
              action: step.action,
              status: step.status,
              summary: step.summary,
              args: step.args,
              before: step.before,
              result: page
                ? { page: { url: page.url, title: page.title } }
                : undefined,
            };
          }),
        }),
      },
      AGENT_URL,
    ),
  updateWorkflow: (flow: Workflow) =>
    request<Workflow>(
      "/workflows/" + encodeURIComponent(flow.id),
      { method: "PUT", body: JSON.stringify(flow) },
      AGENT_URL,
    ),
  deleteWorkflow: (id: string) =>
    request<{ success: boolean }>(
      "/workflows/" + encodeURIComponent(id),
      { method: "DELETE" },
      AGENT_URL,
    ),
  health: (signal?: AbortSignal) =>
    request<{ status: string; version: string; ai?: AiStatus }>("/api/health", {
      signal,
    }),
  agentHealth: async (
    signal?: AbortSignal,
  ): Promise<{ status: string; model: string; running?: boolean }> => {
    const response = await fetch(`${AGENT_URL}/health`, {
      signal: signal ?? AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("串流服務未連線");
    return response.json();
  },
  browserState: (signal?: AbortSignal) =>
    request<BrowserStateDetail>("/api/browser/state", { signal }),
  browserScreenshot: (signal?: AbortSignal) =>
    request<{ data: string }>("/api/browser/screenshot", { signal }),
  listTasks: (signal?: AbortSignal) =>
    request<TicketTask[]>("/api/tasks", { signal }),
  listOrders: (signal?: AbortSignal) =>
    request<TicketOrder[]>("/api/orders", { signal }),
  createTask: (task: Partial<TicketTask>) =>
    request<TicketTask>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(task),
    }),
  openBrowser: (url: string) =>
    request<BrowserStateDetail>("/api/browser/open", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  approve: (id: string) =>
    request<TicketTask>(`/api/tasks/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  stop: (id: string) =>
    request<TicketTask>(`/api/tasks/${encodeURIComponent(id)}/stop`, {
      method: "POST",
    }),
};

export async function streamAgent(
  message: string,
  history: ChatMessage[],
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
  recordedSteps: AgentStep[] = [],
  limits: RunLimits = { maxSteps: 64, timeoutMinutes: 15 },
) {
  return streamRequest(
    "/chat",
    {
      message,
      history: history.filter((item) => item.role !== "system").slice(-16),
      recordedSteps: serializeSteps(recordedSteps).slice(-256),
      limits,
    },
    onEvent,
    signal,
  );
}

export function streamWorkflow(
  id: string,
  parameters: Record<string, string>,
  repairEnabled: boolean,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
) {
  return streamRequest(
    "/workflows/" + encodeURIComponent(id) + "/run",
    { parameters, repairEnabled },
    onEvent,
    signal,
  );
}

async function streamRequest(
  path: string,
  body: unknown,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
) {
  const response = await fetch(AGENT_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `串流連線失敗（${response.status}）`);
  }
  if (!response.body) throw new Error("瀏覽器無法讀取串流回應");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as AgentEvent;
        if (event.type === "done") completed = true;
        if (event.type === "error") throw new Error(event.message);
        onEvent(event);
      }
      if (done) break;
    }
    if (!completed) throw new Error("連線提前中斷；請確認執行記錄後再繼續。");
  } finally {
    reader.releaseLock();
  }
}
