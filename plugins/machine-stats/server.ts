// bb-plugin-machine-stats: CPU, RAM and disk usage of any connected machine,
// plus the staging slugs and Traefik services running on its docker engine.
//
// The server lists machines through bb.sdk and forwards to the plugin's host
// entry (host.ts, running in the target machine's daemon), which reads the
// numbers and runs the docker CLI locally.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cleanupStatusSchema,
  destroyResultSchema,
  hostContract,
  listingSchema,
  slugSchema,
  repoSchema,
  snapshotSchema,
  type CleanupStatus,
  type MachineSnapshot,
  type Stack,
  type StackListing,
} from "./contract.js";

export type { CleanupStatus, MachineSnapshot, Stack, StackListing };

// A null hostId reads the server machine.
const hostIdSchema = z.string().min(1).max(200).nullable();

export const rpcContract = defineRpcContract({
  machine_snapshot: {
    input: z.object({ hostId: hostIdSchema }),
    output: snapshotSchema,
  },
  list_stacks: {
    input: z.object({ hostId: hostIdSchema }),
    output: listingSchema,
  },
  destroy_stack: {
    input: z.object({ hostId: hostIdSchema, slug: slugSchema }),
    output: destroyResultSchema,
  },
  cleanup_status: {
    input: z.object({
      hostId: hostIdSchema,
      slugs: z.array(slugSchema).max(50),
      // Skip the cache, for an explicit refresh.
      fresh: z.boolean().optional(),
    }),
    output: z.array(cleanupStatusSchema),
  },
});

const SNAPSHOT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 20_000;
// Two sequential `compose down`s, each capped at three minutes on the host.
const DESTROY_TIMEOUT_MS = 400_000;
const CLEANUP_TIMEOUT_MS = 90_000;
// Tickets and PRs move slowly, and each lookup costs a few API calls.
const CLEANUP_CACHE_MS = 5 * 60_000;

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseRepos(value: string): string[] {
  return value
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean);
}

const percent = (used: number, total: number) =>
  total > 0 ? `${((used / total) * 100).toFixed(0)}%` : "n/a";

function stackLine(stack: Stack, cleanup?: CleanupStatus): string {
  const running = stack.containers.filter((c) => c.state === "running").length;
  const hosts = stack.hosts.length > 0 ? stack.hosts.join(" ") : "no traefik host";
  const line = `${stack.id}  ${running}/${stack.containers.length} running  ${hosts}`;
  if (cleanup === undefined || cleanup.verdict === "unknown") return line;
  const verdict = cleanup.verdict === "ready" ? "READY TO DESTROY" : cleanup.verdict;
  const worktree = cleanup.worktreeMissing ? " Worktree is gone." : "";
  return `${line}\n    ${verdict}: ${cleanup.reason}${worktree}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubRepos: {
      type: "string",
      label: "GitHub repositories",
      description:
        "Comma-separated owner/name repositories searched for a slug's pull requests when checking whether it can be destroyed.",
      default: "gigapay/gigapay, gigapay/gigapay-app",
      experimental_schema: z
        .string()
        .max(1000)
        .refine(
          (value) => parseRepos(value).every((repo) => repoSchema.safeParse(repo).success),
          "Use owner/name, separated by commas",
        ),
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const cleanupCache = new Map<string, { status: CleanupStatus; at: number }>();

  async function listMachines() {
    const [hosts, config] = await Promise.all([
      bb.sdk.hosts.list(),
      bb.sdk.system.config(),
    ]);
    const primaryHostId = config.primaryHostId;
    const machines = hosts
      .filter((h) => h.status === "connected" && h.lifecycle.phase === "active")
      .map((h) => ({ id: h.id, name: h.name, isServer: h.id === primaryHostId }))
      .sort((a, b) => Number(b.isServer) - Number(a.isServer) || a.name.localeCompare(b.name));
    const defaultHostId =
      machines.find((m) => m.isServer)?.id ?? machines[0]?.id ?? null;
    return { machines, defaultHostId };
  }

  async function resolveHostId(requested: string | null): Promise<string> {
    const hostId =
      requested ??
      (await bb.sdk.system.config()).primaryHostId ??
      (await listMachines()).defaultHostId;
    if (hostId === null) throw new Error("No connected machine to inspect.");
    return hostId;
  }

  async function snapshot(hostId: string | null): Promise<MachineSnapshot> {
    return host.call(
      "snapshot",
      {},
      { hostId: await resolveHostId(hostId), signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) },
    );
  }

  async function listStacks(hostId: string | null): Promise<StackListing> {
    return host.call(
      "list_stacks",
      {},
      { hostId: await resolveHostId(hostId), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
    );
  }

  async function destroyStack(hostId: string | null, slug: string) {
    const target = await resolveHostId(hostId);
    bb.log.info(`destroying staging stack ${slug} on ${target}`);
    return host.call(
      "destroy_stack",
      { slug },
      { hostId: target, signal: AbortSignal.timeout(DESTROY_TIMEOUT_MS) },
    );
  }

  async function cleanupStatus(
    hostId: string | null,
    slugs: string[],
    fresh = false,
  ): Promise<CleanupStatus[]> {
    const target = await resolveHostId(hostId);
    const key = (slug: string) => `${target}:${slug}`;
    const now = Date.now();
    const stale = slugs.filter((slug) => {
      const hit = cleanupCache.get(key(slug));
      return fresh || hit === undefined || now - hit.at > CLEANUP_CACHE_MS;
    });
    if (stale.length > 0) {
      const { githubRepos } = await settings.get();
      const fetched = await host.call(
        "cleanup_status",
        { slugs: stale, repos: parseRepos(String(githubRepos ?? "")) },
        { hostId: target, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
      );
      for (const status of fetched) cleanupCache.set(key(status.slug), { status, at: now });
    }
    return slugs.flatMap((slug) => {
      const hit = cleanupCache.get(key(slug));
      return hit === undefined ? [] : [hit.status];
    });
  }

  bb.rpc.register(rpcContract, {
    machine_snapshot: ({ hostId }) => snapshot(hostId),
    list_stacks: ({ hostId }) => listStacks(hostId),
    destroy_stack: ({ hostId, slug }) => destroyStack(hostId, slug),
    cleanup_status: ({ hostId, slugs, fresh }) => cleanupStatus(hostId, slugs, fresh),
  });

  const usage = [
    "Usage:",
    "  bb machine-stats machines [--json]",
    "  bb machine-stats show [<host-id>] [--json]",
    "  bb machine-stats stacks [--cleanup] [--host <host-id>] [--json]",
    "  bb machine-stats destroy <slug> --yes [--host <host-id>] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "machine-stats",
    summary: "Show CPU, RAM, disk usage and staging slugs of connected machines",
    commands: [
      {
        name: "machines",
        summary: "List connected machines",
        usage: "bb machine-stats machines [--json]",
      },
      {
        name: "show",
        summary: "Show usage of one machine (defaults to the server machine)",
        usage: "bb machine-stats show [<host-id>] [--json]",
      },
      {
        name: "stacks",
        summary:
          "List staging slugs and Traefik-exposed services (defaults to the server machine); --cleanup flags slugs whose Linear ticket is done and PRs merged",
        usage: "bb machine-stats stacks [--cleanup] [--host <host-id>] [--json]",
      },
      {
        name: "destroy",
        summary: "Stop and remove a staging slug's containers, networks and volumes",
        usage: "bb machine-stats destroy <slug> --yes [--host <host-id>] [--json]",
      },
    ],
    async run(argv) {
      const args = [...argv];
      const take = (flag: string) => {
        const index = args.indexOf(flag);
        if (index === -1) return false;
        args.splice(index, 1);
        return true;
      };
      const json = take("--json");
      const yes = take("--yes");
      const withCleanup = take("--cleanup");
      let hostId: string | null = null;
      const hostIndex = args.indexOf("--host");
      if (hostIndex !== -1) {
        hostId = args[hostIndex + 1] ?? null;
        if (hostId === null) return { exitCode: 1, stderr: usage };
        args.splice(hostIndex, 2);
      }
      const [command, ...rest] = args;
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "machines": {
          const { machines } = await listMachines();
          const text =
            machines.length === 0
              ? "No connected machines."
              : machines
                  .map((m) => `${m.id}  ${m.name}${m.isServer ? "  (server)" : ""}`)
                  .join("\n");
          return { exitCode: 0, stdout: json ? JSON.stringify(machines) : text };
        }
        case "show": {
          if (rest.length > 1) break;
          const s = await snapshot(rest[0] ?? hostId);
          if (json) return { exitCode: 0, stdout: JSON.stringify(s) };
          const lines = [
            `${s.hostname}  ${s.platform}`,
            `CPU   ${s.cpu.usagePercent.toFixed(0)}%  ${s.cpu.cores} cores  load ${s.cpu.loadAverage.map((l) => l.toFixed(2)).join(" ")}`,
            `RAM   ${percent(s.memory.usedBytes, s.memory.totalBytes)}  ${formatBytes(s.memory.usedBytes)} / ${formatBytes(s.memory.totalBytes)}`,
            ...s.disks.map(
              (d) =>
                `Disk  ${percent(d.usedBytes, d.usedBytes + d.availableBytes)}  ${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)}  ${d.mount}`,
            ),
          ];
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "stacks": {
          if (rest.length > 0) break;
          const listing = await listStacks(hostId);
          if (listing.dockerError !== null) {
            if (json) return { exitCode: 0, stdout: JSON.stringify(listing) };
            return { exitCode: 1, stderr: `docker unavailable on ${listing.hostname}: ${listing.dockerError}` };
          }
          const staging = listing.stacks.filter((s) => s.kind === "staging");
          const cleanup = withCleanup
            ? await cleanupStatus(hostId, staging.map((s) => s.id), true)
            : [];
          if (json) {
            const stdout = withCleanup ? JSON.stringify({ ...listing, cleanup }) : JSON.stringify(listing);
            return { exitCode: 0, stdout };
          }
          const services = listing.stacks.filter((s) => s.kind === "service");
          const lines = [
            `${listing.hostname}`,
            "",
            "Staging slugs:",
            ...(staging.length === 0 ? ["  none"] : staging.map((s) => `  ${stackLine(s, cleanup.find((c) => c.slug === s.id))}`)),
            "",
            "Other Traefik services:",
            ...(services.length === 0 ? ["  none"] : services.map((s) => `  ${stackLine(s)}`)),
          ];
          return { exitCode: 0, stdout: lines.join("\n") };
        }
        case "destroy": {
          const [slug] = rest;
          if (slug === undefined || rest.length > 1) break;
          if (!slugSchema.safeParse(slug).success) {
            return { exitCode: 1, stderr: `Invalid slug: ${slug}` };
          }
          if (!yes) {
            return {
              exitCode: 1,
              stderr: `This removes every container, network and volume of staging-${slug}. Re-run with --yes to confirm.`,
            };
          }
          const result = await destroyStack(hostId, slug);
          if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
          return {
            exitCode: 0,
            stdout: `${result.output}\n\nDestroyed ${result.slug} (${result.projects.join(", ")}).`,
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
