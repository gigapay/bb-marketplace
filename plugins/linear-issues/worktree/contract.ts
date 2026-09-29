import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "./vendor/progress.js";

export const worktreeBaseBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);
export type WorktreeBaseBranch = z.infer<typeof worktreeBaseBranchSchema>;

export const discoveredWorktreeSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().nullable(),
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .strict();
export type DiscoveredWorktree = z.infer<typeof discoveredWorktreeSchema>;

// linear-issues: where a worktree goes when the user set a worktrees folder.
// Null keeps BB's layout under the daemon data dir.
export const worktreePlacementSchema = z
  .object({
    worktreesRoot: z.string().min(1).max(1024),
    dirName: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/),
  })
  .strict()
  .nullable();
export type WorktreePlacement = z.infer<typeof worktreePlacementSchema>;

// linear-issues: worktrees this plugin created. BB deletes those when their
// environment retires, so they must never be adopted by another one.
const excludePathsSchema = z.array(z.string().min(1)).max(2000);

export const worktreeHostContract = defineRpcContract({
  // linear-issues: pre-flight for picking a branch/folder nobody uses yet.
  inspectTarget: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branchName: z.string().min(1),
        placement: worktreePlacementSchema,
        excludePaths: excludePathsSchema,
      })
      .strict(),
    output: z
      .object({
        targetPath: z.string().min(1),
        targetExists: z.boolean(),
        branchExists: z.boolean(),
        validBranchName: z.boolean(),
        // Where the branch is checked out, and whether we may adopt it there.
        branchWorktree: z.object({ path: z.string(), adoptable: z.boolean() }).strict().nullable(),
      })
      .strict(),
  },
  defaultBaseBranch: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listWorktrees: {
    // linear-issues: + excludePaths, the worktrees this plugin created (never offered).
    input: z.object({ sourcePath: z.string().min(1), excludePaths: excludePathsSchema }).strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
  resolveExistingWorktree: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        path: z.string().min(1),
        excludePaths: excludePathsSchema,
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("resolved"),
          path: z.string().min(1),
          branch: z.string().nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  create: {
    input: z
      .object({
        operationId: z.string().min(1),
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branchName: z.string().min(1),
        baseBranch: worktreeBaseBranchSchema,
        branchMode: z.enum(["reset", "reuse-existing"]),
        placement: worktreePlacementSchema,
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  remove: {
    input: z
      .object({
        operationId: z.string().min(1),
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
        // linear-issues: lets a path-less cleanup find a custom-placed target.
        fallback: z
          .object({ sourcePath: z.string().min(1), placement: worktreePlacementSchema })
          .strict()
          .nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
});

export const worktreeHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
