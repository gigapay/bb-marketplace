// Usage tab of the Machine card, the hub: live CPU, RAM and disk bars, the
// last minutes of CPU and RAM as charts, and the three busiest processes.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useProcesses } from "./processes-card";
import type { HistoryPoint, MachineSnapshot, rpcContract } from "./server";
import { UsageChart } from "./usage-chart";
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

export function formatBytes(bytes: number): string {
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

const HISTORY_POLL_MS = 5_000;

// The server keeps the samples, so the charts are already filled when the
// card reopens. Reading them costs no host call.
function useHistory(hostId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [history, setHistory] = useState<{
    windowMs: number;
    intervalMs: number;
    points: HistoryPoint[];
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setHistory(null);
    let cancelled = false;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      rpc.call("machine_history", { hostId }).then(
        (next) => {
          if (cancelled) return;
          setHistory(next);
          setNow(Date.now());
        },
        () => {},
      );
    };
    tick();
    const timer = window.setInterval(tick, HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, hostId]);
  return { history, now };
}

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

function TopProcesses({
  hostId,
  onShowAll,
}: {
  hostId: string | null;
  onShowAll: () => void;
}) {
  const { listing } = useProcesses(hostId, 3);
  const rows = [...(listing?.processes ?? [])]
    .sort((a, b) => b.cpuPercent - a.cpuPercent)
    .slice(0, 3);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-1 text-2xs leading-4">
        <span className="min-w-0 flex-1 text-subtle-foreground">Top processes</span>
        <button
          type="button"
          onClick={onShowAll}
          className="shrink-0 rounded px-1 text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          See all
        </button>
      </div>
      {listing === null ? (
        <p className="text-2xs text-muted-foreground">Reading processes…</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((process) => (
            <li
              key={process.pid}
              className="flex min-w-0 items-center gap-2 text-2xs leading-4"
              title={[`PID ${process.pid}`, process.command].join("\n")}
            >
              <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                {process.name}
                {process.container !== null ? (
                  <span className="ml-1 text-subtle-foreground">{process.container}</span>
                ) : null}
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums text-sidebar-foreground">
                {process.cpuPercent.toFixed(process.cpuPercent >= 10 ? 0 : 1)}%
              </span>
              <span className="w-12 shrink-0 text-right tabular-nums text-subtle-foreground">
                {formatBytes(process.memoryBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MachineStats({
  hostId,
  machineName,
  onShowProcesses,
}: {
  hostId: string | null;
  machineName: string | null;
  onShowProcesses: () => void;
}) {
  const { snapshot, error } = useSnapshot(hostId);
  const { history, now } = useHistory(hostId);

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
      {history !== null ? (
        <div className="flex flex-col gap-1.5 border-t border-sidebar-border pt-1.5">
          <UsageChart
            label={`CPU · ${Math.round(history.windowMs / 60_000)} min`}
            metric="cpuPercent"
            points={history.points}
            windowMs={history.windowMs}
            intervalMs={history.intervalMs}
            now={now}
          />
          <UsageChart
            label={`RAM · ${Math.round(history.windowMs / 60_000)} min`}
            metric="memoryPercent"
            points={history.points}
            windowMs={history.windowMs}
            intervalMs={history.intervalMs}
            now={now}
          />
        </div>
      ) : null}
      <div className="border-t border-sidebar-border pt-1.5">
        <TopProcesses hostId={hostId} onShowAll={onShowProcesses} />
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
