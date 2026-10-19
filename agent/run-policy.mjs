import { createHash } from "node:crypto";
import { z } from "zod";

export const DEFAULT_RUN_LIMITS = Object.freeze({
  maxSteps: 64,
  timeoutMinutes: 15,
});
const limitsSchema = z
  .object({
    maxSteps: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(DEFAULT_RUN_LIMITS.maxSteps),
    timeoutMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(DEFAULT_RUN_LIMITS.timeoutMinutes),
  })
  .strict();

export function parseRunLimits(input) {
  return limitsSchema.parse(input ?? {});
}

export function pauseForSteps(steps, limits) {
  let failures = 0;
  let observations = 0;
  let previousPage = "";
  for (const step of steps) {
    for (const part of step.content ?? []) {
      if (part.type === "tool-error") failures++;
    }
    for (const result of step.toolResults ?? []) {
      const output = result.output;
      failures = output?.success === false ? failures + 1 : 0;
      if (failures >= 3)
        return {
          reason: "repeated_failure",
          message:
            "工具連續 3 次未完成，已暫停，避免重複操作。請查看執行記錄與目前頁面後再繼續。",
        };
      if (
        result.toolName === "analyze_page" &&
        output?.success &&
        output.page
      ) {
        const page = output.page;
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              page.url,
              page.title,
              page.text,
              page.buttons,
              page.forms,
            ]),
          )
          .digest("hex");
        observations = fingerprint === previousPage ? observations + 1 : 1;
        previousPage = fingerprint;
        if (observations >= 6)
          return {
            reason: "no_progress",
            message:
              "同一頁面已連續分析 6 次且內容未變更，已暫停。請補充下一步目標，或接手處理頁面。",
          };
      } else {
        observations = 0;
        previousPage = "";
      }
    }
    if (failures >= 3)
      return {
        reason: "repeated_failure",
        message:
          "工具連續 3 次失敗，已暫停，避免無限重試。請確認執行記錄後再繼續。",
      };
  }
  if (steps.length >= limits.maxSteps)
    return {
      reason: "step_budget",
      message: `本次已使用設定的 ${limits.maxSteps} 回合工具預算，已暫停，並非模型額度用完。可以從目前頁面繼續；執行預算可在設定調整。`,
    };
  return null;
}
