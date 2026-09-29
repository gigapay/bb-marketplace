import { execFile } from "node:child_process";
import { access, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.js";
import type { WorktreePlacement } from "./worktree/contract.js";
import { resolveDefaultWorktreeBaseBranch, resolveWorktreeBaseBranch } from "./worktree/host/base-branch.js";
import {
  resolveCustomRepoRoot,
  resolveCustomTargetPath,
  resolveWorktreeAttemptRoot,
  resolveWorktreeChildPath,
  resolveWorktreesRoot,
  resolveWorktreeTargetPath,
} from "./worktree/host/paths.js";
import {
  createWorktree,
  listGitWorktrees,
  removeWorktree,
  resolveAdoptableWorktree,
} from "./worktree/host/worktree.js";
import { selectAdoptableWorktrees } from "./worktree/host/worktree-list.js";
import { readDefaultBranchRefs } from "./worktree/vendor/git.js";
import { createHostProgress } from "./worktree/vendor/progress.js";

const run = promisify(execFile);

async function git(path: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await run("git", ["-C", path, ...args], { signal, timeout: 15_000 });
  return stdout.trim();
}

async function succeeds(path: string, args: string[], signal: AbortSignal): Promise<boolean> {
  try {
    await git(path, args, signal);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function completionPathForWorktree(worktreePath: string): string {
  return `${worktreePath}.completed`;
}

/** Where an attempt's worktree lives, and the root its cleanup may touch. */
function resolveTarget(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
  placement: WorktreePlacement;
}): { targetPath: string; ownRoot: string } {
  if (args.placement === null) {
    return {
      targetPath: resolveWorktreeTargetPath(args),
      ownRoot: resolveWorktreesRoot(args.dataDir),
    };
  }
  return {
    targetPath: resolveCustomTargetPath({ ...args.placement, sourcePath: args.sourcePath }),
    ownRoot: resolveCustomRepoRoot({ worktreesRoot: args.placement.worktreesRoot, sourcePath: args.sourcePath }),
  };
}

/**
 * Worktrees BB or this plugin created (and may delete on retirement): never
 * adoptable, or an adopted environment could lose its folder.
 */
function managedRoots(dataDir: string, sourcePath: string, worktreesRoot: string | null): string[] {
  const roots = [resolveWorktreesRoot(dataDir)];
  if (worktreesRoot !== null) roots.push(resolveCustomRepoRoot({ worktreesRoot, sourcePath }));
  return roots;
}

async function adoptableWorktrees(args: { sourcePath: string; roots: string[]; signal?: AbortSignal }) {
  let entries = await listGitWorktrees(args);
  for (const managedRoot of args.roots) entries = selectAdoptableWorktrees({ entries, managedRoot });
  return entries.filter((entry) => !entry.prunable);
}

async function worktreePathsForPathKey(args: { dataDir: string; pathKey: string }): Promise<string[]> {
  const root = resolveWorktreeAttemptRoot(args);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolveWorktreeChildPath({ ...args, childName: entry.name }));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

// Worktree handlers follow BB's bundled Worktree provider (see
// worktree/ORIGIN.md); renameBranch serves threads on BB's own provider.
export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async defaultBaseBranch(input) {
      const refs = await readDefaultBranchRefs(input.sourcePath);
      return {
        branch: resolveDefaultWorktreeBaseBranch({
          defaultBranch: refs.defaultBranch ?? null,
          originDefaultBranch: refs.originDefaultBranch ?? null,
          defaultBranchRelation: refs.defaultBranchRelation ?? null,
        }),
      };
    },
    async listWorktrees(input, context) {
      const worktrees = await adoptableWorktrees({
        sourcePath: input.sourcePath,
        roots: managedRoots(context.experimental_paths.dataDir, input.sourcePath, input.worktreesRoot),
      });
      return {
        worktrees: worktrees.map((entry) => ({
          path: entry.path,
          branch: entry.branch,
          locked: entry.locked,
          prunable: entry.prunable,
        })),
      };
    },
    async resolveExistingWorktree(input, context) {
      const roots = managedRoots(context.experimental_paths.dataDir, input.sourcePath, input.worktreesRoot);
      const resolved = await resolveAdoptableWorktree({
        sourcePath: input.sourcePath,
        path: input.path,
        managedRoot: roots[0]!,
      });
      if (resolved.status === "failed") return resolved;
      const adoptable = await adoptableWorktrees({ sourcePath: input.sourcePath, roots });
      if (!adoptable.some((entry) => entry.path === resolved.path)) {
        return { status: "failed" as const, message: `${input.path} is managed by BB and can't be adopted.` };
      }
      return resolved;
    },

    async inspectTarget(input, context) {
      const { targetPath } = resolveTarget({ dataDir: context.experimental_paths.dataDir, ...input });
      const [targetExists, branchExists, validBranchName] = await Promise.all([
        exists(targetPath),
        succeeds(input.sourcePath, ["show-ref", "--verify", "--quiet", `refs/heads/${input.branchName}`], context.signal),
        succeeds(input.sourcePath, ["check-ref-format", "--branch", input.branchName], context.signal),
      ]);
      const holder = (await listGitWorktrees({ sourcePath: input.sourcePath, signal: context.signal })).find(
        (entry) => entry.branch === input.branchName && !entry.isMain,
      );
      let branchWorktree: { path: string; adoptable: boolean } | null = null;
      if (holder !== undefined) {
        const roots = managedRoots(context.experimental_paths.dataDir, input.sourcePath, input.placement?.worktreesRoot ?? null);
        const adoptable = await adoptableWorktrees({ sourcePath: input.sourcePath, roots, signal: context.signal });
        branchWorktree = { path: holder.path, adoptable: adoptable.some((entry) => entry.path === holder.path) };
      }
      return { targetPath, targetExists, branchExists, validBranchName, branchWorktree };
    },

    async create(input, context) {
      const { targetPath, ownRoot } = resolveTarget({
        dataDir: context.experimental_paths.dataDir,
        pathKey: input.pathKey,
        sourcePath: input.sourcePath,
        placement: input.placement,
      });
      try {
        const baseBranch = await resolveWorktreeBaseBranch(input.sourcePath, input.baseBranch);
        const created = await createWorktree({
          sourcePath: input.sourcePath,
          targetPath,
          completionPath: completionPathForWorktree(targetPath),
          ownWorktreesRoot: ownRoot,
          branchName: input.branchName,
          baseBranch,
          branchMode: input.branchMode,
          onProgress: createHostProgress({
            operationId: input.operationId,
            emit: (payload) => context.experimental_emitSignal("progress", payload),
          }),
          signal: context.signal,
        });
        return { status: "created", path: created.path, baseBranch } as const;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: error instanceof Error ? error.message : String(error) } as const;
      }
    },

    async remove(input, context) {
      try {
        let paths: string[];
        if (input.path !== null) {
          paths = [input.path];
        } else if (input.fallback !== null && input.fallback.placement !== null) {
          paths = [
            resolveTarget({
              dataDir: context.experimental_paths.dataDir,
              pathKey: input.pathKey,
              ...input.fallback,
            }).targetPath,
          ];
        } else {
          paths = await worktreePathsForPathKey({ dataDir: context.experimental_paths.dataDir, pathKey: input.pathKey });
        }
        for (const path of paths) {
          await rm(completionPathForWorktree(path), { force: true });
          await removeWorktree({
            path,
            onProgress: createHostProgress({
              operationId: input.operationId,
              emit: (payload) => context.experimental_emitSignal("progress", payload),
            }),
            signal: context.signal,
          });
        }
        return { status: "removed" } as const;
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: error instanceof Error ? error.message : String(error) } as const;
      }
    },

    renameBranch: async ({ path, from, to }, context) => {
      const signal = context.signal;
      const current = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
      // Only touch the branch BB just created; anything else means someone
      // (or the agent) already switched, and we leave it alone.
      if (current !== from) return { status: "skipped" as const, reason: `HEAD is on ${current}, not ${from}` };
      // A pushed branch may back a PR; renaming it locally would split it
      // from its remote, so only never-pushed branches are renamed.
      const upstream = await git(path, ["rev-parse", "--abbrev-ref", `${from}@{upstream}`], signal).catch(() => "");
      if (upstream !== "") return { status: "skipped" as const, reason: `${from} already tracks ${upstream}` };
      if (!(await succeeds(path, ["check-ref-format", "--branch", to], signal))) {
        return { status: "skipped" as const, reason: `${to} is not a valid branch name` };
      }
      // A second thread on the same ticket gets `<branch>-2`, `-3`, …
      let target = to;
      for (let suffix = 2; await succeeds(path, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`], signal); suffix += 1) {
        if (suffix > 20) return { status: "skipped" as const, reason: `${to} and its suffixes are taken` };
        target = `${to}-${suffix}`;
      }
      await git(path, ["branch", "-m", from, target], signal);
      return { status: "renamed" as const, branch: target };
    },
  },
});
