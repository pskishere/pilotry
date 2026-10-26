import { tool } from "ai";
import { z } from "zod";
import { ACTIONS, compileRecording, replayWorkflow } from "./workflows.mjs";

export function workflowTools({
  store,
  recorded,
  emit,
  signal,
  execute,
  state,
  repair,
  onHuman,
}) {
  const executed = new Set();
  const replayedSteps = [];
  const recordReplayStep = (step) => {
    const index = replayedSteps.findIndex((item) => item.id === step.id);
    if (index >= 0) replayedSteps[index] = step;
    else replayedSteps.push(step);
  };
  const successful = () => [
    ...new Map(
      recorded()
        .filter(
          (item) =>
            item && item.status === "success" && ACTIONS.includes(item.action),
        )
        .map((item) => [item.id, item]),
    ).values(),
  ];
  return {
    list_workflows: tool({
      description:
        "列出已保存的流程及可替换参数。用户要求执行已有流程时先读取此清单，不要重新自行规划相同步骤。",
      inputSchema: z.object({}),
      execute: async () =>
        (await store.list()).map((flow) => {
          const lastRun = flow.lastRun
            ? { ...flow.lastRun, steps: undefined }
            : undefined;
          return {
            id: flow.id,
            name: flow.name,
            parameters: flow.parameters,
            stepCount: flow.steps.length,
            lastRun,
          };
        }),
    }),
    list_recorded_steps: tool({
      description:
        "读取目前对话已成功执行的浏览器步骤，供用户要求保存流程时选择实际记录。不得捏造步骤。",
      inputSchema: z.object({}),
      execute: async () =>
        successful().map((step) => ({
          id: step.id,
          action: step.action,
          summary: step.summary,
          args: step.args,
          beforeUrl: step.before?.url,
          resultUrl: step.result?.page?.url,
        })),
    }),
    save_workflow: tool({
      description:
        "将用户指定的成功步骤保存为可重跑流程。stepIds 必须取自 list_recorded_steps；此工具只保存，不会执行网页操作。",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        stepIds: z.array(z.string()).min(1).max(256),
      }),
      execute: async ({ name, stepIds }) => {
        signal.throwIfAborted();
        const selected = successful().filter((item) =>
          stepIds.includes(item.id),
        );
        if (selected.length !== new Set(stepIds).size)
          return { success: false, error: "步骤不在实际成功记录中。" };
        const first = selected[0];
        const startUrl =
          first.action === "open_url"
            ? first.args.url
            : first.before?.url ||
              first.args.snapshotUrl ||
              first.result?.page?.url;
        if (!startUrl)
          return {
            success: false,
            error: "无法确认起始网址，请使用工作台的保存流程功能填写。",
          };
        const flow = await store.save(
          compileRecording({ name, startUrl, records: selected }),
        );
        emit({ type: "status", message: "流程「" + flow.name + "」已保存。" });
        return {
          success: true,
          id: flow.id,
          name: flow.name,
          parameters: flow.parameters,
          stepCount: flow.steps.length,
        };
      },
    }),
    run_workflow: tool({
      description:
        "直接执行用户要求的已保存流程，正常时不逐步呼叫模型；即时回报工具记录。每个流程在同一指令内只能执行一次，成功后直接回报结果。",
      inputSchema: z.object({
        id: z.string().uuid(),
        parameters: z.record(z.string(), z.string()).default({}),
        repairEnabled: z.boolean().default(true),
        startIndex: z.number().int().min(0).max(256).optional(),
        resume: z.boolean().optional(),
      }),
      execute: async ({
        id,
        parameters,
        repairEnabled,
        startIndex,
        resume,
      }) => {
        signal.throwIfAborted();
        if (executed.has(id))
          return {
            success: false,
            error: "本次指令已执行过此流程，请勿自动重复执行。",
          };
        const flow = await store.get(id);
        if (!flow) return { success: false, error: "找不到流程。" };
        executed.add(id);
        const run = await replayWorkflow(flow, parameters, {
          signal,
          execute,
          state,
          repair,
          emit,
          repairEnabled,
          startIndex: startIndex ?? 0,
          resume: resume === true,
          onStep: recordReplayStep,
          onRun: (finished) => (finished.steps = replayedSteps),
          onVerifiedRepairs: (updates) =>
            store.updateLocators(id, flow.updatedAt, updates),
        });
        run.steps = replayedSteps;
        await store.recordRun(id, run);
        if (run.status === "awaiting_human" && run.human) onHuman?.(run.human);
        return { success: run.status === "success", name: flow.name, run };
      },
    }),
  };
}
