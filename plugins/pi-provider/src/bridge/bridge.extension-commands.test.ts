import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { replyTo, turnStart } from "./fork-test-support.js";
import { type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

vi.setConfig({ testTimeout: 30_000 });

const fakeCommandsPath = fileURLToPath(new URL("./fake-commands-extension.mjs", import.meta.url));

let harness: FakePiBridgeHarness | undefined;

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

async function start(prefix: string): Promise<FakePiBridgeHarness> {
  harness = await startFakePiBridge({ prefix, initialize: true });
  vi.stubEnv("FAKE_PI_EXTRA_EXTENSIONS", JSON.stringify([fakeCommandsPath]));
  return harness;
}

type Delta = Record<string, unknown> & { kind: string; text?: string; summary?: string; status?: string };

async function runTurn(h: FakePiBridgeHarness, threadId: string, text: string): Promise<Delta[]> {
  const since = h.deltasOf(threadId).length;
  const reply = await replyTo(h, turnStart(h, threadId, text));
  expect(reply.result).toEqual({ threadId });
  await h.waitForTurnBoundary(threadId, since);
  return (h.deltasOf(threadId) as Delta[]).slice(since);
}

it("settles a turn that runs an extension command, which pi runs without an agent run", async () => {
  const h = await start("bb-pi-extcmd-warning-");
  const threadId = "thr_extcmd_warning";
  await h.startThread(threadId);
  const deltas = await runTurn(h, threadId, "/tui-only");
  expect(deltas.map((delta) => delta.kind)).toEqual(
    expect.arrayContaining(["turn.open", "input.accepted", "provider.warning", "turn.boundary"]),
  );
  expect(deltas.find((delta) => delta.kind === "provider.warning")?.summary).toBe(
    "This command requires Pi's interactive TUI.",
  );
  expect(deltas.find((delta) => delta.kind === "turn.boundary")?.status).toBe("completed");
  // No model reply: the fake answers ordinary prompts with "Response to: ...".
  expect(JSON.stringify(deltas)).not.toContain("Response to:");
  const events = assembleCapturedThreadEvents(h.messages, "pi");
  expect(events.filter((event) => event.type === "turn/completed")).toHaveLength(1);
});

it("waits for a slow command, shows what it reports, and leaves the thread free for /reload", async () => {
  const h = await start("bb-pi-extcmd-slow-");
  const threadId = "thr_extcmd_slow";
  await h.startThread(threadId);
  const deltas = await runTurn(h, threadId, "/slow-report screenshots");
  const report = deltas.findIndex((delta) => delta.kind === "item.textClose");
  expect(deltas[report]?.text).toBe("Done: screenshots");
  expect(deltas.findIndex((delta) => delta.kind === "turn.boundary")).toBeGreaterThan(report);

  const reload = await runTurn(h, threadId, "/reload");
  expect(reload.find((delta) => delta.kind === "item.close")).toMatchObject({ status: "completed" });
});

it("still sends unknown slash text to the model", async () => {
  const h = await start("bb-pi-extcmd-unknown-");
  const threadId = "thr_extcmd_unknown";
  await h.startThread(threadId);
  const deltas = await runTurn(h, threadId, "/not-a-command please");
  expect(JSON.stringify(deltas)).toContain("Response to: /not-a-command please");
});
