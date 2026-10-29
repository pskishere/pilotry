import { test } from "node:test";
import { workflowTools } from "./workflow-tools.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileRecording,
  replayWorkflow,
  WorkflowStore,
  locate,
} from "./workflows.mjs";

const start = "https://example.org/event";
const destination = "https://example.org/booking";
const flow = () =>
  compileRecording({
    name: "Recorded navigation",
    startUrl: start,
    records: [
      {
        id: "open",
        action: "open_url",
        status: "success",
        before: { url: "https://other.example.org/" },
        args: { url: start },
        result: { page: { url: start, text: "must not persist" } },
      },
      {
        id: "click",
        action: "click_element",
        status: "success",
        args: { id: "buy", text: "前往购票", snapshotUrl: start },
        result: { page: { url: destination } },
      },
    ],
  });
const controller = () => new AbortController();
const page = (id = "buy") => ({
  connected: true,
  url: start,
  title: "Event",
  pageType: "event_detail",
  buttons: [{ id, text: "前往购票", disabled: false, tag: "button" }],
});

test("a unique button without an ID is reusable; ambiguous labels do not execute", () => {
  const step = { action: "click_element" };
  const current = { url: start, buttons: [{ tag: "button", id: "", text: "Next" }] };
  assert.equal(locate(step, { id: "", text: "Next" }, current)?.args.id, "");
  current.buttons.push({ tag: "button", id: "", text: "Next" });
  assert.equal(locate(step, { id: "", text: "Next" }, current), null);
});

test("data extraction can be recorded and replayed without AI or saved page data", async () => {
  const saved = compileRecording({ name: "Read page links", startUrl: start, records: [{ id: "extract", action: "extract_data", status: "success", args: { kind: "links" }, before: { url: start }, result: { page: { url: start }, dataset: { records: [{ text: "private result must not persist" }] } } }] });
  assert.ok(!JSON.stringify(saved).includes("private result"));
  const actions = [];
  const run = await replayWorkflow(saved, {}, { signal: controller().signal, emit() {}, state: async () => page(), execute: async (action, args) => { actions.push({ action, args }); return { success: true, page: { url: start }, dataset: { records: [] } }; } });
  assert.equal(run.status, "success");
  assert.deepEqual(actions.map(item => item.action), ["open_url", "extract_data"]);
  assert.equal(actions[1].args.kind, "links");
});

test("recording excludes page content and old snapshot URL; browser defaults follow the actual first open", () => {
  const saved = flow();
  assert.equal(saved.parameters[0].defaultValue, start);
  assert.equal(saved.steps[0].args.url, "{{start_url}}");
  assert.equal(saved.steps[1].sourceUrl, "{{start_url}}");
  assert.equal(saved.steps[1].expectedUrl, destination);
  assert.equal(saved.steps[1].args.snapshotUrl, undefined);
  assert.ok(!JSON.stringify(saved).includes("must not persist"));
});

test("normal replay makes zero AI calls and refreshes stale snapshot URLs", async () => {
  let repairs = 0;
  const calls = [];
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      repair: async () => {
        repairs++;
        throw new Error("Should not call model");
      },
      execute: async (action, args) => {
        calls.push({ action, args });
        return {
          success: true,
          page: { url: action === "open_url" ? start : destination },
        };
      },
    },
  );
  assert.equal(result.status, "success");
  assert.equal(result.completed, 2);
  assert.equal(repairs, 0);
  assert.equal(calls[1].args.snapshotUrl, start);
});

test("post-action mismatch stops without AI repair or repeating the mutation", async () => {
  let mutations = 0;
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      repair: async () => {
        throw new Error("Must not retry after acting");
      },
      execute: async (action) => {
        if (action.startsWith("click")) mutations++;
        return { success: true, page: { url: start } };
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(mutations, 1);
  assert.equal(result.completed, 1);
  assert.match(result.error, /不会重复点选/);
});

test("changed locator is repaired once, verified, then passed to persistence", async () => {
  const updates = [];
  let modelCalls = 0;
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => page("new-button"),
      repair: async () => {
        modelCalls++;
        return {
          action: "click_element",
          args: { id: "new-button", text: "前往购票", snapshotUrl: start },
        };
      },
      execute: async (action) => ({
        success: true,
        page: { url: action === "open_url" ? start : destination },
      }),
      onVerifiedRepairs: async (items) => {
        updates.push(...items);
        return true;
      },
    },
  );
  assert.equal(result.status, "success");
  assert.equal(modelCalls, 1);
  assert.equal(result.repairs, 1);
  assert.equal(updates[0].args.id, "new-button");
});

test("login page pauses replay with a resume index instead of failing", async () => {
  const actions = [];
  const result = await replayWorkflow(flow(), {}, {
    signal: controller().signal,
    emit() {},
    state: async () => ({
      ...page(),
      pageType: "login",
      challenge: { type: "login", evidence: ["password_field"] },
    }),
    execute: async (action) => {
      actions.push(action);
      return { success: true, page: { url: start } };
    },
  });
  assert.equal(result.status, "awaiting_human");
  assert.equal(result.resumeIndex, 1);
  assert.equal(result.human.reason, "login");
  assert.deepEqual(actions, ["open_url"]);
});

test("resuming from the paused step skips earlier steps and tolerates post-login page change", async () => {
  const actions = [];
  const result = await replayWorkflow(flow(), {}, {
    signal: controller().signal,
    emit() {},
    resume: true,
    startIndex: 1,
    state: async () => ({
      ...page(),
      url: "https://example.org/account",
      pageType: "unknown",
      challenge: { type: "none", evidence: [] },
    }),
    execute: async (action) => {
      actions.push(action);
      return {
        success: true,
        page: { url: action === "click_element" ? destination : start },
      };
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.completed, 2);
  assert.deepEqual(actions, ["click_element"]);
});

test("same path with different query passes the expected-url check for cross-entity replay", async () => {
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      execute: async (action) => ({
        success: true,
        page: { url: action === "open_url" ? start : destination + "?id=1092111415860&qty=1" },
      }),
    },
  );
  assert.equal(result.status, "success");
  assert.equal(result.completed, 2);
});

test("a different pathname still stops after the click", async () => {
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      execute: async (action) => ({
        success: true,
        page: { url: action === "open_url" ? start : "https://example.org/home" },
      }),
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.completed, 1);
  assert.match(result.error || "", /与预期不符/);
});

test("a start index without resume is rejected before browser operations", async () => {
  let calls = 0;
  await assert.rejects(
    replayWorkflow(flow(), {}, {
      signal: controller().signal,
      emit() {},
      startIndex: 1,
      state: async () => page(),
      execute: async () => {
        calls++;
        return { success: true };
      },
    }),
    /续跑/,
  );
  assert.equal(calls, 0);
});

test("a different page stops before clicking or attempting locator repair", async () => {
  let clicks = 0;
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: controller().signal,
      emit() {},
      state: async () => ({
        ...page(),
        url: "https://example.org/other-event",
      }),
      repair: async () => {
        throw new Error("Wrong page is not a locator problem");
      },
      execute: async (action) => {
        if (action.startsWith("click")) clicks++;
        return { success: true, page: { url: start } };
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(clicks, 0);
});

test("unknown parameters and invalid URLs are rejected before any browser operation", async () => {
  let calls = 0;
  const options = {
    signal: controller().signal,
    emit() {},
    state: async () => page(),
    execute: async () => {
      calls++;
      return { success: true };
    },
  };
  await assert.rejects(
    replayWorkflow(flow(), { missing: "value" }, options),
    /无效/,
  );
  await assert.rejects(
    replayWorkflow(flow(), { start_url: "javascript:alert(1)" }, options),
    /HTTP/,
  );
  assert.equal(calls, 0);
});

test("undefined parameters cannot be forged onto a saved flow", async () => {
  let calls = 0;
  await assert.rejects(
    replayWorkflow(flow(), { evil: JSON.parse('{"__proto__": {"x": true}}') }, {
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      execute: async () => {
        calls++;
        return { success: true };
      },
    }),
    /无效/,
  );
  assert.equal(calls, 0);
});

test("abort after an in-flight operation prevents all later steps", async () => {
  const abort = controller();
  let calls = 0;
  const result = await replayWorkflow(
    flow(),
    {},
    {
      signal: abort.signal,
      emit() {},
      state: async () => page(),
      execute: async () => {
        calls++;
        abort.abort();
        return { success: true, page: { url: start } };
      },
    },
  );
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
});

test("parameterized links validate the rendered destination rather than the old URL", async () => {
  const saved = compileRecording({
    name: "Link",
    startUrl: start,
    records: [
      {
        id: "link",
        action: "click_link",
        status: "success",
        before: { url: start },
        args: { text: "Details", href: "/booking" },
        result: { page: { url: destination } },
      },
    ],
    bindings: [
      { stepId: "link", field: "href", name: "destination", label: "Target" },
    ],
  });
  const target = "https://example.org/alternative";
  const result = await replayWorkflow(
    saved,
    { destination: "/alternative" },
    {
      signal: controller().signal,
      emit() {},
      state: async () => ({
        ...page(),
        buttons: [{ tag: "a", text: "Details", href: "/alternative" }],
      }),
      execute: async (action) => ({
        success: true,
        page: { url: action === "open_url" ? start : target },
      }),
    },
  );
  assert.equal(result.status, "success");
});

test("store survives reopening, serializes writes, preserves corrupt data, and protects newer edits", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pilotry-workflow-test-"),
  );
  const store = new WorkflowStore(directory);
  try {
    const first = flow();
    const second = { ...flow(), id: randomUUID() };
    await Promise.all([store.save(first), store.save(second)]);
    assert.equal((await new WorkflowStore(directory).list()).length, 2);
    await store.save({
      ...first,
      name: "new version",
      updatedAt: "new-revision",
    });
    assert.equal(
      await store.updateLocators(first.id, first.updatedAt, [
        {
          stepId: first.steps[1].id,
          action: "click_element",
          args: { id: "new", text: "前往购票" },
        },
      ]),
      false,
    );
    assert.equal((await store.get(first.id)).name, "new version");
    const corrupt = '{"version":1,"workflows":';
    await writeFile(store.path, corrupt);
    await assert.rejects(store.save(first), /未覆写/);
    assert.equal(await readFile(store.path, "utf8"), corrupt);
  } finally {
    await unlink(store.path).catch(() => {});
    await rmdir(directory);
  }
});

test("conversation tools save only observed steps and never repeat a workflow in one instruction", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pilotry-workflow-tools-test-"),
  );
  const store = new WorkflowStore(directory);
  let operations = 0;
  try {
    const tools = workflowTools({
      store,
      signal: controller().signal,
      emit() {},
      state: async () => page(),
      recorded: () => [
        {
          id: "observed",
          action: "open_url",
          status: "success",
          args: { url: start },
          result: { page: { url: start } },
        },
      ],
      execute: async () => {
        operations++;
        return { success: true, page: { url: start } };
      },
      repair: async () => {
        throw new Error("No repair required");
      },
    });
    assert.equal(
      (
        await tools.save_workflow.execute({
          name: "Saved",
          stepIds: ["invented"],
        })
      ).success,
      false,
    );
    assert.equal((await store.list()).length, 0);
    const saved = await tools.save_workflow.execute({
      name: "Saved",
      stepIds: ["observed"],
    });
    assert.equal(saved.success, true);
    assert.equal(
      (
        await tools.run_workflow.execute({
          id: saved.id,
          parameters: {},
          repairEnabled: false,
        })
      ).success,
      true,
    );
    assert.equal(
      (
        await tools.run_workflow.execute({
          id: saved.id,
          parameters: {},
          repairEnabled: false,
        })
      ).success,
      false,
    );
    assert.equal(operations, 1);
    assert.equal((await store.get(saved.id)).lastRun.status, "success");
  } finally {
    await unlink(store.path).catch(() => {});
    await rmdir(directory);
  }
});
