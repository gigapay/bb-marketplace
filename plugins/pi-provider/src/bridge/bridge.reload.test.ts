import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  fakeSubagentsPath,
  nextRequestId,
  providerThreadIdFor,
  replyTo,
  textInput,
  turnStart,
} from "./fork-test-support.js";
import { resolvePiSessionFilePath } from "./session-paths.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

vi.setConfig({ testTimeout: 30_000 });

const MINI = {
  ...FULL_PERMISSION_OPTIONS,
  model: "fake-provider/fake-mini",
  reasoningLevel: "medium",
};

let harness: FakePiBridgeHarness | undefined;
let commandLog = "";

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

async function start(prefix: string, withSubagents = false): Promise<FakePiBridgeHarness> {
  harness = await startFakePiBridge({ prefix, initialize: true, processLog: true });
  commandLog = join(harness.workspaceDir, "commands.log");
  vi.stubEnv("FAKE_PI_COMMAND_LOG", commandLog);
  if (withSubagents) {
    vi.stubEnv("FAKE_PI_EXTRA_EXTENSIONS", JSON.stringify([fakeSubagentsPath]));
  }
  return harness;
}

function promptCount(): number {
  return existsSync(commandLog)
    ? readFileSync(commandLog, "utf8").split("\n").filter((line) => line === "prompt").length
    : 0;
}

type Delta = Record<string, unknown> & {
  kind: string;
  item?: { type?: string; tool?: string; taskType?: string };
  status?: string;
  resultText?: string;
  size?: number;
};

function reloadRows(h: FakePiBridgeHarness, threadId: string): Delta[] {
  return (h.deltasOf(threadId) as Delta[]).filter(
    (delta) => delta.item?.tool === "pi_reload",
  );
}

async function reload(h: FakePiBridgeHarness, threadId: string) {
  const since = h.deltasOf(threadId).length;
  const reply = await replyTo(h, turnStart(h, threadId, "/reload"));
  return { reply, since };
}

async function finishedReload(h: FakePiBridgeHarness, threadId: string, since: number) {
  await h.waitForTurnBoundary(threadId, since);
  return (h.deltasOf(threadId) as Delta[]).slice(since);
}

async function normalTurn(h: FakePiBridgeHarness, threadId: string, text = "hello") {
  const since = h.deltasOf(threadId).length;
  turnStart(h, threadId, text, MINI);
  await h.waitForTurnBoundary(threadId, since);
  return (h.deltasOf(threadId) as Delta[]).slice(since);
}

it("restarts pi on the same session and settings, and only reports success once the new runtime is ready", async () => {
  const h = await start("bb-pi-reload-ok-");
  const threadId = "thr_reload_ok";
  await h.startThread(threadId, { options: MINI });
  await normalTurn(h, threadId);
  const providerThreadId = providerThreadIdFor(h, threadId);
  const sessionFile = resolvePiSessionFilePath({ env: process.env, threadId: providerThreadId });
  expect(existsSync(sessionFile)).toBe(true);
  const promptsBefore = promptCount();
  const spawnedBefore = h.readProcessLog().spawned.length;

  const { reply, since } = await reload(h, threadId);
  expect(reply.result).toEqual({ threadId });
  const deltas = await finishedReload(h, threadId, since);

  expect(deltas.map((delta) => delta.kind)).toEqual(
    expect.arrayContaining(["input.accepted", "turn.open", "item.open", "item.close", "turn.boundary"]),
  );
  const close = deltas.find((delta) => delta.kind === "item.close");
  expect(close).toMatchObject({ status: "completed", item: { tool: "pi_reload" } });
  const boundary = deltas.findIndex((delta) => delta.kind === "turn.boundary");
  expect(deltas[boundary]).toMatchObject({ status: "completed" });
  // Settled before the reset that makes the assembler forget the turn.
  expect(deltas.findIndex((delta) => delta.kind === "session.reset")).toBeGreaterThan(boundary);
  // The new child reported ready before the row settled.
  expect(h.readProcessLog().spawned.length).toBe(spawnedBefore + 1);
  await h.waitFor(() => h.readProcessLog().exited.length >= 1, "the old pi child to exit");
  // Never a model prompt; same conversation identity and session file.
  expect(promptCount()).toBe(promptsBefore);
  expect(providerThreadIdFor(h, threadId)).toBe(providerThreadId);
  expect(existsSync(sessionFile)).toBe(true);
  // bb's real assembler settles the reload row and its turn (they must reach
  // it before session.reset, which drops the thread's assembly state).
  const assembled = assembleCapturedThreadEvents(h.messages, "pi");
  const reloadRow = assembled.filter(
    (event) =>
      event.type === "item/completed" &&
      (event.item as { type?: string; tool?: string }).type === "toolCall",
  ).at(-1) as { item: { status?: string } } | undefined;
  expect(reloadRow?.item.status).toBe("completed");
  expect(assembled.filter((event) => event.type === "turn/completed")).toHaveLength(2);
  // Construction settings survive: the mini model's 32k window is still used.
  const after = await normalTurn(h, threadId);
  expect(after.filter((delta) => delta.kind === "contextWindow").map((delta) => delta.size)).toContain(32_000);
});

it("recognizes /reload picked from the composer as this provider's command", async () => {
  const h = await start("bb-pi-reload-mention-");
  const threadId = "thr_reload_mention";
  await h.startThread(threadId);
  const since = h.deltasOf(threadId).length;
  const mention = {
    start: 0,
    end: 7,
    resource: {
      kind: "command",
      label: "reload",
      name: "reload",
      origin: "user",
      source: "command",
      trigger: "/",
      argumentHint: null,
    },
  };
  const reply = await replyTo(h, turnStart(h, threadId, textInput("/reload", [mention])));
  expect(reply.result).toEqual({ threadId });
  await finishedReload(h, threadId, since);
  expect(reloadRows(h, threadId).at(-1)).toMatchObject({ kind: "item.close", status: "completed" });
  expect(promptCount()).toBe(0);
});

it("refuses to reload while a turn is running, on both turn/start and turn/steer, without reaching the model", async () => {
  const h = await start("bb-pi-reload-busy-");
  const threadId = "thr_reload_busy";
  await h.startThread(threadId);
  turnStart(h, threadId, "/hold");
  await h.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
  const promptsBefore = promptCount();

  const started = await replyTo(h, turnStart(h, threadId, "/reload"));
  expect(started.error).toMatchObject({ message: expect.stringContaining("still working") });

  const steerId = nextRequestId();
  const steer = await h.request(steerId, "turn/steer", {
    threadId,
    providerThreadId: providerThreadIdFor(h, threadId),
    expectedTurnId: "turn-1",
    clientRequestId: "creq_22222223ab",
    input: [{ type: "text", text: "/reload", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(steer.error).toMatchObject({ message: expect.stringContaining("/reload") });
  expect(promptCount()).toBe(promptsBefore);
  expect(reloadRows(h, threadId)).toEqual([]);
  expect(h.readProcessLog().spawned).toHaveLength(1);
});

it("refuses to reload while a background subagent is running, then reloads once it settled", async () => {
  const h = await start("bb-pi-reload-subagent-", true);
  const threadId = "thr_reload_subagent";
  await h.startThread(threadId);
  const since = h.deltasOf(threadId).length;
  turnStart(h, threadId, `/tool subagent_spawn ${JSON.stringify({ outcome: "hold" })}`);
  await h.waitForTurnBoundary(threadId, since);

  const refused = await replyTo(h, turnStart(h, threadId, "/reload"));
  expect(refused.error).toMatchObject({
    message: expect.stringContaining("1 background subagent is still running"),
  });

  const cancelSince = h.deltasOf(threadId).length;
  turnStart(h, threadId, `/tool subagent_cancel ${JSON.stringify({ id: "run-1" })}`);
  await h.waitForTurnBoundary(threadId, cancelSince);
  await h.waitFor(
    () =>
      (h.deltasOf(threadId) as Delta[]).some(
        (delta) => delta.kind === "item.close" && delta.item?.type === "backgroundTask",
      ),
    "the cancelled subagent",
  );
  const { reply, since: reloadSince } = await reload(h, threadId);
  expect(reply.result).toEqual({ threadId });
  await finishedReload(h, threadId, reloadSince);
  expect(reloadRows(h, threadId).at(-1)).toMatchObject({ status: "completed" });
});

it("reports a failed reload clearly, keeps the previous runtime, and succeeds on retry", async () => {
  const h = await start("bb-pi-reload-fail-");
  const threadId = "thr_reload_fail";
  await h.startThread(threadId);
  vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const { reply, since } = await reload(h, threadId);
  expect(reply.result).toEqual({ threadId });
  const failed = await finishedReload(h, threadId, since);
  expect(failed.find((delta) => delta.kind === "item.close")).toMatchObject({
    status: "failed",
    resultText: expect.stringContaining("the previous Pi runtime is still active"),
  });
  expect(failed.at(-1)).toMatchObject({ kind: "turn.boundary", status: "failed" });

  // The old child still answers.
  vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "");
  const turn = await normalTurn(h, threadId, "still there?");
  expect(turn.at(-1)).toMatchObject({ kind: "turn.boundary", status: "completed" });

  const retry = await reload(h, threadId);
  await finishedReload(h, threadId, retry.since);
  expect(reloadRows(h, threadId).at(-1)).toMatchObject({ status: "completed" });
});

it("leaves exactly one lifecycle subscription after repeated reloads: one run, one native task", async () => {
  const h = await start("bb-pi-reload-repeat-", true);
  const threadId = "thr_reload_repeat";
  await h.startThread(threadId);
  for (let round = 0; round < 2; round += 1) {
    const { since } = await reload(h, threadId);
    await finishedReload(h, threadId, since);
  }
  const since = h.deltasOf(threadId).length;
  turnStart(h, threadId, `/tool subagent_spawn ${JSON.stringify({ name: "after-reload", durationMs: 50 })}`);
  await h.waitForTurnBoundary(threadId, since);
  await h.waitFor(
    () =>
      (h.deltasOf(threadId) as Delta[]).some(
        (delta) => delta.kind === "item.close" && delta.item?.type === "backgroundTask",
      ),
    "the subagent to settle",
  );
  const tasks = (h.deltasOf(threadId) as Delta[]).filter(
    (delta) => delta.item?.type === "backgroundTask",
  );
  expect(tasks.map((delta) => delta.kind)).toEqual(["item.open", "item.close"]);
  // Three children over the thread's life, two already gone.
  expect(h.readProcessLog().spawned).toHaveLength(3);
});

it("treats /reload with extra text as an ordinary prompt", async () => {
  const h = await start("bb-pi-reload-text-");
  const threadId = "thr_reload_text";
  await h.startThread(threadId);
  await normalTurn(h, threadId, "/reload please");
  expect(promptCount()).toBe(1);
  expect(reloadRows(h, threadId)).toEqual([]);
});

it("keeps the surviving runtime's subagents visible after a replacement published and then failed", async () => {
  const h = await start("bb-pi-reload-superseded-", true);
  const threadId = "thr_reload_superseded";
  await h.startThread(threadId);
  vi.stubEnv("FAKE_SUBAGENTS_SNAPSHOT_AT_LOAD", "1");
  vi.stubEnv("FAKE_PI_NO_SESSION_START", "1");
  vi.stubEnv("BB_PI_BRIDGE_READINESS_TIMEOUT_MS", "400");
  const { since } = await reload(h, threadId);
  const failed = await finishedReload(h, threadId, since);
  expect(failed.at(-1)).toMatchObject({ kind: "turn.boundary", status: "failed" });
  vi.stubEnv("FAKE_SUBAGENTS_SNAPSHOT_AT_LOAD", "");
  vi.stubEnv("FAKE_PI_NO_SESSION_START", "");

  const spawnSince = h.deltasOf(threadId).length;
  turnStart(h, threadId, `/tool subagent_spawn ${JSON.stringify({ name: "survivor", durationMs: 50 })}`);
  await h.waitForTurnBoundary(threadId, spawnSince);
  await h.waitFor(
    () =>
      (h.deltasOf(threadId) as Delta[]).some(
        (delta) => delta.kind === "item.close" && delta.item?.type === "backgroundTask",
      ),
    "the surviving child's subagent",
  );
});

it("settles a live subagent once, not twice, when a settings change rebuilds pi", async () => {
  const h = await start("bb-pi-rebuild-subagent-", true);
  const threadId = "thr_rebuild_subagent";
  await h.startThread(threadId, { options: MINI });
  const since = h.deltasOf(threadId).length;
  turnStart(h, threadId, `/tool subagent_spawn ${JSON.stringify({ outcome: "hold" })}`, MINI);
  await h.waitForTurnBoundary(threadId, since);
  // A different model rebuilds the pi child (upstream behavior).
  const rebuildSince = h.deltasOf(threadId).length;
  turnStart(h, threadId, "next", { ...MINI, model: "fake-provider/fake-model" });
  await h.waitForTurnBoundary(threadId, rebuildSince);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const tasks = assembleCapturedThreadEvents(h.messages, "pi").filter(
    (event) => "item" in event && (event.item as { type?: string }).type === "backgroundTask",
  ) as Array<{ type: string; item: { id: string; taskStatus: string } }>;
  // One row: a single start and a single settlement, on one bb item id.
  expect(tasks.filter((event) => event.type === "item/started")).toHaveLength(1);
  const settled = tasks.filter((event) => event.type === "item/backgroundTask/completed");
  expect(settled.map((event) => event.item.taskStatus)).toEqual(["stopped"]);
  expect(new Set(tasks.map((event) => event.item.id)).size).toBe(1);
});
