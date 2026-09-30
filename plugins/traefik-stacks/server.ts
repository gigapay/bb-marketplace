// bb-plugin-traefik-stacks: the staging slugs and Traefik-exposed services
// running on a machine's docker engine, with a way to destroy slug stacks.
//
// The server resolves the target machine and forwards to the plugin's host
// entry (host.ts), which runs the docker CLI on that machine.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  destroyResultSchema,
  hostContract,
  listingSchema,
  slugSchema,
  type Stack,
  type StackListing,
} from "./contract.js";

export type { Stack, StackListing };

const hostIdSchema = z.string().min(1).max(200).nullable();

export const rpcContract = defineRpcContract({
  // A null hostId reads the server machine.
  list_stacks: {
    input: z.object({ hostId: hostIdSchema }),
    output: listingSchema,
  },
  destroy_stack: {
    input: z.object({ hostId: hostIdSchema, slug: slugSchema }),
    output: destroyResultSchema,
  },
});

const LIST_TIMEOUT_MS = 20_000;
// Two sequential `compose down`s, each capped at three minutes on the host.
const DESTROY_TIMEOUT_MS = 400_000;

function stackLine(stack: Stack): string {
  const running = stack.containers.filter((c) => c.state === "running").length;
  const hosts = stack.hosts.length > 0 ? stack.hosts.join(" ") : "no traefik host";
  return `${stack.id}  ${running}/${stack.containers.length} running  ${hosts}`;
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function resolveHostId(requested: string | null): Promise<string> {
    if (requested !== null) return requested;
    const [config, hosts] = await Promise.all([bb.sdk.system.config(), bb.sdk.hosts.list()]);
    const hostId =
      config.primaryHostId ??
      hosts.find((h) => h.status === "connected" && h.lifecycle.phase === "active")?.id ??
      null;
    if (hostId === null) throw new Error("No connected machine to inspect.");
    return hostId;
  }

  async function listStacks(hostId: string | null): Promise<StackListing> {
    return host.call(
      "list",
      {},
      { hostId: await resolveHostId(hostId), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
    );
  }

  async function destroyStack(hostId: string | null, slug: string) {
    const target = await resolveHostId(hostId);
    bb.log.info(`destroying staging stack ${slug} on ${target}`);
    return host.call(
      "destroy",
      { slug },
      { hostId: target, signal: AbortSignal.timeout(DESTROY_TIMEOUT_MS) },
    );
  }

  bb.rpc.register(rpcContract, {
    list_stacks: ({ hostId }) => listStacks(hostId),
    destroy_stack: ({ hostId, slug }) => destroyStack(hostId, slug),
  });

  const usage = [
    "Usage:",
    "  bb traefik-stacks list [--host <host-id>] [--json]",
    "  bb traefik-stacks destroy <slug> --yes [--host <host-id>] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "traefik-stacks",
    summary: "List staging slugs and Traefik services on a machine, destroy slug stacks",
    commands: [
      {
        name: "list",
        summary: "List staging slugs and Traefik-exposed services (defaults to the server machine)",
        usage: "bb traefik-stacks list [--host <host-id>] [--json]",
      },
      {
        name: "destroy",
        summary: "Stop and remove a staging slug's containers, networks and volumes",
        usage: "bb traefik-stacks destroy <slug> --yes [--host <host-id>] [--json]",
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
        case "list": {
          if (rest.length > 0) break;
          const listing = await listStacks(hostId);
          if (json) return { exitCode: 0, stdout: JSON.stringify(listing) };
          if (listing.dockerError !== null) {
            return { exitCode: 1, stderr: `docker unavailable on ${listing.hostname}: ${listing.dockerError}` };
          }
          const staging = listing.stacks.filter((s) => s.kind === "staging");
          const services = listing.stacks.filter((s) => s.kind === "service");
          const lines = [
            `${listing.hostname}`,
            "",
            "Staging slugs:",
            ...(staging.length === 0 ? ["  none"] : staging.map((s) => `  ${stackLine(s)}`)),
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
