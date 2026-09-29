import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  fakeSubagentsPath,
  nextRequestId,
  providerThreadIdFor,
  turnStart,
} from "./fork-test-support.js";
import { type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

vi.setConfig({ testTimeout: 30_000 });

let harness: FakePiBridgeHarness | undefined;

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

async function start(
  prefix: string,
  env: Record<string, string> = {},
): Promise<FakePiBridgeHarness> {
  harness = await startFakePiBridge({ prefix, initialize: true, processLog: true });
  vi.stubEnv("FAKE_PI_EXTRA_EXTENSIONS", JSON.stringify([fakeSubagentsPath]));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return harness;
}

function spawn(h: FakePiBridgeHarness, threadId: string, params: Record<string, unknown>): void {
  turnStart(h, threadId, `/tool subagent_spawn ${JSON.stringify(params)}`);
}

type Delta = Record<string, unknown> & {
  kind: string;
  key?: { providerItemId?: string; parentRef?: string };
  item?: { type?: string; taskStatus?: string };
  snapshot?: { taskStatus?: string };
};

function taskDeltas(h: FakePiBridgeHarness, threadId: string): Delta[] {
  return (h.deltasOf(threadId) as Delta[]).filter(
    (delta) =>
      delta.item?.type === "backgroundTask" ||
      (delta.kind === "item.progress" && delta.snapshot !== undefined),
  );
}

function taskStatuses(h: FakePiBridgeHarness, threadId: string): string[] {
  return taskDeltas(h, threadId).map(
    (delta) => `${delta.kind}:${delta.item?.taskStatus ?? delta.snapshot?.taskStatus}`,
  );
}

/** Opened pending then progressed, or opened running: a pipe race decides. */
function waitForRunning(h: FakePiBridgeHarness, threadId: string) {
  return h.waitFor(
    () =>
      taskStatuses(h, threadId).some(
        (entry) => entry === "item.open:running" || entry === "item.progress:running",
      ),
    `a running subagent in ${threadId}`,
  );
}

function waitForTaskStatus(h: FakePiBridgeHarness, threadId: string, status: string) {
  return h.waitFor(
    () => taskStatuses(h, threadId).some((entry) => entry === `item.close:${status}`),
    `a ${status} subagent in ${threadId}`,
  );
}

it("shows a pi-toolbox subagent as a native background task under its spawn tool, settling after the parent turn", async () => {
  const h = await start("bb-pi-subagents-native-");
  const threadId = "thr_sub_native";
  await h.startThread(threadId);
  spawn(h, threadId, { name: "reviewer", prompt: "TOP-SECRET-PROMPT", durationMs: 150 });
  await waitForTaskStatus(h, threadId, "completed");

  const deltas = h.deltasOf(threadId) as Delta[];
  const toolOpen = deltas.findIndex(
    (delta) => delta.kind === "item.open" && delta.key?.providerItemId === "call-1",
  );
  const taskOpen = deltas.findIndex(
    (delta) => delta.kind === "item.open" && delta.item?.type === "backgroundTask",
  );
  const turnEnd = deltas.findIndex((delta) => delta.kind === "turn.boundary");
  const taskClose = deltas.findIndex(
    (delta) => delta.kind === "item.close" && delta.item?.type === "backgroundTask",
  );
  expect(toolOpen).toBeGreaterThanOrEqual(0);
  expect(taskOpen).toBeGreaterThan(toolOpen);
  // The spawn tool and the parent turn end first; the run keeps going.
  expect(turnEnd).toBeGreaterThan(taskOpen);
  expect(taskClose).toBeGreaterThan(turnEnd);
  expect(deltas[taskOpen]).toMatchObject({
    key: { parentRef: "call-1" },
    item: {
      type: "backgroundTask",
      taskType: "local_agent",
      description: "reviewer",
      skipTranscript: false,
    },
    attach: "currentOrLast",
  });
  expect(JSON.stringify(taskDeltas(h, threadId))).not.toContain("TOP-SECRET-PROMPT");

  // bb's real assembler turns the stream into one native task row.
  const events = assembleCapturedThreadEvents(h.messages, "pi").filter(
    (event) => "item" in event && (event.item as { type?: string }).type === "backgroundTask",
  );
  // queued and running both precede pi's tool line, so the row opens running.
  expect(events.map((event) => event.type)).toEqual([
    "item/started",
    "item/backgroundTask/completed",
  ]);
});

it("attaches under the spawn tool even when the lifecycle line beats pi's stdout", async () => {
  const h = await start("bb-pi-subagents-race-", { FAKE_PI_DELAY_TOOL_START_MS: "150" });
  const threadId = "thr_sub_race";
  await h.startThread(threadId);
  spawn(h, threadId, { name: "racer", durationMs: 400 });
  await waitForTaskStatus(h, threadId, "completed");
  const deltas = h.deltasOf(threadId) as Delta[];
  const toolOpen = deltas.findIndex(
    (delta) => delta.kind === "item.open" && delta.key?.providerItemId === "call-1",
  );
  const taskOpen = deltas.findIndex(
    (delta) => delta.kind === "item.open" && delta.item?.type === "backgroundTask",
  );
  expect(toolOpen).toBeGreaterThanOrEqual(0);
  expect(taskOpen).toBeGreaterThan(toolOpen);
  expect(deltas[taskOpen]?.key?.parentRef).toBe("call-1");
});

it("works when pi-toolbox loads before the bb extension", async () => {
  const h = await start("bb-pi-subagents-order-", { FAKE_PI_EXTRA_EXTENSIONS_FIRST: "1" });
  const threadId = "thr_sub_order";
  await h.startThread(threadId);
  spawn(h, threadId, { agent: "planner", durationMs: 50 });
  await waitForTaskStatus(h, threadId, "completed");
  expect(taskDeltas(h, threadId)[0]?.item).toMatchObject({ description: "planner" });
});

it("shows an immediate backend failure as a failed task", async () => {
  const h = await start("bb-pi-subagents-fail-");
  const threadId = "thr_sub_fail";
  await h.startThread(threadId);
  spawn(h, threadId, { failImmediately: true });
  await waitForTaskStatus(h, threadId, "failed");
  // Whether the tool line lands between queued and failed is a pipe race;
  // either way there is exactly one row and it ends failed.
  const statuses = taskStatuses(h, threadId);
  expect(statuses).toHaveLength(2);
  expect(statuses[0]).toMatch(/^item\.open:(pending|running)$/u);
  expect(statuses[1]).toBe("item.close:failed");
});

it("settles a running subagent as stopped when pi dies without telemetry", async () => {
  const h = await start("bb-pi-subagents-death-");
  const threadId = "thr_sub_death";
  await h.startThread(threadId);
  spawn(h, threadId, { outcome: "hold" });
  await waitForRunning(h, threadId);
  const before = h.deltasOf(threadId).length;
  await h.waitForTurnBoundary(threadId);
  turnStart(h, threadId, "/die");
  await waitForTaskStatus(h, threadId, "stopped");
  expect(h.deltasOf(threadId).length).toBeGreaterThan(before);
});

it("cancels running subagents through pi-toolbox's shutdown when the thread stops", async () => {
  const h = await start("bb-pi-subagents-stop-");
  const threadId = "thr_sub_stop";
  await h.startThread(threadId);
  spawn(h, threadId, { outcome: "hold" });
  await waitForRunning(h, threadId);
  await h.waitForTurnBoundary(threadId);
  const stop = await h.request(nextRequestId(), "thread/stop", {
    threadId,
    providerThreadId: providerThreadIdFor(h, threadId),
    intent: "release",
    activeTurnId: null,
  });
  expect(stop.result).toMatchObject({ ok: true });
  await waitForTaskStatus(h, threadId, "stopped");
  expect(taskStatuses(h, threadId).filter((entry) => entry.startsWith("item.close"))).toEqual([
    "item.close:stopped",
  ]);
});

it("does not display runs a resumed session restores as already settled", async () => {
  const restore = join(
    (await start("bb-pi-subagents-restore-")).workspaceDir,
    "restore.json",
  );
  writeFileSync(
    restore,
    JSON.stringify([
      { id: "run-1", label: "old", toolCallId: "call-9", harness: "pi", status: "running", createdAt: 1 },
      { id: "run-2", label: "done", toolCallId: "call-8", harness: "pi", status: "completed", createdAt: 1, settledAt: 2 },
    ]),
  );
  vi.stubEnv("FAKE_SUBAGENTS_RESTORE_FILE", restore);
  const threadId = "thr_sub_restore";
  await harness!.startThread(threadId);
  turnStart(harness!, threadId, "hello");
  await harness!.waitForTurnBoundary(threadId);
  expect(taskDeltas(harness!, threadId)).toEqual([]);
});

it("keeps two concurrent subagents as two native tasks", async () => {
  const h = await start("bb-pi-subagents-two-");
  const threadId = "thr_sub_two";
  await h.startThread(threadId);
  spawn(h, threadId, { name: "one", durationMs: 300 });
  await h.waitForTurnBoundary(threadId);
  const since = h.deltasOf(threadId).length;
  spawn(h, threadId, { name: "two", durationMs: 50 });
  await h.waitForTurnBoundary(threadId, since);
  await h.waitFor(
    () => taskStatuses(h, threadId).filter((entry) => entry === "item.close:completed").length === 2,
    "both subagents",
  );
  const opened = taskDeltas(h, threadId).filter((delta) => delta.kind === "item.open");
  expect(opened.map((delta) => delta.item)).toMatchObject([
    { description: "one" },
    { description: "two" },
  ]);
  expect(new Set(opened.map((delta) => delta.key?.providerItemId)).size).toBe(2);
});
