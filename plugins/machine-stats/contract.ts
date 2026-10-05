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

export const processSchema = z.object({
  pid: z.number(),
  name: z.string(),
  command: z.string(),
  // Percent of one core, like top: a busy multithreaded process can pass 100.
  cpuPercent: z.number(),
  memoryBytes: z.number(),
  // "gig-6565 · django" when the process runs in a docker container.
  container: z.string().nullable(),
});

export const processListingSchema = z.object({
  hostname: z.string(),
  sampledAt: z.number(),
  cores: z.number(),
  totalMemoryBytes: z.number(),
  processCount: z.number(),
  processes: z.array(processSchema),
});

// Absolute paths only; du and readdir get them as plain argv, never a shell.
export const diskPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), "Use an absolute path");

export const dirListingSchema = z.object({
  path: z.string(),
  // Subfolders on the same filesystem, the ones worth measuring.
  dirs: z.array(z.string()),
  // Subfolders that are other mounts (/proc, docker overlays...), not measured.
  mounts: z.array(z.string()),
  // Plain files directly in this folder, summed.
  filesBytes: z.number(),
  unreadable: z.boolean(),
});

export const duLevelSchema = z.object({
  path: z.string(),
  totalBytes: z.number(),
  // Direct subfolders and their sizes, from the same du run.
  children: z.array(z.object({ name: z.string(), bytes: z.number() })),
  // du hit folders it couldn't read, so sizes are a floor.
  partial: z.boolean(),
});

export const diskEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["dir", "files", "mount"]),
  // Null while it's still being measured.
  bytes: z.number().nullable(),
});

export const diskLevelSchema = z.object({
  path: z.string(),
  // Where the Disk tab opens: / on Linux, the home folder on macOS.
  rootPath: z.string(),
  entries: z.array(diskEntrySchema),
  scanning: z.boolean(),
  scannedAt: z.number().nullable(),
  partial: z.boolean(),
  error: z.string().nullable(),
});

export type DirListing = z.infer<typeof dirListingSchema>;
export type DuLevel = z.infer<typeof duLevelSchema>;
export type DiskLevel = z.infer<typeof diskLevelSchema>;
export type DiskEntry = z.infer<typeof diskEntrySchema>;

export const historyPointSchema = z.object({
  at: z.number(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
});

export type MachineSnapshot = z.infer<typeof snapshotSchema>;
export type HistoryPoint = z.infer<typeof historyPointSchema>;
export type ProcessInfo = z.infer<typeof processSchema>;
export type ProcessListing = z.infer<typeof processListingSchema>;
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
  processes: {
    input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
    output: processListingSchema,
  },
  list_stacks: {
    input: z.object({}).strict(),
    output: listingSchema,
  },
  destroy_stack: {
    input: z.object({ slug: slugSchema }).strict(),
    output: destroyResultSchema,
  },
  disk_root: {
    input: z.object({}).strict(),
    output: z.object({ path: z.string() }),
  },
  disk_list: {
    input: z.object({ path: diskPathSchema }).strict(),
    output: dirListingSchema,
  },
  disk_du: {
    input: z.object({ path: diskPathSchema }).strict(),
    output: duLevelSchema,
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
