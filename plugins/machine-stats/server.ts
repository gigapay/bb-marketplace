// bb-plugin-machine-stats: CPU, RAM and disk usage for any connected machine.
//
// The server lists machines through bb.sdk and asks the plugin's host entry
// (host.ts, running in the target machine's daemon) for a live snapshot.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, snapshotSchema, type MachineSnapshot } from "./contract.js";

export type { MachineSnapshot };

export const rpcContract = defineRpcContract({
  // A null hostId reads the server machine.
  machine_snapshot: {
    input: z.object({ hostId: z.string().min(1).max(200).nullable() }),
    output: snapshotSchema,
  },
});

const SNAPSHOT_TIMEOUT_MS = 15_000;

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

const percent = (used: number, total: number) =>
  total > 0 ? `${((used / total) * 100).toFixed(0)}%` : "n/a";

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

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

  async function snapshot(requested: string | null): Promise<MachineSnapshot> {
    const hostId =
      requested ??
      (await bb.sdk.system.config()).primaryHostId ??
      (await listMachines()).defaultHostId;
    if (hostId === null) throw new Error("No connected machine to inspect.");
    return host.call(
      "snapshot",
      {},
      { hostId, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) },
    );
  }

  bb.rpc.register(rpcContract, {
    machine_snapshot: ({ hostId }) => snapshot(hostId),
  });

  const usage = [
    "Usage:",
    "  bb machine-stats machines [--json]",
    "  bb machine-stats show [<host-id>] [--json]",
  ].join("\n");

  bb.cli.register({
    name: "machine-stats",
    summary: "Show CPU, RAM and disk usage of connected machines",
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
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
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
          if (args.length > 1) break;
          const s = await snapshot(args[0] ?? null);
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
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
