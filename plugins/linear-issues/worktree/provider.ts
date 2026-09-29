// The "Linear worktree" environment provider: BB's Worktree provider (see
// ORIGIN.md), except the branch is the ticket's Linear branch name and the
// folder can live wherever the user wants, with a readable name.
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type {
  PluginEnvironmentProviderCreateResult,
  PluginEnvironmentProviderProgress,
} from "@get-bb/plugin-sdk/environment-provider";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { hostContract, hostSignals } from "../contract.js";
import { worktreeBaseBranchSchema, type WorktreeBaseBranch, type WorktreePlacement } from "./contract.js";
import { reportHostProgress } from "./vendor/progress.js";

export const LINEAR_WORKTREE_PROVIDER_ID = "linear-worktree";

const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const REMOVE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_SUFFIX = 20;

// Three modes, `null` (what a bare selection sends) meaning auto:
// - auto `{ branch }`: reuse the ticket's worktree or branch when one exists;
// - `{ kind: "new" }`: always a fresh worktree;
// - `{ kind: "existing", path }`: adopt a worktree picked in the composer.
const baseBranchInput = worktreeBaseBranchSchema.default({ kind: "default" });
export const linearWorktreeInputsSchema = z.preprocess(
  (value) => value ?? undefined,
  z
    .union([
      z.object({ kind: z.literal("existing"), path: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("new"), branch: baseBranchInput }).strict(),
      z.object({ branch: baseBranchInput }).strict(),
    ])
    .default({ branch: { kind: "default" } }),
);
type LinearWorktreeInputs = z.infer<typeof linearWorktreeInputsSchema>;

const ADOPTED_RESOURCE = { adopted: true } as const;

function isAdoptedResource(resource: unknown): boolean {
  return typeof resource === "object" && resource !== null && (resource as { adopted?: unknown }).adopted === true;
}

function baseBranchOf(inputs: LinearWorktreeInputs): WorktreeBaseBranch {
  return "branch" in inputs ? inputs.branch : { kind: "default" };
}

/** Another attempt is already putting this branch in a worktree. */
class BranchBusyError extends Error {}

type Reservation = {
  branch: string;
  sourcePath: string;
  placement: WorktreePlacement;
};

export interface LinearWorktreeDeps {
  host: ExperimentalHostClient<typeof hostContract, typeof hostSignals>;
  db: Database.Database;
  /** The user's worktrees folder, or "" for BB's own location. */
  worktreesRoot(): Promise<string>;
  /** Linear branch for the ticket this thread belongs to, or null. */
  linearBranchFor(thread: { id: string; title: string | null; titleFallback: string | null }): Promise<string | null>;
}

/** The branch made filesystem-safe, like Orca: `yoann/gig-12-fix` → `yoann-gig-12-fix`. */
export function dirNameForBranch(branch: string): string {
  return (
    branch
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 120)
      .replace(/[._-]+$/g, "") || "worktree"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LinearWorktreeApi {
  /** Worktrees the composer may offer for adoption on one machine. */
  listExisting(args: { sourcePath: string; hostId: string }): Promise<{
    worktrees: { path: string; branch: string | null; locked: boolean; prunable: boolean }[];
  }>;
}

export function registerLinearWorktree(bb: BbPluginApi, deps: LinearWorktreeDeps): LinearWorktreeApi {
  const api = {} as LinearWorktreeApi;
  const { host, db } = deps;
  const reports = new Map<string, PluginEnvironmentProviderProgress>();
  host.experimental_onSignal("progress", (event) => {
    const report = reports.get(event.payload.operationId);
    if (report !== undefined) reportHostProgress(report, event.payload);
  });

  // One row per attempt (pathKey). `create` must be idempotent for a pathKey,
  // so the name picked on the first call is reused on every retry, and a
  // name another attempt reserved is never handed out twice.
  const selectReservation = db.prepare(
    `SELECT branch, source_path AS sourcePath, placement FROM worktree_reservations WHERE path_key = ?`,
  );
  const branchReserved = db.prepare(
    `SELECT 1 FROM worktree_reservations WHERE source_path = ? AND branch = ? AND path_key != ?`,
  );
  const dirReserved = db.prepare(
    `SELECT 1 FROM worktree_reservations WHERE source_path = ? AND placement = ? AND path_key != ?`,
  );
  const insertReservation = db.prepare(
    `INSERT INTO worktree_reservations (path_key, thread_id, branch, source_path, placement, created_at, target_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOwnTargets = db.prepare(
    `SELECT target_path AS targetPath FROM worktree_reservations WHERE source_path = ? AND target_path IS NOT NULL`,
  );
  /** Folders this plugin created in a repo; BB deletes them on retirement. */
  function ownTargets(sourcePath: string): string[] {
    return (selectOwnTargets.all(sourcePath) as { targetPath: string }[]).map((row) => row.targetPath);
  }
  const deleteReservation = db.prepare(`DELETE FROM worktree_reservations WHERE path_key = ?`);

  function readReservation(pathKey: string): Reservation | null {
    const row = selectReservation.get(pathKey) as
      | { branch: string; sourcePath: string; placement: string | null }
      | undefined;
    if (row === undefined) return null;
    return { branch: row.branch, sourcePath: row.sourcePath, placement: row.placement ? JSON.parse(row.placement) : null };
  }

  // Reservations for one repo must not interleave, or two threads started
  // together could both see `gig-12` as free.
  let reservationQueue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = reservationQueue.then(task, task);
    reservationQueue = next.catch(() => undefined);
    return next;
  }

  async function reserve(args: {
    pathKey: string;
    threadId: string;
    hostId: string;
    sourcePath: string;
    candidates: string[];
    /** Restores must keep their branch; only the folder may get a suffix. */
    fixedBranch: boolean;
    signal: AbortSignal;
  }): Promise<Reservation> {
    const existing = readReservation(args.pathKey);
    if (existing !== null) return existing;
    return serialized(async () => {
      const root = (await deps.worktreesRoot()).trim();
      for (const base of args.candidates) {
        for (let n = 1; n <= MAX_SUFFIX; n += 1) {
          const suffix = n === 1 ? "" : `-${n}`;
          const branch = args.fixedBranch ? base : `${base}${suffix}`;
          if (args.fixedBranch && branchReserved.get(args.sourcePath, branch, args.pathKey)) {
            throw new BranchBusyError(`${branch} is being set up by another thread`);
          }
          const placement: WorktreePlacement =
            root === "" ? null : { worktreesRoot: root, dirName: `${dirNameForBranch(base)}${suffix}` };
          const placementJson = placement === null ? null : JSON.stringify(placement);
          if (!args.fixedBranch && branchReserved.get(args.sourcePath, branch, args.pathKey)) continue;
          if (placementJson !== null && dirReserved.get(args.sourcePath, placementJson, args.pathKey)) continue;
          const probe = await host.call(
            "inspectTarget",
            {
              sourcePath: args.sourcePath,
              pathKey: args.pathKey,
              branchName: branch,
              placement,
              excludePaths: ownTargets(args.sourcePath),
            },
            { hostId: args.hostId, signal: args.signal },
          );
          if (!probe.validBranchName) break;
          // A taken branch or folder belongs to someone else: BB's create
          // resets the branch and clears the folder, so never reuse either.
          // (BB's own layout is per-attempt, so its folder is always ours.)
          const folderTaken = placement !== null && probe.targetExists;
          const branchTaken = !args.fixedBranch && probe.branchExists;
          if (folderTaken || branchTaken) continue;
          insertReservation.run(
            args.pathKey,
            args.threadId,
            branch,
            args.sourcePath,
            placementJson,
            Date.now(),
            probe.targetPath,
          );
          return { branch, sourcePath: args.sourcePath, placement };
        }
      }
      throw new Error("Couldn't find a free branch name and folder for this worktree.");
    });
  }

  /** Attach an existing worktree without owning (or ever deleting) it. */
  async function adopt(
    context: {
      host: { id: string };
      projectCheckout: { path: string };
      signal: AbortSignal;
      experimental_claimPath(path: string): Promise<boolean>;
    },
    path: string,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const resolved = await host.call(
      "resolveExistingWorktree",
      { sourcePath: context.projectCheckout.path, path, excludePaths: ownTargets(context.projectCheckout.path) },
      { hostId: context.host.id, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
    );
    if (resolved.status === "failed") return { status: "failed", message: resolved.message };
    if (!(await context.experimental_claimPath(resolved.path))) {
      return { status: "failed", message: `${resolved.path} is already in use by another environment.` };
    }
    return { status: "created", path: resolved.path, ownsPath: false, resource: ADOPTED_RESOURCE };
  }

  async function listExisting(args: { sourcePath: string; hostId: string }) {
    return host.call(
      "listWorktrees",
      { sourcePath: args.sourcePath, excludePaths: ownTargets(args.sourcePath) },
      { hostId: args.hostId },
    );
  }
  api.listExisting = listExisting;

  async function createManagedWorktree(
    context: {
      attempt: number;
      pathKey: string;
      host: { id: string };
      report: PluginEnvironmentProviderProgress;
      signal: AbortSignal;
      experimental_claimPath(path: string): Promise<boolean>;
    },
    reservation: Reservation,
    branch: { baseBranch: WorktreeBaseBranch; branchMode: "reset" | "reuse-existing" },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    const operationId = `create#${context.pathKey}#${context.attempt}`;
    reports.set(operationId, context.report);
    try {
      if (reservation.placement !== null) {
        const { targetPath } = await host.call(
          "inspectTarget",
          {
            sourcePath: reservation.sourcePath,
            pathKey: context.pathKey,
            branchName: reservation.branch,
            placement: reservation.placement,
            excludePaths: [],
          },
          { hostId: context.host.id, signal: context.signal },
        );
        // Outside BB's own folder, make sure no other environment holds it.
        if (!(await context.experimental_claimPath(targetPath))) {
          return { status: "failed", message: `${targetPath} is already in use by another environment.` };
        }
      }
      const result = await host.call(
        "create",
        {
          operationId,
          sourcePath: reservation.sourcePath,
          pathKey: context.pathKey,
          branchName: reservation.branch,
          placement: reservation.placement,
          ...branch,
        },
        { hostId: context.host.id, signal: context.signal, timeoutMs: CREATE_TIMEOUT_MS },
      );
      if (result.status === "failed") return { status: "failed", message: result.message };
      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null ? {} : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "failed", message: errorMessage(error) };
    } finally {
      reports.delete(operationId);
    }
  }

  bb.experimental_environments.register({
    id: LINEAR_WORKTREE_PROVIDER_ID,
    displayName: "Linear worktree",
    description: "A git worktree on the ticket's Linear branch, in your worktrees folder.",
    icon: "linear-issues/linear",
    requires: { gitCheckout: true },
    inputs: linearWorktreeInputsSchema,
    policy: { pathKeys: "per-attempt" },
    experimental_existingPath: (inputs) => ("kind" in inputs && inputs.kind === "existing" ? inputs.path : null),
    async create(context) {
      const inputs = context.inputs;
      if ("kind" in inputs && inputs.kind === "existing") return adopt(context, inputs.path);
      try {
        const linear = await deps.linearBranchFor(context.thread).catch((error) => {
          context.report.log(`Couldn't read the Linear branch, using BB's name: ${errorMessage(error)}`);
          return null;
        });
        if (linear !== null) context.report.step(`Using Linear branch ${linear}`);

        // Auto mode picks up where earlier work on the ticket left off.
        if (linear !== null && !("kind" in inputs)) {
          const probe = await host.call(
            "inspectTarget",
            {
              sourcePath: context.projectCheckout.path,
              pathKey: context.pathKey,
              branchName: linear,
              placement: null,
              excludePaths: ownTargets(context.projectCheckout.path),
            },
            { hostId: context.host.id, signal: context.signal },
          );
          if (probe.branchWorktree?.adoptable) {
            const adopted = await adopt(context, probe.branchWorktree.path);
            if (adopted.status === "created") {
              context.report.step(`Reusing the existing worktree at ${probe.branchWorktree.path}`);
              return adopted;
            }
            context.report.log(`Couldn't reuse ${probe.branchWorktree.path}; creating a new worktree instead.`);
          } else if (probe.branchExists && probe.branchWorktree === null) {
            try {
              const reservation = await reserve({
                pathKey: context.pathKey,
                threadId: context.thread.id,
                hostId: context.host.id,
                sourcePath: context.projectCheckout.path,
                candidates: [linear],
                fixedBranch: true,
                signal: context.signal,
              });
              context.report.step(`Reusing the existing branch ${linear}`);
              return await createManagedWorktree(context, reservation, {
                baseBranch: baseBranchOf(inputs),
                branchMode: "reuse-existing",
              });
            } catch (error) {
              if (!(error instanceof BranchBusyError)) throw error;
              context.report.log(`${error.message}; creating a new branch instead.`);
            }
          }
        }

        const reservation = await reserve({
          pathKey: context.pathKey,
          threadId: context.thread.id,
          hostId: context.host.id,
          sourcePath: context.projectCheckout.path,
          candidates: linear === null ? [context.suggestedBranchName] : [linear, context.suggestedBranchName],
          fixedBranch: false,
          signal: context.signal,
        });
        return await createManagedWorktree(context, reservation, {
          baseBranch: baseBranchOf(inputs),
          branchMode: "reset",
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async restore(context) {
      const inputs = context.inputs;
      if ("kind" in inputs && inputs.kind === "existing") return adopt(context, inputs.path);
      if (isAdoptedResource(context.previous.resource) && context.previous.environment.path !== null) {
        return adopt(context, context.previous.environment.path);
      }
      const branchName = context.previous.environment.branchName;
      if (branchName === null) {
        return {
          status: "failed",
          message: "The removed worktree had no branch checked out, so there is no branch to restore it on.",
        };
      }
      try {
        const reservation = await reserve({
          pathKey: context.pathKey,
          threadId: context.thread.id,
          hostId: context.host.id,
          sourcePath: context.projectCheckout.path,
          candidates: [branchName],
          fixedBranch: true,
          signal: context.signal,
        });
        return await createManagedWorktree(context, reservation, {
          baseBranch: baseBranchOf(inputs),
          branchMode: "reuse-existing",
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async remove(context) {
      // Adopted worktrees aren't ours: detach without touching the folder.
      if (isAdoptedResource(context.resource)) return { status: "removed" };
      if (context.hostId === null) return { status: "failed", message: "The worktree machine is unknown" };
      const reservation = readReservation(context.pathKey);
      const operationId = `remove#${context.pathKey}#${context.attempt}`;
      reports.set(operationId, context.report);
      try {
        const result = await host.call(
          "remove",
          {
            operationId,
            pathKey: context.pathKey,
            path: context.path,
            fallback:
              reservation === null ? null : { sourcePath: reservation.sourcePath, placement: reservation.placement },
          },
          { hostId: context.hostId, signal: context.signal, timeoutMs: REMOVE_TIMEOUT_MS },
        );
        if (result.status === "removed") deleteReservation.run(context.pathKey);
        return result;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      } finally {
        reports.delete(operationId);
      }
    },
  });
  return api;
}
