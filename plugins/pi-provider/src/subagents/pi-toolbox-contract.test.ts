import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler as createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { parseSubagentsLifecycleChannelMessage } from "./lifecycle-contract.js";
import { SubagentLifecycleTranslator } from "./lifecycle-translator.js";

/**
 * Contract check against the real pi-toolbox publisher when it is installed
 * (Pi's git package cache, or PI_TOOLBOX_SUBAGENTS_DIR). Skipped otherwise:
 * the always-on coverage is the fake extension in fake-subagents-extension.mjs.
 */
const subagentsDir =
  process.env.PI_TOOLBOX_SUBAGENTS_DIR ??
  path.join(homedir(), ".pi/agent/git/github.com/yteruel31/pi-toolbox/packages/subagents");
const lifecycleSource = path.join(subagentsDir, "src/shared/lifecycle.ts");

interface Publisher {
  update(state: unknown): void;
  snapshot(): void;
  clear(): void;
}

function record(overrides: Record<string, unknown>) {
  return {
    id: "run-1",
    serial: 1,
    title: "Review the diff and report back with SECRET-TITLE",
    harness: "pi",
    status: "queued",
    createdAt: 10,
    settledAt: undefined,
    settlementSeq: undefined,
    workingDir: "/secret/working/dir",
    requestedModel: undefined,
    effectiveModel: undefined,
    thinkingLevel: undefined,
    cancelRequested: false,
    autoDeliver: true,
    consumption: "unconsumed",
    finalText: "SECRET-RESULT",
    errorText: "SECRET-ERROR",
    usage: undefined,
    activity: [],
    activityDropped: 0,
    origin: { toolCallId: "call-1", label: "reviewer" },
    ...overrides,
  };
}

describe.skipIf(!existsSync(lifecycleSource))("the installed pi-toolbox lifecycle publisher", () => {
  it("emits events the bridge accepts, without private fields, that render as one native task", async () => {
    const module = (await import(pathToFileURL(lifecycleSource).href)) as {
      LifecyclePublisher: new (
        sessionId: string,
        sourceId: string,
        emit: (event: unknown) => void,
      ) => Publisher;
      SUBAGENTS_LIFECYCLE_CHANNEL: string;
    };
    expect(module.SUBAGENTS_LIFECYCLE_CHANNEL).toBe("pi-toolbox:subagents:lifecycle");
    const events: unknown[] = [];
    const publisher = new module.LifecyclePublisher("session-a", "source-a", (event) =>
      events.push(JSON.parse(JSON.stringify(event))),
    );
    const state = (status: string, settledAt?: number) => ({
      version: 1,
      nextSerial: 2,
      nextSettlementSeq: 1,
      runs: [record({ status, settledAt })],
    });
    publisher.update(state("queued"));
    publisher.update(state("running"));
    publisher.snapshot();
    publisher.update(state("completed", 20));
    publisher.clear();

    const serialized = JSON.stringify(events);
    for (const secret of ["SECRET-TITLE", "SECRET-RESULT", "SECRET-ERROR", "/secret/working/dir"]) {
      expect(serialized).not.toContain(secret);
    }
    const parsed = events.map((event) =>
      parseSubagentsLifecycleChannelMessage({ kind: "subagents-lifecycle", event }),
    );
    expect(parsed.every((event) => event !== null)).toBe(true);

    const deltas: ThreadDelta[] = [];
    const translator = new SubagentLifecycleTranslator({
      emit: (_threadId, emitted) => deltas.push(...emitted),
    });
    translator.observeToolStart("thr", "call-1");
    for (const event of parsed) translator.handleEvent("thr", 1, event!);
    const assembled = createDeltaAssembler({ providerId: "pi", progressThrottleMs: 0 }).assemble({
      threadId: "thr",
      deltas: [
        { kind: "turn.open" },
        { kind: "item.open", key: { providerItemId: "call-1" }, item: { type: "tool", tool: "subagent_spawn", args: {} } },
        ...deltas,
      ],
    });
    const tasks = assembled.filter(
      (event) => "item" in event && (event.item as { type?: string }).type === "backgroundTask",
    );
    expect(tasks.map((event) => [event.type, (event as { item: { taskStatus: string } }).item.taskStatus])).toEqual([
      ["item/started", "pending"],
      ["item/backgroundTask/progress", "running"],
      ["item/backgroundTask/completed", "completed"],
    ]);
    expect((tasks[0] as { item: { description: string } }).item.description).toBe("reviewer");
  });
});
