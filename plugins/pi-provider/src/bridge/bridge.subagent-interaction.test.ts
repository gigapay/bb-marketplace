import { fileURLToPath } from "node:url";
import { experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, expect, it, vi } from "vitest";
import {
  clientRequestId,
  nextRequestId,
  providerThreadIdFor,
  replyTo,
  turnStart,
} from "./fork-test-support.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

vi.setConfig({ testTimeout: 30_000 });

const fakeCommandsPath = fileURLToPath(new URL("./fake-commands-extension.mjs", import.meta.url));

let harness: FakePiBridgeHarness | undefined;

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

type Delta = Record<string, unknown> & {
  kind: string;
  text?: string;
  key?: { parentRef?: string };
  item?: { type?: string; taskStatus?: string };
  snapshot?: { taskStatus?: string };
};

function taskStatuses(h: FakePiBridgeHarness, threadId: string): string[] {
  return (h.deltasOf(threadId) as Delta[])
    .filter(
      (delta) =>
        delta.item?.type === "backgroundTask" ||
        (delta.kind === "item.progress" && delta.snapshot !== undefined),
    )
    .map((delta) => `${delta.kind}:${delta.item?.taskStatus ?? delta.snapshot?.taskStatus}`);
}

async function start(
  prefix: string,
  env: Record<string, string> = {},
): Promise<FakePiBridgeHarness> {
  harness = await startFakePiBridge({ prefix, initialize: true, processLog: true });
  vi.stubEnv("FAKE_PI_EXTRA_EXTENSIONS", JSON.stringify([fakeCommandsPath]));
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return harness;
}

function steer(h: FakePiBridgeHarness, threadId: string, text: string) {
  const id = nextRequestId();
  return h.request(id, "turn/steer", {
    threadId,
    providerThreadId: providerThreadIdFor(h, threadId),
    expectedTurnId: "turn-1",
    clientRequestId: clientRequestId(id),
    input: [{ type: "text", text, mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
}

it("stand-in: releases a parent wait through /subagents background without creating a command turn or stopping its child", async () => {
  const h = await start("bb-pi-subagent-command-", {
    FAKE_PI_COMMAND_CHILD_ON_HOLD: "1",
  });
  const threadId = "thr_subagent_command";
  await h.startThread(threadId);
  const parent = turnStart(h, threadId, "/hold");
  await h.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
  await h.waitFor(
    () => taskStatuses(h, threadId).some((status) => status === "item.open:running" || status === "item.progress:running"),
    "the native child to be running before the command",
  );
  const since = h.deltasOf(threadId).length;

  const command = await steer(h, threadId, "/subagents background");
  expect(command).toMatchObject({ result: { threadId } });
  await h.waitForDelta(
    threadId,
    (delta) => delta.kind === "item.textClose" && String(delta.text).includes("child work continues"),
    since,
  );
  await replyTo(h, parent);
  await h.waitForTurnBoundary(threadId, since);

  const commandDeltas = (h.deltasOf(threadId) as Delta[]).slice(since);
  expect(commandDeltas.filter((delta) => delta.kind === "input.accepted")).toHaveLength(1);
  expect(commandDeltas.filter((delta) => delta.kind === "turn.open")).toHaveLength(0);
  // The agent-end and top-level prompt settlement paths can both emit an
  // idempotent claimIfIdle boundary. The assembler must still render only the
  // parent turn, not a command turn.
  const boundaries = commandDeltas.filter((delta) => delta.kind === "turn.boundary");
  expect(boundaries).not.toHaveLength(0);
  expect(boundaries.every((delta) => delta.status === "completed")).toBe(true);
  expect(JSON.stringify(commandDeltas)).not.toContain("Response to: /subagents background");
  expect(taskStatuses(h, threadId)).not.toContain("item.close:completed");
  // The child remains active after the normally completed parent, so reload
  // remains guarded until its independent completion.
  const reload = await h.request(nextRequestId(), "turn/start", {
    threadId,
    providerThreadId: providerThreadIdFor(h, threadId),
    clientRequestId: clientRequestId(nextRequestId()),
    input: [{ type: "text", text: "/reload", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(reload.error).toMatchObject({ message: expect.stringContaining("subagent") });
  await h.waitFor(
    () => taskStatuses(h, threadId).includes("item.close:completed"),
    "the independent child to complete",
  );
  const taskClose = (h.deltasOf(threadId) as Delta[]).find(
    (delta) => delta.kind === "item.close" && delta.item?.type === "backgroundTask",
  );
  expect(taskClose).toMatchObject({ key: { parentRef: "call-1" }, item: { taskStatus: "completed" } });
  const events = assembleCapturedThreadEvents(h.messages, "pi");
  expect(events.filter((event) => event.type === "turn/started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
  const taskEvents = events.filter(
    (event) => "item" in event && (event.item as { type?: string }).type === "backgroundTask",
  );
  expect(taskEvents.map((event) => event.type)).toEqual([
    "item/started",
    "item/backgroundTask/completed",
  ]);
  expect(events.findIndex((event) => event.type === "item/backgroundTask/completed")).toBeGreaterThan(
    events.findIndex((event) => event.type === "turn/completed"),
  );
  expect(h.readProcessLog().exited).toEqual([]);
});

it("reports a mid-turn command failure without closing the active parent, and retains ordinary steering", async () => {
  const h = await start("bb-pi-subagent-command-failure-");
  const threadId = "thr_subagent_command_failure";
  await h.startThread(threadId);
  const parent = turnStart(h, threadId, "/hold");
  await h.waitForDelta(threadId, (delta) => delta.kind === "turn.open");
  const since = h.deltasOf(threadId).length;

  expect(await steer(h, threadId, "/fail-command")).toMatchObject({ result: { threadId } });
  await h.waitForMessage(
    (message) =>
      message.method === "error" &&
      (message.params as { message?: string }).message === "fake command failed",
    "the command failure notification",
  );
  expect((h.deltasOf(threadId) as Delta[]).slice(since).some((delta) => delta.kind === "turn.boundary")).toBe(false);

  expect((await steer(h, threadId, "continue normally")).result).toEqual({ threadId });
  await replyTo(h, parent);
  await h.waitForTurnBoundary(threadId, since);
  expect(JSON.stringify((h.deltasOf(threadId) as Delta[]).slice(since))).toContain("Steered: continue normally");
});
