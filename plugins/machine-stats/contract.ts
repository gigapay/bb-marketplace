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

export const hostContract = defineRpcContract({
  snapshot: {
    input: z.object({}).strict(),
    output: snapshotSchema,
  },
});
