export type TaskStatus =
  | "created"
  | "monitoring"
  | "selecting"
  | "awaiting_approval"
  | "order_created"
  | "manual_payment"
  | "stopped"
  | "failed";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  turnId?: string;
}

export interface AgentStep {
  id: string;
  step: number;
  action: string;
  summary: string;
  args: Record<string, unknown>;
  status: "running" | "success" | "error";
  result?: Record<string, unknown>;
  timestamp: string;
  runId?: string;
  turnId?: string;
  mode?: "replay";
  repaired?: boolean;
  before?: { url: string; title?: string };
}

export interface WorkflowRun {
  id: string;
  status: "success" | "failed" | "cancelled";
  durationMs: number;
  completed: number;
  total: number;
  repairs: number;
  finishedAt: string;
  error?: string;
  steps?: AgentStep[];
}

export interface Workflow {
  id: string;
  name: string;
  startUrl: string;
  parameters: { name: string; label: string; defaultValue: string }[];
  steps: {
    id: string;
    action: string;
    summary: string;
    args: Record<string, string>;
    sourceUrl?: string;
    expectedUrl?: string;
  }[];
  createdAt: string;
  updatedAt: string;
  lastRun?: WorkflowRun;
}

export interface SaveWorkflowInput {
  name: string;
  startUrl: string;
  records: AgentStep[];
  bindings: { stepId: string; field: string; name: string; label: string }[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  steps: AgentStep[];
  updatedAt: string;
  workflowRun?: WorkflowRun;
  agentRun?: AgentRun;
}

export interface RunLimits {
  maxSteps: number;
  timeoutMinutes: number;
}

export interface AgentRun {
  id: string;
  state: "running" | "paused" | "finished";
  rounds: number;
  limits: RunLimits;
  reason?: string;
  message?: string;
}

export interface TicketOrder {
  id: string;
  platform: string;
  event: string;
  status: string;
  needsHuman: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Preferences {
  livePreview: boolean;
  frameInterval: number;
  agentMaxSteps: number;
  agentTimeoutMinutes: number;
}

export interface TicketTask {
  id: string;
  platform: string;
  event: string;
  url?: string;
  ticketNumber?: number;
  goal?: string;
  maxPrice?: number;
  status: TaskStatus;
  needsHuman: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserState {
  connected: boolean;
  url: string;
  pageType: string;
  confidence: number;
  title: string;
}
