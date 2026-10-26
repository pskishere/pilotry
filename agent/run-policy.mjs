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
            "工具连续 3 次未完成，已暂停，避免重复操作。请查看执行记录与目前页面后再继续。",
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
              "同一页面已连续分析 6 次且内容未变更，已暂停。请补充下一步目标，或接手处理页面。",
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
          "工具连续 3 次失败，已暂停，避免无限重试。请确认执行记录后再继续。",
      };
  }
  if (steps.length >= limits.maxSteps)
    return {
      reason: "step_budget",
      message: `本次已使用设置的 ${limits.maxSteps} 回合工具预算，已暂停，并非模型额度用完。可以从目前页面继续；执行预算可在设置调整。`,
    };
  return null;
}
