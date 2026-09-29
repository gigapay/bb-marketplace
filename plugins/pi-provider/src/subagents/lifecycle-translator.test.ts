import { describe, expect, it } from "vitest";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createDeltaAssembler as createDeltaAssembler,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  parseSubagentsLifecycleChannelMessage,
  type SubagentLifecycleRun,
  type SubagentsLifecycleEvent,
} from "./lifecycle-contract.js";
import {
  SubagentLifecycleTranslator,
  describeRun,
  subagentProviderItemId,
} from "./lifecycle-translator.js";

const THREAD = "thr_a";
const OWNER = 1;

function harness(options: { originWaitMs?: number; exitGraceMs?: number } = {}) {
  const deltas: ThreadDelta[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const translator = new SubagentLifecycleTranslator({
    emit: (threadId, emitted) => {
      expect(threadId).toBe(THREAD);
      deltas.push(...emitted);
    },
    originWaitMs: options.originWaitMs ?? 1_000,
    exitGraceMs: options.exitGraceMs ?? 100,
    setTimer: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
  });
  const assembler = createDeltaAssembler({ providerId: "pi", progressThrottleMs: 0 });
  const events: ThreadEvent[] = [];
  let assembled = 0;
  return {
    translator,
    deltas,
    events,
    /** Feeds bridge deltas plus everything the translator emitted so far. */
    assemble(extra: ThreadDelta[] = []) {
      const pending = [...deltas.slice(assembled), ...extra];
      assembled = deltas.length;
      events.push(...assembler.assemble({ threadId: THREAD, deltas: pending }));
    },
    runTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
    pendingTimers: () => timers.size,
    bbItemId: (providerItemId: string) =>
      assembler.getBbItemId(THREAD, providerItemId),
  };
}

let sequence = 0;
function envelope(sessionId = "s1", sourceId = "src-1") {
  sequence += 1;
  return { v: 1 as const, sessionId, sourceId, sequence };
}

function run(overrides: Partial<SubagentLifecycleRun> = {}): SubagentLifecycleRun {
  return {
    id: "run-1",
    label: "reviewer",
    toolCallId: "call-1",
    harness: "pi",
    status: "queued",
    createdAt: 1,
    ...overrides,
  };
}

function upsert(
  runOverrides: Partial<SubagentLifecycleRun> = {},
  sessionId?: string,
  sourceId?: string,
): SubagentsLifecycleEvent {
  return { ...envelope(sessionId, sourceId), kind: "upsert", run: run(runOverrides) };
}

const TURN_WITH_SPAWN_TOOL: ThreadDelta[] = [
  { kind: "turn.open" },
  {
    kind: "item.open",
    key: { providerItemId: "call-1" },
    item: { type: "tool", tool: "subagent_spawn", args: {} },
  },
];

function backgroundEvents(events: ThreadEvent[]) {
  return events.flatMap((event) => {
    const item = "item" in event ? event.item : undefined;
    return item && typeof item === "object" && "type" in item && item.type === "backgroundTask"
      ? [{ type: event.type, item }]
      : [];
  });
}

describe("the lifecycle channel contract", () => {
  it("accepts the allowlisted envelope and rejects anything else", () => {
    const valid = { kind: "subagents-lifecycle", event: upsert() };
    expect(parseSubagentsLifecycleChannelMessage(valid)).not.toBeNull();
    const withPrompt = {
      kind: "subagents-lifecycle",
      event: { ...upsert(), run: { ...run(), prompt: "secret" } },
    };
    expect(parseSubagentsLifecycleChannelMessage(withPrompt)).toBeNull();
    expect(
      parseSubagentsLifecycleChannelMessage({
        kind: "subagents-lifecycle",
        event: { ...upsert(), v: 2 },
      }),
    ).toBeNull();
    expect(
      parseSubagentsLifecycleChannelMessage({
        kind: "subagents-lifecycle",
        event: upsert({ label: "x".repeat(201) }),
      }),
    ).toBeNull();
    expect(
      parseSubagentsLifecycleChannelMessage({
        kind: "subagents-lifecycle",
        event: { ...envelope(), kind: "snapshot", runs: Array.from({ length: 257 }, (_, i) => run({ id: `r${i}` })) },
      }),
    ).toBeNull();
    expect(parseSubagentsLifecycleChannelMessage({ kind: "tool-call" })).toBeNull();
  });
});

describe("the subagent lifecycle translator", () => {
  it("buffers a run until its spawn tool item exists, then attaches under it and outlives the turn", () => {
    const h = harness();
    h.assemble([{ kind: "turn.open" }]);
    h.translator.handleEvent(THREAD, OWNER, upsert());
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    expect(h.deltas).toEqual([]);

    h.assemble([TURN_WITH_SPAWN_TOOL[1]!]);
    h.translator.observeToolStart(THREAD, "call-1");
    h.assemble([
      { kind: "item.close", key: { providerItemId: "call-1" }, status: "completed", item: { type: "tool", tool: "subagent_spawn" } },
      { kind: "turn.boundary", status: "completed" },
    ]);
    // The parent turn is over; the run is still reported and settles later.
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed", settledAt: 5 }));
    h.assemble();

    const events = backgroundEvents(h.events);
    expect(events.map((event) => [event.type, event.item.taskStatus])).toEqual([
      ["item/started", "running"],
      ["item/backgroundTask/completed", "completed"],
    ]);
    const started = events[0]!.item;
    expect(started).toMatchObject({
      taskType: "local_agent",
      description: "reviewer",
      skipTranscript: false,
      familyId: subagentProviderItemId("s1", "run-1"),
      parentToolCallId: h.bbItemId("call-1"),
    });
    expect(events[1]!.item.id).toBe(started.id);
    expect(events[1]!.item.status).toBe("completed");
  });

  it("maps every status onto bb's task and item statuses", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert());
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "cancelled" }));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => [event.type, event.item.taskStatus, event.item.status])).toEqual([
      ["item/started", "pending", "pending"],
      ["item/backgroundTask/progress", "running", "pending"],
      ["item/backgroundTask/completed", "stopped", "interrupted"],
    ]);
  });

  it("shows an immediate backend failure that settled before the tool item arrived", () => {
    const h = harness();
    h.translator.handleEvent(THREAD, OWNER, upsert());
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "failed", settledAt: 2 }));
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => [event.type, event.item.taskStatus])).toEqual([
      ["item/started", "running"],
      ["item/backgroundTask/completed", "failed"],
    ]);
  });

  it("opens anyway when the tool item never shows up, but only once a turn existed", () => {
    const withTurn = harness();
    withTurn.assemble([{ kind: "turn.open" }]);
    withTurn.translator.observeTurnOpen(THREAD);
    withTurn.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    withTurn.runTimers();
    withTurn.assemble();
    expect(backgroundEvents(withTurn.events).map((event) => event.type)).toEqual(["item/started"]);

    const noTurn = harness();
    noTurn.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    noTurn.runTimers();
    noTurn.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }));
    expect(noTurn.deltas).toEqual([]);
  });

  it("never replays or duplicates items for repeated snapshots and stale sequences", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    const first = upsert({ status: "running" });
    h.translator.handleEvent(THREAD, OWNER, first);
    const snapshot = (): SubagentsLifecycleEvent => ({ ...envelope(), kind: "snapshot", runs: [run({ status: "running" })] });
    h.translator.handleEvent(THREAD, OWNER, snapshot());
    h.translator.handleEvent(THREAD, OWNER, snapshot());
    h.translator.handleEvent(THREAD, OWNER, first);
    h.assemble();
    expect(backgroundEvents(h.events)).toHaveLength(1);
  });

  it("keeps the same run id in two pi sessions apart", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }, "s1", "src-a"));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }, "s2", "src-b"));
    h.assemble();
    const ids = backgroundEvents(h.events).map((event) => event.item.familyId);
    expect(ids).toEqual([
      subagentProviderItemId("s1", "run-1"),
      subagentProviderItemId("s2", "run-1"),
    ]);
  });

  it("does not resurrect restored runs a new publisher reports as already settled", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "failed" }, "s1", "src-restored"));
    h.translator.handleEvent(THREAD, OWNER, {
      ...envelope("s1", "src-restored"),
      kind: "snapshot",
      runs: [run({ status: "failed" }), run({ id: "run-2", status: "completed" })],
    });
    expect(h.deltas).toEqual([]);
  });

  it("settles live runs on clear and ignores anything that source says afterwards", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.handleEvent(THREAD, OWNER, { ...envelope(), kind: "clear" });
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ id: "run-9", status: "running" }));
    h.runTimers();
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => [event.type, event.item.taskStatus])).toEqual([
      ["item/started", "running"],
      ["item/backgroundTask/completed", "stopped"],
    ]);
  });

  it("settles what an exited pi child can no longer report, after a short drain", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.handleChildExit(THREAD, OWNER);
    expect(h.translator.activeRunCount(THREAD)).toBe(1);
    h.runTimers();
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.item.taskStatus)).toEqual(["running", "stopped"]);
    expect(h.translator.activeRunCount(THREAD)).toBe(0);
  });

  it("keeps the first terminal state when cancel and completion race", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "cancelled" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.item.taskStatus)).toEqual(["running", "stopped"]);
  });

  it("lets a superseded publisher settle its runs but never move them forward", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "queued" }, "s1", "old"));
    h.translator.handleEvent(THREAD, 2, { ...envelope("s1", "new"), kind: "snapshot", runs: [] });
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }, "s1", "old"));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "cancelled" }, "s1", "old"));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.item.taskStatus)).toEqual(["pending", "stopped"]);
  });

  it("forgets a discarded thread so late events cannot create ghosts", () => {
    const h = harness();
    h.translator.handleEvent(THREAD, OWNER, upsert());
    h.translator.forgetThread(THREAD);
    expect(h.pendingTimers()).toBe(0);
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }));
    h.runTimers();
    expect(h.deltas).toEqual([]);
  });

  it("settles every open run synchronously before the bridge exits", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.settleAll();
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.type)).toEqual([
      "item/started",
      "item/backgroundTask/completed",
    ]);
  });
});

describe("the subagent lifecycle translator's owners and resets", () => {
  it("settles open tasks before session.reset so no duplicate row appears", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    h.translator.handleSessionReset(THREAD);
    h.assemble([{ kind: "session.reset" }]);
    // The old child's shutdown cancellation arrives after the reset.
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "cancelled" }));
    h.assemble();
    const events = backgroundEvents(h.events);
    expect(events.map((event) => [event.type, event.item.taskStatus])).toEqual([
      ["item/started", "running"],
      ["item/backgroundTask/completed", "stopped"],
    ]);
    expect(events[1]!.item.id).toBe(events[0]!.item.id);
  });

  it("holds a constructing child's events and drops them if its construction fails", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }, "s1", "old"));
    // A replacement publishes (its restore marks the run failed), then fails.
    h.translator.beginOwner(THREAD, 2);
    h.translator.handleEvent(THREAD, 2, upsert({ status: "failed" }, "s1", "replacement"));
    h.translator.retireOwner(THREAD, 2);
    // The surviving child still owns the thread: its runs keep flowing.
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "completed" }, "s1", "old"));
    h.translator.handleEvent(THREAD, OWNER, upsert({ id: "run-2", toolCallId: "call-1", status: "running" }, "s1", "old"));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => [event.item.familyId, event.item.taskStatus])).toEqual([
      [subagentProviderItemId("s1", "run-1"), "running"],
      [subagentProviderItemId("s1", "run-1"), "completed"],
      [subagentProviderItemId("s1", "run-2"), "running"],
    ]);
  });

  it("applies a constructing child's held events once it is established", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.beginOwner(THREAD, 3);
    h.translator.handleEvent(THREAD, 3, upsert({ status: "running" }, "s1", "fresh"));
    expect(h.deltas).toEqual([]);
    h.translator.establishOwner(THREAD, 3);
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.type)).toEqual(["item/started"]);
  });

  it("counts a running run that is not displayed as blocking a reload", () => {
    const h = harness();
    h.translator.handleEvent(THREAD, OWNER, upsert({ toolCallId: undefined, status: "running" }));
    expect(h.deltas).toEqual([]);
    expect(h.translator.activeRunCount(THREAD)).toBe(1);
    h.translator.handleEvent(THREAD, OWNER, upsert({ toolCallId: undefined, status: "completed" }));
    expect(h.translator.activeRunCount(THREAD)).toBe(0);
  });

  it("ignores a retired child and does not recreate a forgotten thread", () => {
    const h = harness();
    h.translator.beginOwner(THREAD, 4);
    h.translator.establishOwner(THREAD, 4);
    h.translator.handleChildExit(THREAD, 4);
    h.runTimers();
    h.translator.handleEvent(THREAD, 4, upsert({ status: "running" }));
    expect(h.translator.activeRunCount(THREAD)).toBe(0);
    h.translator.forgetThread(THREAD);
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running" }));
    expect(h.translator.activeRunCount(THREAD)).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe("the subagent row text", () => {
  it("shows the agent-file profile, model, and thinking, and the profile only when it adds something", () => {
    expect(describeRun(run({ label: "Recapture dialogs", agent: "designer", model: "openai-codex/gpt-5.6-sol", thinking: "high" }))).toBe(
      "Recapture dialogs (designer) · openai-codex/gpt-5.6-sol · high",
    );
    // pi-toolbox falls back to the profile as label when no name was given.
    expect(describeRun(run({ label: "designer", agent: "designer", model: "m" }))).toBe("designer · m");
    // Ad-hoc runs carry no profile.
    expect(describeRun(run({ label: "Quick check", thinking: "low" }))).toBe("Quick check · low");
    expect(describeRun(run({ label: "  " }))).toBe("Subagent");
  });

  it("updates the row when routing resolves the effective model", () => {
    const h = harness();
    h.assemble(TURN_WITH_SPAWN_TOOL);
    h.translator.observeToolStart(THREAD, "call-1");
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running", model: "requested" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running", model: "effective" }));
    h.translator.handleEvent(THREAD, OWNER, upsert({ status: "running", model: "effective" }));
    h.assemble();
    expect(backgroundEvents(h.events).map((event) => event.item.description)).toEqual([
      "reviewer · requested",
      "reviewer · effective",
    ]);
  });

  it("rejects display fields outside their bounds", () => {
    const bad = (overrides: Partial<SubagentLifecycleRun>) =>
      parseSubagentsLifecycleChannelMessage({ kind: "subagents-lifecycle", event: upsert(overrides) });
    expect(bad({ agent: "a".repeat(101) })).toBeNull();
    expect(bad({ model: "" })).toBeNull();
    expect(bad({ thinking: "High Effort" })).toBeNull();
    expect(bad({ agent: "designer", model: "m", thinking: "xhigh" })).not.toBeNull();
  });
});
