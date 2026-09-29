import {
  backgroundTaskItemStatus,
  type BackgroundTaskStatus,
  type DeltaBackgroundTaskShape,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  isTerminalLifecycleStatus,
  type SubagentLifecycleRun,
  type SubagentLifecycleStatus,
  type SubagentsLifecycleEvent,
} from "./lifecycle-contract.js";

/** bb's native background-agent task type (Claude uses the same one). */
export const SUBAGENT_TASK_TYPE = "local_agent";

const TASK_STATUS: Record<SubagentLifecycleStatus, BackgroundTaskStatus> = {
  queued: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "stopped",
};

const MAX_RUNS_PER_THREAD = 512;
const MAX_SEEN_TOOL_CALLS = 1024;
const MAX_SOURCES_PER_THREAD = 64;
const MAX_PENDING_EVENTS_PER_OWNER = 256;
const MAX_REMEMBERED_IDS = 4096;

/**
 * `phase` is the display lifecycle, not the run status:
 * - buffered: waiting for the spawn tool item so the task attaches under it
 * - open: a bb item exists and can still change
 * - closed: terminal on bb's side; nothing reopens it
 * - hidden: never displayed (restored, commandless, or no live turn), but
 *   still tracked so a running one keeps blocking /reload
 */
type RunPhase = "buffered" | "open" | "closed" | "hidden";

/**
 * An owner is one pi child (the bridge's session serial). Its events are held
 * while it is `pending` (still constructing: a failed replacement must not
 * touch the runs of the child it would have replaced) and ignored once it is
 * `retired` (construction failed or the child exited).
 */
type OwnerStatus = "pending" | "live" | "retired";

interface TrackedRun {
  key: string;
  providerItemId: string;
  run: SubagentLifecycleRun;
  phase: RunPhase;
  sourceId: string;
  owner: number;
  originTimer: unknown;
}

interface SourceState {
  sessionId: string;
  lastSequence: number;
  retired: boolean;
  owner: number;
}

interface ThreadState {
  runs: Map<string, TrackedRun>;
  /** Insertion order is arrival order: the newest live source wins. */
  sources: Map<string, SourceState>;
  owners: Map<number, OwnerStatus>;
  pendingEvents: Map<number, SubagentsLifecycleEvent[]>;
  seenToolCalls: Set<string>;
  turnSeen: boolean;
  exitTimers: Set<unknown>;
}

export interface SubagentLifecycleTranslatorOptions {
  emit: (threadId: string, deltas: ThreadDelta[]) => void;
  /** How long a run waits for its spawn tool item before opening anyway. */
  originWaitMs?: number;
  /** Lets the last FD 3 lines of an exited child drain before the sweep. */
  exitGraceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** Collision-free across sessions: both parts are URI-encoded. */
export function subagentProviderItemId(sessionId: string, runId: string): string {
  return `pi-subagent:${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}`;
}

function remember<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done === true) break;
    set.delete(oldest.value);
  }
}

/**
 * Projects pi-toolbox lifecycle telemetry onto bb's native `backgroundTask`
 * items. State is per bb thread and deliberately separate from the per-turn
 * tool state: a run outlives its spawn tool call and the parent turn, so
 * neither `tool_execution_end` nor `agent_end` touches it.
 */
export class SubagentLifecycleTranslator {
  private readonly threads = new Map<string, ThreadState>();
  /** Owner serials are unique per bridge, so this spans threads. */
  private readonly retiredOwners = new Set<number>();
  private readonly forgottenThreads = new Set<string>();
  private readonly emit: SubagentLifecycleTranslatorOptions["emit"];
  private readonly originWaitMs: number;
  private readonly exitGraceMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(options: SubagentLifecycleTranslatorOptions) {
    this.emit = options.emit;
    this.originWaitMs = options.originWaitMs ?? 1_500;
    this.exitGraceMs = options.exitGraceMs ?? 250;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** A pi child for this thread is being constructed; hold its events. */
  beginOwner(threadId: string, owner: number): void {
    this.forgottenThreads.delete(threadId);
    this.thread(threadId).owners.set(owner, "pending");
  }

  /** The child reported ready and is now the thread's session. */
  establishOwner(threadId: string, owner: number): void {
    const state = this.threads.get(threadId);
    if (!state || state.owners.get(owner) !== "pending") return;
    state.owners.set(owner, "live");
    const held = state.pendingEvents.get(owner) ?? [];
    state.pendingEvents.delete(owner);
    for (const event of held) this.handleEvent(threadId, owner, event);
  }

  /** The child is gone (construction failed, or it exited): settle its runs. */
  retireOwner(threadId: string, owner: number): void {
    remember(this.retiredOwners, owner, MAX_REMEMBERED_IDS);
    const state = this.threads.get(threadId);
    if (!state) return;
    state.owners.set(owner, "retired");
    state.pendingEvents.delete(owner);
    for (const source of state.sources.values()) {
      if (source.owner === owner) source.retired = true;
    }
    this.sweep(threadId, (tracked) => tracked.owner === owner);
    this.pruneIfIdle(threadId);
  }

  /** A pi `agent_start` reached bb, so the assembler has a turn to attach to. */
  observeTurnOpen(threadId: string): void {
    this.forgottenThreads.delete(threadId);
    this.thread(threadId).turnSeen = true;
  }

  /** The spawn tool item was forwarded; release runs waiting for it. */
  observeToolStart(threadId: string, toolCallId: string): void {
    this.forgottenThreads.delete(threadId);
    const state = this.thread(threadId);
    state.turnSeen = true;
    remember(state.seenToolCalls, toolCallId, MAX_SEEN_TOOL_CALLS);
    const deltas: ThreadDelta[] = [];
    for (const tracked of state.runs.values()) {
      if (tracked.phase === "buffered" && tracked.run.toolCallId === toolCallId) {
        this.release(tracked, deltas);
      }
    }
    this.flush(threadId, deltas);
  }

  /**
   * About to send `session.reset`: bb's assembler drops the whole thread state
   * on it (turns and provider-to-bb item ids), so every task still open must
   * settle first, or a later close would mint a second, duplicate row. A
   * reset only follows a new pi child, and the old one's runs end with it.
   */
  handleSessionReset(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    this.sweep(threadId, () => true);
    state.seenToolCalls.clear();
    state.turnSeen = false;
  }

  handleEvent(
    threadId: string,
    owner: number,
    event: SubagentsLifecycleEvent,
  ): void {
    if (this.retiredOwners.has(owner)) return;
    if (this.forgottenThreads.has(threadId) && !this.threads.has(threadId)) return;
    const state = this.thread(threadId);
    const ownerStatus = state.owners.get(owner) ?? "live";
    if (ownerStatus === "retired") return;
    if (ownerStatus === "pending") {
      const held = state.pendingEvents.get(owner) ?? [];
      if (held.length < MAX_PENDING_EVENTS_PER_OWNER) held.push(event);
      state.pendingEvents.set(owner, held);
      return;
    }
    const source = this.acceptSource(state, owner, event);
    if (!source) return;
    const deltas: ThreadDelta[] = [];
    switch (event.kind) {
      case "upsert":
        this.applyRun(threadId, state, event.sessionId, event.sourceId, owner, event.run, deltas);
        break;
      case "snapshot":
        for (const run of event.runs) {
          this.applyRun(threadId, state, event.sessionId, event.sourceId, owner, run, deltas);
        }
        break;
      case "clear":
        // Shutdown already settled the runs; anything still live from this
        // source can no longer report and must not stay pending.
        source.retired = true;
        for (const tracked of state.runs.values()) {
          if (tracked.sourceId === event.sourceId) {
            this.interrupt(tracked, deltas);
          }
        }
        break;
    }
    this.flush(threadId, deltas);
  }

  /** The pi child behind `owner` exited; settle what it can no longer report. */
  handleChildExit(threadId: string, owner: number): void {
    const state = this.threads.get(threadId);
    if (!state) {
      remember(this.retiredOwners, owner, MAX_REMEMBERED_IDS);
      return;
    }
    const timer = this.setTimer(() => {
      state.exitTimers.delete(timer);
      this.retireOwner(threadId, owner);
    }, this.exitGraceMs);
    state.exitTimers.add(timer);
  }

  /** Synchronous last-chance settlement before the bridge process exits. */
  settleAll(): void {
    for (const threadId of [...this.threads.keys()]) {
      this.sweep(threadId, () => true);
    }
  }

  /** Runs a restart would cancel: every unsettled run of a live child. */
  activeRunCount(threadId: string): number {
    const state = this.threads.get(threadId);
    if (!state) return 0;
    let count = 0;
    for (const tracked of state.runs.values()) {
      if (
        tracked.phase !== "closed" &&
        !isTerminalLifecycleStatus(tracked.run.status) &&
        state.owners.get(tracked.owner) !== "retired" &&
        !this.retiredOwners.has(tracked.owner) &&
        state.sources.get(tracked.sourceId)?.retired !== true
      ) {
        count += 1;
      }
    }
    return count;
  }

  /** Drops a discarded thread; late events cannot resurrect its runs. */
  forgetThread(threadId: string): void {
    this.dropThread(threadId);
    remember(this.forgottenThreads, threadId, MAX_REMEMBERED_IDS);
  }

  /** Test and teardown aid: drop every thread and pending timer. */
  reset(): void {
    for (const threadId of [...this.threads.keys()]) this.dropThread(threadId);
    this.retiredOwners.clear();
    this.forgottenThreads.clear();
  }

  private dropThread(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    for (const tracked of state.runs.values()) this.cancelOriginTimer(tracked);
    for (const timer of state.exitTimers) this.clearTimer(timer);
    this.threads.delete(threadId);
  }

  /** A stopped thread with nothing left to settle holds no memory. */
  private pruneIfIdle(threadId: string): void {
    const state = this.threads.get(threadId);
    if (!state || state.exitTimers.size > 0) return;
    for (const status of state.owners.values()) {
      if (status !== "retired") return;
    }
    for (const tracked of state.runs.values()) {
      if (tracked.phase === "open" || tracked.phase === "buffered") return;
    }
    this.dropThread(threadId);
  }

  private thread(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        runs: new Map(),
        sources: new Map(),
        owners: new Map(),
        pendingEvents: new Map(),
        seenToolCalls: new Set(),
        turnSeen: false,
        exitTimers: new Set(),
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private acceptSource(
    state: ThreadState,
    owner: number,
    event: SubagentsLifecycleEvent,
  ): SourceState | null {
    let source = state.sources.get(event.sourceId);
    if (!source) {
      source = {
        sessionId: event.sessionId,
        lastSequence: -1,
        retired: false,
        owner,
      };
      state.sources.set(event.sourceId, source);
      while (state.sources.size > MAX_SOURCES_PER_THREAD) {
        const oldest = state.sources.keys().next();
        if (oldest.done === true) break;
        state.sources.delete(oldest.value);
      }
    }
    if (
      source.retired ||
      source.owner !== owner ||
      source.sessionId !== event.sessionId ||
      event.sequence <= source.lastSequence
    ) {
      return null;
    }
    source.lastSequence = event.sequence;
    return source;
  }

  /** A new publisher lifetime (reload, rebuild) supersedes older live ones. */
  private latestLiveSource(state: ThreadState, sessionId: string): string | undefined {
    let latest: string | undefined;
    for (const [sourceId, source] of state.sources) {
      if (source.sessionId === sessionId && !source.retired) latest = sourceId;
    }
    return latest;
  }

  private applyRun(
    threadId: string,
    state: ThreadState,
    sessionId: string,
    sourceId: string,
    owner: number,
    run: SubagentLifecycleRun,
    deltas: ThreadDelta[],
  ): void {
    const key = JSON.stringify([sessionId, run.id]);
    const terminal = isTerminalLifecycleStatus(run.status);
    const superseded = this.latestLiveSource(state, sessionId) !== sourceId;
    // A superseded publisher may still settle its own runs (shutdown
    // cancellation), but never moves one forward.
    if (superseded && !terminal) return;
    const tracked = state.runs.get(key);
    if (!tracked) {
      if (superseded) return;
      const created: TrackedRun = {
        key,
        providerItemId: subagentProviderItemId(sessionId, run.id),
        run,
        phase: "hidden",
        sourceId,
        owner,
        originTimer: undefined,
      };
      this.track(state, created);
      // Terminal on first sight means a restored or already-finished run
      // this bridge never showed: displaying it now would be a ghost.
      if (terminal || run.toolCallId === undefined) return;
      if (state.seenToolCalls.has(run.toolCallId)) {
        this.open(created, deltas);
        return;
      }
      created.phase = "buffered";
      created.originTimer = this.setTimer(() => {
        created.originTimer = undefined;
        if (created.phase !== "buffered") return;
        const late: ThreadDelta[] = [];
        if (this.threads.get(threadId)?.turnSeen === true) {
          this.release(created, late);
        } else {
          created.phase = "hidden";
        }
        this.flush(threadId, late);
      }, this.originWaitMs);
      return;
    }
    if (tracked.phase === "closed") return;
    const previous = tracked.run;
    tracked.run = { ...run, toolCallId: previous.toolCallId ?? run.toolCallId };
    tracked.sourceId = sourceId;
    tracked.owner = owner;
    // Hidden runs are only tracked (they may block /reload); buffered ones
    // replay their latest state when their tool item arrives.
    if (tracked.phase === "hidden" || tracked.phase === "buffered") return;
    if (terminal) {
      this.close(tracked, deltas);
      return;
    }
    if (previous.status !== run.status || previous.label !== run.label) {
      deltas.push({
        kind: "item.progress",
        key: this.itemKey(tracked),
        snapshot: this.shape(tracked, TASK_STATUS[run.status]),
        ...(previous.status !== run.status ? { flush: true } : {}),
      });
    }
  }

  private track(state: ThreadState, tracked: TrackedRun): void {
    state.runs.set(tracked.key, tracked);
    if (state.runs.size <= MAX_RUNS_PER_THREAD) return;
    for (const [key, candidate] of state.runs) {
      if (
        candidate.phase === "closed" ||
        (candidate.phase === "hidden" && isTerminalLifecycleStatus(candidate.run.status))
      ) {
        state.runs.delete(key);
        if (state.runs.size <= MAX_RUNS_PER_THREAD) return;
      }
    }
  }

  /** Opens a buffered run, settling it at once if it already finished. */
  private release(tracked: TrackedRun, deltas: ThreadDelta[]): void {
    this.cancelOriginTimer(tracked);
    this.open(tracked, deltas);
    if (isTerminalLifecycleStatus(tracked.run.status)) {
      this.close(tracked, deltas);
    }
  }

  private open(tracked: TrackedRun, deltas: ThreadDelta[]): void {
    tracked.phase = "open";
    const status = isTerminalLifecycleStatus(tracked.run.status)
      ? "running"
      : TASK_STATUS[tracked.run.status];
    deltas.push({
      kind: "item.open",
      key: this.itemKey(tracked),
      item: this.shape(tracked, status),
      // A run can start between turns (a buffered release after agent_end);
      // attach to the last turn rather than synthesizing one.
      attach: "currentOrLast",
    });
  }

  private close(tracked: TrackedRun, deltas: ThreadDelta[]): void {
    this.cancelOriginTimer(tracked);
    tracked.phase = "closed";
    const shape = this.shape(tracked, TASK_STATUS[tracked.run.status]);
    deltas.push({
      kind: "item.close",
      key: this.itemKey(tracked),
      status: shape.status,
      item: shape,
    });
  }

  private interrupt(tracked: TrackedRun, deltas: ThreadDelta[]): void {
    if (!isTerminalLifecycleStatus(tracked.run.status)) {
      tracked.run = { ...tracked.run, status: "cancelled" };
    }
    if (tracked.phase === "buffered" || tracked.phase === "hidden") {
      this.cancelOriginTimer(tracked);
      tracked.phase = "hidden";
      return;
    }
    if (tracked.phase !== "open") return;
    this.close(tracked, deltas);
  }

  private sweep(threadId: string, select: (tracked: TrackedRun) => boolean): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    const deltas: ThreadDelta[] = [];
    for (const tracked of state.runs.values()) {
      if (select(tracked)) this.interrupt(tracked, deltas);
    }
    this.flush(threadId, deltas);
  }

  private cancelOriginTimer(tracked: TrackedRun): void {
    if (tracked.originTimer !== undefined) {
      this.clearTimer(tracked.originTimer);
      tracked.originTimer = undefined;
    }
  }

  private itemKey(tracked: TrackedRun): { providerItemId: string; parentRef?: string } {
    return {
      providerItemId: tracked.providerItemId,
      ...(tracked.run.toolCallId === undefined
        ? {}
        : { parentRef: tracked.run.toolCallId }),
    };
  }

  private shape(
    tracked: TrackedRun,
    taskStatus: BackgroundTaskStatus,
  ): DeltaBackgroundTaskShape {
    return {
      type: "backgroundTask",
      familyId: tracked.providerItemId,
      taskType: SUBAGENT_TASK_TYPE,
      description: tracked.run.label.trim() || "Subagent",
      status: backgroundTaskItemStatus(taskStatus),
      taskStatus,
      // bb hides skipTranscript tasks from the timeline and the agent list.
      skipTranscript: false,
    };
  }

  private flush(threadId: string, deltas: ThreadDelta[]): void {
    if (deltas.length > 0) this.emit(threadId, deltas);
  }
}
