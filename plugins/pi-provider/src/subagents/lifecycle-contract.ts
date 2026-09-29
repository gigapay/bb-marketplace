import { z } from "zod";

/**
 * pi-toolbox's host lifecycle contract (`@yteruel31/pi-subagents`,
 * HOST-INTEGRATION.md). These are `pi.events` channels inside the pi process;
 * the bb extension forwards them over the FD 3 bridge channel.
 */
export const SUBAGENTS_LIFECYCLE_CHANNEL = "pi-toolbox:subagents:lifecycle";
export const SUBAGENTS_LIFECYCLE_REQUEST_CHANNEL =
  "pi-toolbox:subagents:lifecycle:request";

/** Provider-private FD 3 envelope kind; not part of any bb protocol. */
export const SUBAGENTS_LIFECYCLE_CHANNEL_KIND = "subagents-lifecycle";

export const LIFECYCLE_LIMITS = {
  idLength: 128,
  sessionIdLength: 256,
  sourceIdLength: 256,
  toolCallIdLength: 1024,
  labelLength: 200,
  harnessLength: 32,
  agentLength: 100,
  modelLength: 200,
  thinkingLength: 32,
  snapshotRuns: 256,
} as const;

const boundedId = (max: number) => z.string().min(1).max(max);
const timestamp = z.number().finite().nonnegative();

export const subagentLifecycleStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type SubagentLifecycleStatus = z.infer<
  typeof subagentLifecycleStatusSchema
>;

// Strict: only the allowlisted display fields cross the bridge.
export const subagentLifecycleRunSchema = z
  .object({
    id: boundedId(LIFECYCLE_LIMITS.idLength),
    label: z.string().max(LIFECYCLE_LIMITS.labelLength),
    toolCallId: boundedId(LIFECYCLE_LIMITS.toolCallIdLength).optional(),
    harness: z
      .string()
      .max(LIFECYCLE_LIMITS.harnessLength)
      .regex(/^[a-z0-9_-]+$/),
    status: subagentLifecycleStatusSchema,
    createdAt: timestamp,
    settledAt: timestamp.optional(),
    /** Agent-file profile name; absent for ad-hoc runs. */
    agent: z.string().min(1).max(LIFECYCLE_LIMITS.agentLength).optional(),
    model: z.string().min(1).max(LIFECYCLE_LIMITS.modelLength).optional(),
    thinking: z
      .string()
      .max(LIFECYCLE_LIMITS.thinkingLength)
      .regex(/^[a-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export type SubagentLifecycleRun = z.infer<typeof subagentLifecycleRunSchema>;

const envelope = {
  v: z.literal(1),
  sessionId: boundedId(LIFECYCLE_LIMITS.sessionIdLength),
  sourceId: boundedId(LIFECYCLE_LIMITS.sourceIdLength),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};

export const subagentsLifecycleEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...envelope,
      kind: z.literal("snapshot"),
      runs: z
        .array(subagentLifecycleRunSchema)
        .max(LIFECYCLE_LIMITS.snapshotRuns),
    })
    .strict(),
  z
    .object({
      ...envelope,
      kind: z.literal("upsert"),
      run: subagentLifecycleRunSchema,
    })
    .strict(),
  z.object({ ...envelope, kind: z.literal("clear") }).strict(),
]);

export type SubagentsLifecycleEvent = z.infer<
  typeof subagentsLifecycleEventSchema
>;

/** Validates one FD 3 `subagents-lifecycle` envelope; anything else is null. */
export function parseSubagentsLifecycleChannelMessage(
  message: Record<string, unknown>,
): SubagentsLifecycleEvent | null {
  if (message.kind !== SUBAGENTS_LIFECYCLE_CHANNEL_KIND) {
    return null;
  }
  const parsed = subagentsLifecycleEventSchema.safeParse(message.event);
  return parsed.success ? parsed.data : null;
}

export function isTerminalLifecycleStatus(
  status: SubagentLifecycleStatus,
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}
