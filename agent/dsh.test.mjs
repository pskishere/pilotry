import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DshError, foldDshEvent, runDshTask } from "./dsh.mjs";

const EVENTS = [
  { type: "session", sessionId: "session-abc", cwd: "/tmp" },
  { type: "status", phase: "turn_start", turn: 1 },
  { type: "status", phase: "step_start", turn: 1, step: 1 },
  { type: "text", text: "2" },
  {
    type: "status",
    phase: "step_end",
    turn: 1,
    step: 1,
    usage: { inputTokens: 5899, outputTokens: 3, totalTokens: 5902 },
  },
  { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
  { type: "final", text: "2" },
];

const fakeDsh = (body) => {
  const dir = mkdtempSync(join(tmpdir(), "pilotry-dsh-"));
  const file = join(dir, "fake-dsh.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

test("foldDshEvent captures session, answer, turns and usage", () => {
  const state = {
    sessionId: "",
    text: [],
    answer: "",
    turns: 0,
    totalTokens: 0,
    completed: false,
  };
  for (const event of EVENTS) foldDshEvent(state, event);
  assert.equal(state.sessionId, "session-abc");
  assert.equal(state.answer, "2");
  assert.equal(state.turns, 1);
  assert.equal(state.totalTokens, 5902);
  assert.equal(state.completed, true);
});

test("foldDshEvent ignores malformed and unknown events", () => {
  const state = {
    sessionId: "",
    text: [],
    answer: "",
    turns: 0,
    totalTokens: 0,
    completed: false,
  };
  foldDshEvent(state, null);
  foldDshEvent(state, "not an object");
  foldDshEvent(state, { type: "mystery", data: 1 });
  foldDshEvent(state, { type: "text" });
  assert.deepEqual(state, {
    sessionId: "",
    text: [],
    answer: "",
    turns: 0,
    totalTokens: 0,
    completed: false,
  });
});

test("runDshTask streams turn statuses and returns the answer", async () => {
  const script = fakeDsh(
    `const lines = ${JSON.stringify(EVENTS)};
let index = 0;
const tick = () => {
  if (index < lines.length) {
    process.stdout.write(JSON.stringify(lines[index++]) + "\\n");
    setTimeout(tick, 5);
  }
};
tick();`,
  );
  const statuses = [];
  const result = await runDshTask("1+1", {
    dsh: script,
    onEvent: (event) => statuses.push(event),
  });
  assert.equal(result.success, true);
  assert.equal(result.answer, "2");
  assert.equal(result.sessionId, "session-abc");
  assert.equal(result.turns, 1);
  assert.equal(result.totalTokens, 5902);
  assert.deepEqual(statuses, [
    { type: "status", message: "dsh 第 1 轮执行中" },
  ]);
});

test("runDshTask reports a failed run instead of an answer", async () => {
  const script = fakeDsh(
    `process.stderr.write("gateway unavailable\\n");
process.exit(1);`,
  );
  await assert.rejects(
    runDshTask("do it", { dsh: script }),
    (error) =>
      error instanceof DshError && error.message.includes("gateway unavailable"),
  );
});

test("runDshTask enforces the timeout", async () => {
  const script = fakeDsh(`setInterval(() => {}, 1000);`);
  await assert.rejects(
    runDshTask("hang", { dsh: script, timeoutSeconds: 0.2 }),
    (error) =>
      error instanceof DshError && error.message.includes("超时"),
  );
});

test("runDshTask stops when the run is aborted", async () => {
  const script = fakeDsh(`setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const pending = runDshTask("long task", {
    dsh: script,
    signal: controller.signal,
  });
  await delay(100);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof DshError && error.message === "执行已停止",
  );
});
