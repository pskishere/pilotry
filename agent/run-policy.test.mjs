import { test } from "node:test";
import assert from "node:assert/strict";
import { streamText, tool, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { DEFAULT_RUN_LIMITS, parseRunLimits, pauseForSteps } from "./run-policy.mjs";

const result = (toolName, output) => ({ toolResults: [{ toolName, output }] });
const success = () => result("open_url", { success: true });
test("execution budget defaults to 64 rounds, not 8", () => {
  assert.deepEqual(parseRunLimits(), { maxSteps: 64, timeoutMinutes: 15 });
  assert.equal(pauseForSteps(Array.from({ length: 9 }, success), DEFAULT_RUN_LIMITS), null);
  assert.equal(pauseForSteps(Array.from({ length: 64 }, success), DEFAULT_RUN_LIMITS)?.reason, "step_budget");
});
test("negative budgets and unknown limit fields are rejected", () => {
  for (const input of [{ maxSteps: -1 }, { timeoutMinutes: -1 }, { maxSteps: 64, unknown: true }]) assert.throws(() => parseRunLimits(input));
});
test("invalid or unlimited budgets are rejected", () => {
  for (const input of [{ maxSteps: 0 }, { maxSteps: 257 }, { maxSteps: "128" }, { timeoutMinutes: 0 }, { timeoutMinutes: 61 }, { unknown: true }]) assert.throws(() => parseRunLimits(input));
});
test("three consecutive unsuccessful tool results stop the loop", () => {
  const failure = result("click_element", { success: false, error: "Not found" });
  assert.equal(pauseForSteps([failure, failure], DEFAULT_RUN_LIMITS), null);
  assert.equal(pauseForSteps([failure, failure, failure], DEFAULT_RUN_LIMITS)?.reason, "repeated_failure");
  assert.equal(pauseForSteps([failure, success(), failure, failure], DEFAULT_RUN_LIMITS), null);
});
test("tool execution exceptions are counted as failures", () => {
  const failure = { content: [{ type: "tool-error", error: "Offline" }] };
  assert.equal(pauseForSteps([failure, failure, failure], DEFAULT_RUN_LIMITS)?.reason, "repeated_failure");
});
test("unchanged repeated analysis pauses, changing pages and waits do not", () => {
  const observe = result("analyze_page", { success: true, page: { url: "https://example.org", title: "A", text: "A" } });
  assert.equal(pauseForSteps(Array(6).fill(observe), DEFAULT_RUN_LIMITS)?.reason, "no_progress");
  assert.equal(pauseForSteps(Array.from({ length: 12 }, (_, i) => result("analyze_page", { success: true, page: { text: String(i) } })), DEFAULT_RUN_LIMITS), null);
  assert.equal(pauseForSteps(Array(12).fill(result("wait_for_page", { success: true, settled: false })), DEFAULT_RUN_LIMITS), null);
});
test("streamText actually executes more than eight tool rounds and finishes naturally", async () => {
  let calls = 0;
  let executions = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    const current = calls++;
    const finished = current === 10;
    return { stream: simulateReadableStream({ initialDelayInMs: null, chunkDelayInMs: null, chunks: [
      { type: "stream-start", warnings: [] },
      ...(finished ? [{ type: "text-start", id: "final" }, { type: "text-delta", id: "final", delta: "Finished" }, { type: "text-end", id: "final" }] : [{ type: "tool-call", toolCallId: String(current), toolName: "test_operation", input: "{}" }]),
      { type: "finish", finishReason: { unified: finished ? "stop" : "tool-calls" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ] }) };
  } });
  const stream = streamText({ model, prompt: "Exercise the loop", stopWhen: ({ steps }) => Boolean(pauseForSteps(steps, DEFAULT_RUN_LIMITS)), tools: { test_operation: tool({ inputSchema: z.object({}), execute: async () => { executions++; return { success: true }; } }) } });
  await stream.consumeStream();
  assert.equal(await stream.finishReason, "stop");
  assert.equal(executions, 10);
  assert.equal(calls, 11);
  assert.equal(await stream.text, "Finished");
});
