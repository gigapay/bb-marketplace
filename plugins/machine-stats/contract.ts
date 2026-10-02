// Shared by server.ts (caller) and host.ts (runs on each machine's daemon).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const diskSchema = z.object({
  mount: z.string(),
  filesystem: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  availableBytes: z.number(),
});

export const snapshotSchema = z.object({
  hostname: z.string(),
  platform: z.string(),
  uptimeSeconds: z.number(),
  sampledAt: z.number(),
  cpu: z.object({
    model: z.string(),
    cores: z.number(),
    usagePercent: z.number(),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  }),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number(),
  }),
  disks: z.array(diskSchema),
});

export type MachineSnapshot = z.infer<typeof snapshotSchema>;
export type DiskUsage = z.infer<typeof diskSchema>;

// Same shape create-worktree.sh produces: lowercase ticket slugs like gig-5697.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const slugSchema = z.string().regex(SLUG_PATTERN);

export const containerSchema = z.object({
  name: z.string(),
  service: z.string(),
  state: z.string(),
  health: z.string().nullable(),
});

export const stackSchema = z.object({
  // The staging slug (gig-5697), or the compose project for other services.
  id: z.string(),
  kind: z.enum(["staging", "service"]),
  // Compose projects that make up the stack: staging-<slug> and staging-<slug>-app.
  projects: z.array(z.string()),
  hosts: z.array(z.string()),
  containers: z.array(containerSchema),
  workingDir: z.string().nullable(),
  createdAt: z.number().nullable(),
});

export const listingSchema = z.object({
  hostname: z.string(),
  sampledAt: z.number(),
  // Null when docker answers; otherwise why it didn't (not installed, no socket...).
  dockerError: z.string().nullable(),
  stacks: z.array(stackSchema),
});

export const destroyResultSchema = z.object({
  slug: z.string(),
  projects: z.array(z.string()),
  output: z.string(),
});

export const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  url: z.string(),
});

// Whether a slug's Linear ticket and pull requests are finished, so the stack
// is safe to destroy.
export const cleanupStatusSchema = z.object({
  slug: z.string(),
  verdict: z.enum(["ready", "active", "unknown"]),
  reason: z.string(),
  issue: z
    .object({
      identifier: z.string(),
      state: z.string(),
      stateType: z.string(),
      url: z.string(),
    })
    .nullable(),
  pullRequests: z.array(pullRequestSchema),
  worktreeMissing: z.boolean(),
});

// owner/name, as gh expects it.
export const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

export type Stack = z.infer<typeof stackSchema>;
export type StackListing = z.infer<typeof listingSchema>;
export type DestroyResult = z.infer<typeof destroyResultSchema>;
export type CleanupStatus = z.infer<typeof cleanupStatusSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const hostContract = defineRpcContract({
  snapshot: {
    input: z.object({}).strict(),
    output: snapshotSchema,
  },
  list_stacks: {
    input: z.object({}).strict(),
    output: listingSchema,
  },
  destroy_stack: {
    input: z.object({ slug: slugSchema }).strict(),
    output: destroyResultSchema,
  },
  cleanup_status: {
    input: z
      .object({
        slugs: z.array(slugSchema).max(50),
        repos: z.array(repoSchema).max(10),
      })
      .strict(),
    output: z.array(cleanupStatusSchema),
  },
});
