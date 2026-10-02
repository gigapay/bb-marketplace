// Top of the Machine card: live CPU, RAM and disk usage bars.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { MachineSnapshot, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// The card only mounts while the disclosure is open, so polling costs nothing
// when it's closed.
const POLL_INTERVAL_MS = 3_000;

const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

const TEXT_CLASS = {
  ok: "text-sidebar-foreground",
  warning: "text-warning",
  critical: "text-destructive",
} as const;

type Tone = keyof typeof BAR_CLASS;

function toneOf(percent: number): Tone {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warning";
  return "ok";
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const ratio = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

function useSnapshot(hostId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<MachineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSnapshot(null);
    setError(null);
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      // A slow machine must not pile up overlapping reads.
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      rpc
        .call("machine_snapshot", { hostId })
        .then(
          (next) => {
            if (cancelled) return;
            setSnapshot(next);
            setError(null);
          },
          (cause: unknown) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, hostId]);
  return { snapshot, error };
}

function Bar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-500",
          BAR_CLASS[toneOf(clamped)],
        )}
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

function MetricRow({
  icon,
  label,
  percent,
  detail,
  title,
}: {
  icon: string;
  label: string;
  percent: number;
  detail: string;
  title: string;
}) {
  return (
    <div
      className="col-span-full grid grid-cols-subgrid items-center text-2xs leading-4"
      title={title}
    >
      <span className="flex min-w-0 items-center gap-1 text-subtle-foreground">
        <Icon name={icon} aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <Bar percent={percent} />
      <span className={cn("text-right tabular-nums", TEXT_CLASS[toneOf(percent)])}>
        {Math.round(percent)}%
      </span>
      <span className="truncate text-right tabular-nums text-subtle-foreground">{detail}</span>
    </div>
  );
}

// Same figure as df: root-reserved blocks count as neither used nor available.
function diskPercent(disk: MachineSnapshot["disks"][number]): number {
  return ratio(disk.usedBytes, disk.usedBytes + disk.availableBytes);
}

function diskLabel(mount: string): string {
  if (mount === "/" || mount === "/System/Volumes/Data") return "Disk";
  return mount.split("/").filter(Boolean).at(-1) ?? mount;
}

export function MachineStats({
  hostId,
  machineName,
}: {
  hostId: string | null;
  machineName: string | null;
}) {
  const { snapshot, error } = useSnapshot(hostId);

  if (snapshot === null) {
    return (
      <p className="px-2.5 py-2 text-2xs text-muted-foreground">
        {error ?? "Reading machine stats…"}
      </p>
    );
  }

  const { cpu, memory, disks } = snapshot;
  const memoryPercent = ratio(memory.usedBytes, memory.totalBytes);
  const status = [machineName ?? snapshot.hostname, `up ${formatUptime(snapshot.uptimeSeconds)}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2">
      {/* Fixed side columns so bars line up across rows, like Usage Bar. */}
      <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_2.25rem_4.5rem] gap-x-2 gap-y-0.5">
        <MetricRow
          icon="machine-stats/cpu"
          label="CPU"
          percent={cpu.usagePercent}
          detail={`${cpu.loadAverage[0].toFixed(2)} load`}
          title={`${cpu.model} · ${cpu.cores} cores · load ${cpu.loadAverage.map((l) => l.toFixed(2)).join(" / ")}`}
        />
        <MetricRow
          icon="machine-stats/memory"
          label="RAM"
          percent={memoryPercent}
          detail={`${formatBytes(memory.usedBytes)}/${formatBytes(memory.totalBytes)}`}
          title={`${formatBytes(memory.usedBytes)} used of ${formatBytes(memory.totalBytes)} · ${formatBytes(memory.availableBytes)} available`}
        />
        {disks.map((disk) => (
          <MetricRow
            key={disk.filesystem}
            icon="machine-stats/disk"
            label={diskLabel(disk.mount)}
            percent={diskPercent(disk)}
            detail={`${formatBytes(disk.availableBytes)} free`}
            title={`${disk.mount} (${disk.filesystem}) · ${formatBytes(disk.usedBytes)} used of ${formatBytes(disk.totalBytes)}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-1 text-2xs text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate" title={snapshot.platform}>
          {status}
        </span>
        {error !== null ? (
          <span title={error} className="flex shrink-0 items-center text-warning">
            <Icon name="TriangleAlert" aria-label="Last refresh failed" className="size-3" />
          </span>
        ) : null}
      </div>
    </div>
  );
}
