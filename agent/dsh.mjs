import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export class DshError extends Error {}

export function dshPath() {
  const candidates = [
    process.env.PILOTRY_DSH_PATH,
    "/usr/local/bin/dsh",
    "/opt/homebrew/bin/dsh",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

export function dshProfile() {
  return process.env.PILOTRY_DSH_PROFILE || "headless";
}

export function foldDshEvent(state, event) {
  if (!event || typeof event !== "object") return state;
  if (event.type === "session" && typeof event.sessionId === "string") {
    state.sessionId = event.sessionId;
  } else if (event.type === "text" && typeof event.text === "string") {
    state.text.push(event.text);
  } else if (event.type === "final" && typeof event.text === "string") {
    state.answer = event.text;
  } else if (event.type === "status") {
    if (event.phase === "turn_start" && Number.isFinite(event.turn))
      state.turns = Math.max(state.turns, event.turn);
    if (
      event.phase === "step_end" &&
      Number.isFinite(event.usage?.totalTokens)
    )
      state.totalTokens += event.usage.totalTokens;
    if (event.phase === "turn_end")
      state.completed = event.reason?.kind === "completed";
  }
  return state;
}

export async function runDshTask(
  task,
  {
    dsh = dshPath(),
    profile = dshProfile(),
    timeoutSeconds = Number(
      process.env.PILOTRY_DSH_TIMEOUT_SECONDS || 600,
    ),
    signal,
    onEvent = () => {},
  } = {},
) {
  if (!dsh)
    throw new DshError(
      "未找到 dsh：请安装 DeepSeek Harness 或设置 PILOTRY_DSH_PATH。",
    );
  const child = spawn(dsh, ["--profile", profile, "--json", task], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    sessionId: "",
    text: [],
    answer: "",
    turns: 0,
    totalTokens: 0,
    completed: false,
  };
  let stderrTail = "";
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      foldDshEvent(state, event);
      if (event.type === "status" && event.phase === "turn_start")
        onEvent({
          type: "status",
          message: `dsh 第 ${event.turn ?? state.turns} 轮执行中`,
        });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  let timedOut = false;
  const finished = new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new DshError(
          error.code === "ENOENT"
            ? "未找到 dsh：请确认 DeepSeek Harness 已安装。"
            : `dsh 无法启动：${error.message}`,
        ),
      ),
    );
    child.once("close", (code) => resolve(code));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, Math.max(1, timeoutSeconds) * 1000);
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const code = await finished;
    if (signal?.aborted) throw new DshError("执行已停止");
    if (timedOut)
      throw new DshError(`dsh 任务超时（${timeoutSeconds} 秒），已中止。`);
    if (!state.answer) {
      const detail =
        stderrTail.trim().split("\n").filter(Boolean).pop() ||
        `dsh 任务未返回结果（退出码 ${code ?? "unknown"}）。`;
      throw new DshError(`dsh 任务未完成：${detail}`);
    }
    return {
      success: state.completed && Boolean(state.answer),
      answer: state.answer,
      partialText: state.text.join(""),
      sessionId: state.sessionId,
      turns: state.turns,
      totalTokens: state.totalTokens,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
}
