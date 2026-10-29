import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const ACTIONS = [
  "open_url",
  "analyze_page",
  "wait_for_page",
  "click_link",
  "click_element",
  "extract_data",
];
const text = z.string().max(4096);
const parameterName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)
  .refine((value) => !["constructor", "prototype"].includes(value));
const argumentSchemas = {
  open_url: z.object({ url: text.min(1) }).strict(),
  analyze_page: z.object({}).strict(),
  wait_for_page: z.object({}).strict(),
  extract_data: z.object({ kind: z.enum(["text", "links", "tables"]) }).strict(),
  click_link: z.object({ text: text.min(1), href: text.min(1) }).strict(),
  click_element: z
    .object({
      id: text.default(""),
      text: text.min(1),
      snapshotUrl: text.optional(),
    })
    .strict(),
};
const parameterSchema = z.object({
  name: parameterName,
  label: z.string().min(1).max(120),
  defaultValue: text,
});
export const workflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  startUrl: text.min(1),
  parameters: z.array(parameterSchema).max(30),
  steps: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        action: z.enum(ACTIONS),
        summary: z.string().max(240),
        args: z.record(z.string(), text),
        sourceUrl: text.optional(),
        expectedUrl: text.optional(),
      }),
    )
    .min(1)
    .max(256),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: z
    .object({
      id: z.string(),
      status: z.enum(["success", "failed", "cancelled", "awaiting_human"]),
      durationMs: z.number(),
      completed: z.number(),
      total: z.number(),
      repairs: z.number(),
      finishedAt: z.string(),
      error: z.string().optional(),
      resumeIndex: z.number().int().min(0).optional(),
      human: z
        .object({ reason: z.string(), instruction: z.string() })
        .optional(),
    })
    .optional(),
});
const placeholder = /\{\{([a-z][a-z0-9_]*)\}\}/g;

export function render(value, parameters) {
  return value.replace(placeholder, (_, name) => {
    if (!Object.hasOwn(parameters, name))
      throw new Error("缺少流程参数：" + name);
    return parameters[name];
  });
}

export function httpUrl(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("流程只允许一般 HTTP(S) 网址。");
  return url;
}

function normalizeUrl(value) {
  const url = httpUrl(value);
  url.hash = "";
  url.searchParams.sort();
  return url.href;
}

// 跨实体回放（换演出/换商品重跑）时落地页同路径不同参数属预期，参数差异不算偏离。
function samePageShape(actual, expected) {
  try {
    const a = new URL(actual);
    const e = new URL(expected);
    return a.origin === e.origin && a.pathname === e.pathname;
  } catch {
    return false;
  }
}

export function validateWorkflow(input) {
  const flow = workflowSchema.parse(input);
  const names = flow.parameters.map((item) => item.name);
  if (new Set(names).size !== names.length)
    throw new Error("参数名称不可重复。");
  const defaults = Object.fromEntries(
    flow.parameters.map((item) => [item.name, item.defaultValue]),
  );
  httpUrl(render(flow.startUrl, defaults));
  const ids = new Set();
  for (const step of flow.steps) {
    if (ids.has(step.id)) throw new Error("步骤编号不可重复。");
    ids.add(step.id);
    argumentSchemas[step.action].parse(step.args);
    const args = Object.fromEntries(
      Object.entries(step.args).map(([key, value]) => [
        key,
        render(value, defaults),
      ]),
    );
    if (step.action === "open_url") httpUrl(args.url);
    if (step.sourceUrl) httpUrl(render(step.sourceUrl, defaults));
    if (step.expectedUrl)
      httpUrl(
        new URL(
          render(step.expectedUrl, defaults),
          render(step.sourceUrl || flow.startUrl, defaults),
        ).href,
      );
  }
  return flow;
}

export function compileRecording(input) {
  const body = z
    .object({
      name: z.string().trim().min(1).max(120),
      startUrl: z.string().url(),
      records: z
        .array(
          z.object({
            id: z.string(),
            action: z.enum(ACTIONS),
            status: z.literal("success"),
            summary: z.string().optional(),
            args: z.record(z.string(), z.unknown()),
            before: z.object({ url: z.string() }).passthrough().optional(),
            result: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .min(1)
        .max(256),
      bindings: z
        .array(
          z.object({
            stepId: z.string(),
            field: z.string(),
            name: parameterName,
            label: z.string().min(1).max(120),
          }),
        )
        .max(29)
        .default([]),
    })
    .parse(input);
  httpUrl(body.startUrl);
  const originalStart =
    (body.records[0].action === "open_url"
      ? body.records[0].args.url
      : undefined) ||
    body.records[0].before?.url ||
    body.records[0].args.snapshotUrl ||
    body.records[0].result?.page?.url ||
    body.startUrl;
  const parameters = [
    { name: "start_url", label: "起始网址", defaultValue: body.startUrl },
  ];
  let currentUrl = originalStart;
  const templateUrl = (url) => (url === originalStart ? "{{start_url}}" : url);
  const steps = body.records.map((record) => {
    const args = argumentSchemas[record.action].parse(record.args);
    const sourceUrl =
      record.action === "open_url"
        ? undefined
        : templateUrl(record.before?.url || args.snapshotUrl || currentUrl);
    const afterUrl = record.result?.page?.url || currentUrl;
    if (record.action === "open_url" && args.url === originalStart)
      args.url = "{{start_url}}";
    if (record.action === "click_element") delete args.snapshotUrl;
    for (const binding of body.bindings.filter(
      (item) => item.stepId === record.id,
    )) {
      if (
        !["url", "text", "href"].includes(binding.field) ||
        typeof args[binding.field] !== "string" ||
        binding.name === "start_url"
      )
        throw new Error("无效的参数对应。");
      parameters.push({
        name: binding.name,
        label: binding.label,
        defaultValue: args[binding.field],
      });
      args[binding.field] = "{{" + binding.name + "}}";
    }
    let expectedUrl =
      record.action !== "open_url" && afterUrl !== currentUrl
        ? templateUrl(afterUrl)
        : undefined;
    if (
      record.action === "click_link" &&
      new URL(record.args.href, currentUrl).href === afterUrl
    )
      expectedUrl = args.href;
    currentUrl = afterUrl;
    return {
      id: randomUUID(),
      action: record.action,
      summary: record.summary || record.action,
      args,
      sourceUrl,
      expectedUrl,
    };
  });
  const now = new Date().toISOString();
  return validateWorkflow({
    id: randomUUID(),
    name: body.name,
    startUrl: "{{start_url}}",
    parameters,
    steps,
    createdAt: now,
    updatedAt: now,
  });
}

export class WorkflowStore {
  constructor(
    directory = process.env.PILOTRY_DATA_DIR ||
      join(homedir(), ".pilotry"),
  ) {
    this.directory = directory;
    this.path = join(directory, "workflows.json");
    this.queue = Promise.resolve();
  }
  async list() {
    await this.queue;
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.workflows))
        throw new Error("Unsupported workflow storage");
      return data.workflows.map(validateWorkflow);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("流程文件无法读取；已保留原文件，未覆写。");
    }
  }
  async get(id) {
    return (await this.list()).find((item) => item.id === id);
  }
  async mutate(update) {
    const previous = this.queue;
    const task = previous.then(async () => {
      let flows;
      try {
        const data = JSON.parse(await readFile(this.path, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.workflows))
          throw new Error("Invalid data");
        flows = data.workflows.map(validateWorkflow);
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("流程文件无法读取；已保留原文件，未覆写。");
        flows = [];
      }
      const result = update(flows);
      if (flows.length > 200) throw new Error("流程库已达 200 笔上限。");
      await mkdir(this.directory, { recursive: true });
      const temporary = this.path + "." + randomUUID() + ".tmp";
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, workflows: flows }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporary, this.path);
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  save(flow) {
    const validated = validateWorkflow(flow);
    return this.mutate((flows) => {
      const index = flows.findIndex((item) => item.id === validated.id);
      if (index < 0) flows.unshift(validated);
      else flows[index] = validated;
      return validated;
    });
  }
  remove(id) {
    return this.mutate((flows) => {
      const index = flows.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("找不到流程。");
      flows.splice(index, 1);
    });
  }
  recordRun(id, run) {
    return this.mutate((flows) => {
      const flow = flows.find((item) => item.id === id);
      if (flow) flow.lastRun = run;
    });
  }
  updateLocators(id, expectedRevision, updates) {
    return this.mutate((flows) => {
      const flow = flows.find((item) => item.id === id);
      if (!flow || flow.updatedAt !== expectedRevision) return false;
      for (const update of updates) {
        const step = flow.steps.find((item) => item.id === update.stepId);
        if (!step) continue;
        const args = { ...update.args };
        if (update.action === "click_element") delete args.snapshotUrl;
        for (const [field, value] of Object.entries(args)) {
          const binding = step.args[field]?.match(
            /^\{\{([a-z][a-z0-9_]*)\}\}$/,
          );
          if (binding) {
            const parameter = flow.parameters.find(
              (item) => item.name === binding[1],
            );
            if (parameter) {
              parameter.defaultValue = value;
              args[field] = step.args[field];
            }
          }
        }
        step.action = update.action;
        step.args = argumentSchemas[update.action].parse(args);
      }
      flow.updatedAt = new Date().toISOString();
      validateWorkflow(flow);
      return true;
    });
  }
}

const compact = (value) =>
  String(value || "")
    .replace(/\s/g, "")
    .toLocaleLowerCase();
export function locate(step, args, page) {
  const buttons = (page.buttons || []).filter((item) => !item.disabled);
  const matches = buttons.filter((item) =>
    step.action === "click_link"
      ? item.tag === "a" &&
        item.href === args.href &&
        item.text?.trim() === args.text.trim()
      : (!args.id || item.id === args.id) && (!item.href || item.tag !== "a") && compact(item.text) === compact(args.text),
  );
  if (matches.length !== 1) return null;
  return step.action === "click_link"
    ? {
        action: step.action,
        args: { text: matches[0].text, href: matches[0].href },
      }
    : {
        action: step.action,
        args: {
          id: matches[0].id,
          text: matches[0].text,
          snapshotUrl: page.url,
        },
      };
}

const HUMAN_INSTRUCTIONS = {
  login: "请在浏览器窗口中完成登录，然后点击继续。",
  captcha: "请在浏览器窗口中完成验证码，然后点击继续。",
  "2fa": "请在浏览器窗口中完成两步验证，然后点击继续。",
  payment: "当前页面需要人工确认付款，流程已暂停。",
};

function humanForPage(flow, page, index) {
  const challenge = page?.challenge?.type;
  const pageType = page?.pageType;
  const sensitiveTypes = ["login", "captcha", "payment"];
  const sensitiveChallenges = ["login", "captcha", "2fa", "payment"];
  if (!sensitiveTypes.includes(pageType) && !sensitiveChallenges.includes(challenge))
    return null;
  const reason =
    challenge && challenge !== "none"
      ? challenge
      : pageType === "login"
        ? "login"
        : pageType;
  const instruction =
    HUMAN_INSTRUCTIONS[reason] ||
    "当前页面需要人工处理，完成之后点击继续。";
  return {
    reason,
    instruction,
    message: "流程「" + flow.name + "」在第 " + (index + 1) + " 步暂停：" + instruction,
  };
}

export async function replayWorkflow(flowInput, overrides, options) {
  const flow = validateWorkflow(flowInput);
  const {
    execute,
    state,
    repair,
    emit,
    signal,
    repairEnabled = true,
    onStep,
  } = options;
  const startIndex = Number.isInteger(options.startIndex)
    ? options.startIndex
    : 0;
  const resume = options.resume === true;
  if (startIndex < 0) throw new Error("流程续跑起点不正确。");
  if (startIndex > 0 && !resume)
    throw new Error("只有续跑流程才能指定起始步骤。");
  const parameters = Object.fromEntries(
    flow.parameters.map((item) => [item.name, item.defaultValue]),
  );
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("流程参数格式不正确。");
  for (const [name, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(parameters, name) ||
      typeof value !== "string" ||
      value.length > 4096
    )
      throw new Error("无效的流程参数：" + name);
    parameters[name] = value;
  }
  const startUrl = render(flow.startUrl, parameters);
  httpUrl(startUrl);
  const steps =
    flow.steps[0].action === "open_url"
      ? flow.steps
      : [
          {
            id: "start",
            action: "open_url",
            args: { url: flow.startUrl },
            summary: "打开流程起始页面",
          },
          ...flow.steps,
        ];
  // Resolve every argument before the first browser operation.
  const prepared = steps.map((step) => ({
    ...step,
    args: Object.fromEntries(
      Object.entries(step.args).map(([key, value]) => [
        key,
        render(value, parameters),
      ]),
    ),
    sourceUrl: step.sourceUrl ? render(step.sourceUrl, parameters) : undefined,
    expectedUrl: step.expectedUrl
      ? new URL(
          render(step.expectedUrl, parameters),
          render(step.sourceUrl || flow.startUrl, parameters),
        ).href
      : undefined,
  }));
  for (const step of prepared) {
    argumentSchemas[step.action].parse(step.args);
    if (
      step.action === "click_element" &&
      step.args.id &&
      !/^[A-Za-z_][A-Za-z0-9_:.-]{0,127}$/.test(step.args.id)
    )
      throw new Error("按钮定位格式不正确。");
    if (step.action === "open_url") httpUrl(step.args.url);
    if (step.sourceUrl) httpUrl(step.sourceUrl);
    if (step.expectedUrl) httpUrl(step.expectedUrl);
  }
  if (startIndex > prepared.length)
    throw new Error("流程续跑起点不正确。");
  const run = {
    id: randomUUID(),
    status: "success",
    durationMs: 0,
    completed: startIndex,
    total: prepared.length,
    repairs: 0,
    finishedAt: "",
  };
  const started = Date.now();
  const verifiedRepairs = [];
  emit({ type: "workflow", workflowId: flow.id, state: "running", run });
  try {
    for (const [index, sourceStep] of prepared.entries()) {
      if (index < startIndex) continue;
      signal.throwIfAborted();
      const step = {
        id: randomUUID(),
        runId: run.id,
        step: index + 1,
        action: sourceStep.action,
        summary: sourceStep.summary,
        args: sourceStep.args,
        status: "running",
        timestamp: new Date().toISOString(),
        mode: "replay",
      };
      emit({ type: "step", step });
    onStep?.(step);
      let attempted = false;
      try {
        let operation = { action: sourceStep.action, args: sourceStep.args };
        if (sourceStep.action.startsWith("click_")) {
          const page = await state();
          if (!page?.connected && !page?.url)
            throw new Error(
              "浏览器尚未连接：Chrome 重启或标签页关闭后请重新打开页面，再从当前步骤继续。",
            );
          signal.throwIfAborted();
          const human = humanForPage(flow, page, index);
          if (human) {
            const pausedStep = {
              ...step,
              status: "awaiting_human",
              result: {
                success: false,
                awaitingHuman: true,
                reason: human.reason,
                instruction: human.instruction,
              },
            };
            emit({ type: "step", step: pausedStep });
            onStep?.(pausedStep);
            run.status = "awaiting_human";
            run.resumeIndex = index;
            run.human = {
              reason: human.reason,
              instruction: human.instruction,
            };
            run.error = human.instruction;
            emit({ type: "status", message: human.message });
            break;
          }
          if (
            sourceStep.sourceUrl &&
            normalizeUrl(page.url) !== normalizeUrl(sourceStep.sourceUrl)
          ) {
            if (!(resume && index === startIndex))
              throw new Error("页面与记录的来源网址不同，已停止，未点选。");
            emit({
              type: "status",
              message: "人工处理后页面与记录来源不同，继续在当前页面定位目标。",
            });
          }
          step.before = { url: page.url, title: page.title };
          operation = locate(sourceStep, sourceStep.args, page);
          if (!operation) {
            if (!repairEnabled || !repair || run.repairs >= 3)
              throw new Error(
                "原定位已失效；请打开 AI 重新辨识或重新录制这个步骤。",
              );
            emit({
              type: "status",
              message: "定位失效，正在由 AI 重新辨识步骤 " + (index + 1),
            });
            run.repairs++;
            operation = await repair(sourceStep, page, signal);
            signal.throwIfAborted();
            if (!operation)
              throw new Error("AI 无法确认唯一且相符的控制项，未进行点选。");
            step.repaired = true;
            step.action = operation.action;
            step.args = operation.args;
            emit({
              type: "step",
              step: {
                ...step,
                summary: step.summary + "（本次已重新辨识定位）",
              },
            });
          }
        }
        signal.throwIfAborted();
        attempted = true;
        const result = await execute(operation.action, operation.args, signal);
        if (!result.success)
          throw new Error(result.error || "工具未完成操作。");
        if (
          sourceStep.expectedUrl &&
          normalizeUrl(result.page?.url || "") !==
            normalizeUrl(sourceStep.expectedUrl) &&
          !samePageShape(result.page?.url || "", sourceStep.expectedUrl)
        )
          throw new Error(
            "操作已执行，但到达网址与预期不符；已停止，不会重复点选。",
          );
        signal.throwIfAborted();
        run.completed++;
        if (step.repaired)
          verifiedRepairs.push({
            stepId: sourceStep.id,
            action: operation.action,
            args: operation.args,
          });
        const completed = { ...step, status: "success", result };
        emit({ type: "step", step: completed });
        onStep?.(completed);
      } catch (error) {
        const failed = {
          ...step,
          status: "error",
          result: { error: error.message, attempted },
        };
        emit({ type: "step", step: failed });
        onStep?.(failed);
        throw error;
      }
    }
  } catch (error) {
    run.status = signal.aborted ? "cancelled" : "failed";
    run.error = signal.aborted
      ? "已停止；已送出的操作可能已完成，请确认目前页面。"
      : error.message;
  }
  run.durationMs = Date.now() - started;
  run.finishedAt = new Date().toISOString();
  if (
    run.status === "success" &&
    verifiedRepairs.length &&
    flow.parameters.every(
      (item) => parameters[item.name] === item.defaultValue,
    ) &&
    options.onVerifiedRepairs
  ) {
    try {
      const saved = await options.onVerifiedRepairs(verifiedRepairs);
      emit({
        type: "status",
        message: saved
          ? "已保存通过验证的新定位，下次可直接重跑。"
          : "流程已被修改，本次定位修复未覆写新版流程。",
      });
    } catch {
      emit({
        type: "status",
        message: "本次重跑成功，但定位修正无法写入流程库。",
      });
    }
  }
  options.onRun?.(run);
  emit({
    type: "workflow",
    workflowId: flow.id,
    state: run.status === "awaiting_human" ? "awaiting_human" : "finished",
    run,
  });
  emit({
    type: "text-delta",
    text:
      run.status === "success"
        ? "流程「" +
          flow.name +
          "」已完成：" +
          run.completed +
          " 个步骤，" +
          (run.durationMs / 1000).toFixed(1) +
          " 秒，AI 重新辨识 " +
          run.repairs +
          " 次。"
        : run.status === "awaiting_human"
          ? "流程「" +
            flow.name +
            "」已暂停，等待人工处理：" +
            (run.human?.instruction || run.error || "") +
            " 完成后可从第 " +
            ((run.resumeIndex ?? run.completed) + 1) +
            " 步继续。"
          : "流程「" +
            flow.name +
            "」已停止（" +
            run.completed +
            "/" +
            run.total +
            " 步）。" +
            run.error,
  });
  return run;
}
