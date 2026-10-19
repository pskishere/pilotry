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
        "列出已儲存的流程及可替換參數。使用者要求執行已有流程時先讀取此清單，不要重新自行規劃相同步驟。",
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
        "讀取目前對話已成功執行的瀏覽器步驟，供使用者要求儲存流程時選擇實際記錄。不得捏造步驟。",
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
        "將使用者指定的成功步驟儲存為可重跑流程。stepIds 必須取自 list_recorded_steps；此工具只保存，不會執行網頁操作。",
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
          return { success: false, error: "步驟不在實際成功記錄中。" };
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
            error: "無法確認起始網址，請使用工作台的儲存流程功能填寫。",
          };
        const flow = await store.save(
          compileRecording({ name, startUrl, records: selected }),
        );
        emit({ type: "status", message: "流程「" + flow.name + "」已儲存。" });
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
        "直接執行使用者要求的已儲存流程，正常時不逐步呼叫模型；即時回報工具記錄。每個流程在同一指令內只能執行一次，成功後直接回報結果。",
      inputSchema: z.object({
        id: z.string().uuid(),
        parameters: z.record(z.string(), z.string()).default({}),
        repairEnabled: z.boolean().default(true),
      }),
      execute: async ({ id, parameters, repairEnabled }) => {
        signal.throwIfAborted();
        if (executed.has(id))
          return {
            success: false,
            error: "本次指令已執行過此流程，請勿自動重複執行。",
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
          onStep: recordReplayStep,
          onRun: (finished) => (finished.steps = replayedSteps),
          onVerifiedRepairs: (updates) =>
            store.updateLocators(id, flow.updatedAt, updates),
        });
        run.steps = replayedSteps;
        await store.recordRun(id, run);
        return { success: run.status === "success", name: flow.name, run };
      },
    }),
  };
}
