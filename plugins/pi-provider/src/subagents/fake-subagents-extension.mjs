// A scripted stand-in for pi-toolbox's subagents extension, speaking the same
// pi.events lifecycle contract as its LifecyclePublisher: queued then running
// then one terminal state, a snapshot on request and at startup, cancel then
// clear on shutdown, interrupted restored runs as failed. Tests drive it with
// `/tool subagent_spawn {...}` prompts through fake-pi-rpc.mjs.
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const CHANNEL = "pi-toolbox:subagents:lifecycle";
const REQUEST_CHANNEL = "pi-toolbox:subagents:lifecycle:request";

export default function fakeSubagents(pi) {
  const sessionId = process.env.FAKE_SUBAGENTS_SESSION_ID ?? "fake-session";
  const runs = new Map();
  const timers = new Map();
  let sourceId = null;
  let sequence = 0;
  let closed = false;
  let nextSerial = 1;

  function emit(payload) {
    if (sourceId === null) return;
    const event = { v: 1, sessionId, sourceId, sequence: ++sequence, ...payload };
    if (process.env.FAKE_SUBAGENTS_EVENT_LOG) {
      appendFileSync(process.env.FAKE_SUBAGENTS_EVENT_LOG, `${JSON.stringify(event)}\n`);
    }
    pi.events.emit(CHANNEL, event);
  }

  function update(run, patch) {
    if (closed) return;
    Object.assign(run, patch);
    emit({ kind: "upsert", run: { ...run } });
  }

  function settle(run, status) {
    if (closed || !["queued", "running"].includes(run.status)) return;
    clearTimeout(timers.get(run.id));
    timers.delete(run.id);
    update(run, { status, settledAt: Date.now() });
  }

  pi.events.on(REQUEST_CHANNEL, (request) => {
    if (request && request.v === 1 && sourceId !== null && !closed) {
      emit({ kind: "snapshot", runs: [...runs.values()].map((run) => ({ ...run })) });
    }
  });

  if (process.env.FAKE_SUBAGENTS_SNAPSHOT_AT_LOAD === "1") {
    // A publisher that is live before pi reports ready (or never does).
    sourceId = randomUUID();
    emit({ kind: "snapshot", runs: [] });
  }

  pi.on("session_start", async () => {
    sourceId ??= randomUUID();
    const restored = process.env.FAKE_SUBAGENTS_RESTORE_FILE
      ? JSON.parse(readFileSync(process.env.FAKE_SUBAGENTS_RESTORE_FILE, "utf8"))
      : [];
    for (const record of restored) {
      const status = ["queued", "running"].includes(record.status) ? "failed" : record.status;
      const run = { ...record, status };
      runs.set(run.id, run);
      emit({ kind: "upsert", run: { ...run } });
    }
    emit({ kind: "snapshot", runs: [...runs.values()].map((run) => ({ ...run })) });
  });

  pi.on("session_shutdown", async () => {
    for (const run of runs.values()) settle(run, "cancelled");
    closed = true;
    emit({ kind: "clear" });
    runs.clear();
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "subagent_spawn",
    description: "Spawn a background subagent",
    parameters: {},
    async execute(toolCallId, params) {
      const run = {
        id: `run-${nextSerial++}`,
        label: params.name ?? params.agent ?? "Subagent",
        toolCallId,
        harness: params.harness ?? "pi",
        status: "queued",
        createdAt: Date.now(),
        // Display fields per the contract: the profile only for agent-file runs.
        ...(params.agent ? { agent: params.agent } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.thinking ? { thinking: params.thinking } : {}),
        // Never forwarded: the bb extension copies an allowlist only.
        prompt: params.prompt,
      };
      runs.set(run.id, run);
      emit({ kind: "upsert", run: { ...run } });
      if (params.failImmediately) {
        settle(run, "failed");
      } else {
        update(run, {
          status: "running",
          // Routing may resolve the effective model once the run starts.
          ...(params.resolvedModel ? { model: params.resolvedModel } : {}),
        });
        if (params.outcome !== "hold") {
          timers.set(
            run.id,
            setTimeout(() => settle(run, params.outcome ?? "completed"), params.durationMs ?? 50),
          );
        }
      }
      return { content: [{ type: "text", text: `spawned ${run.id}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "subagent_cancel",
    description: "Cancel a background subagent",
    parameters: {},
    async execute(_toolCallId, params) {
      const run = runs.get(params.id);
      if (run) settle(run, "cancelled");
      return { content: [{ type: "text", text: `cancelled ${params.id}` }], details: {} };
    },
  });
}
