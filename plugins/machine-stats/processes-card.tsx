// Processes tab of the Machine card: the busiest processes by CPU or memory,
// tagged with their docker container when they run in one.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ProcessListing, rpcContract } from "./server";
import { formatBytes } from "./stats-card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 3_000;
const SHOWN = 12;
const SORT_KEY = "machine-stats:process-sort";

type Sort = "cpu" | "memory";

function useProcesses(hostId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<ProcessListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setListing(null);
    setError(null);
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      rpc
        .call("top_processes", { hostId, limit: SHOWN })
        .then(
          (next) => {
            if (cancelled) return;
            setListing(next);
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
  return { listing, error };
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-1 text-2xs leading-4",
        active
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-subtle-foreground hover:text-sidebar-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function ProcessList({ hostId }: { hostId: string | null }) {
  const { listing, error } = useProcesses(hostId);
  const [sort, setSort] = useState<Sort>(() =>
    window.localStorage.getItem(SORT_KEY) === "memory" ? "memory" : "cpu",
  );
  const choose = (next: Sort) => {
    setSort(next);
    window.localStorage.setItem(SORT_KEY, next);
  };

  if (listing === null) {
    return (
      <p className="px-2.5 py-2 text-2xs text-muted-foreground">
        {error ?? "Reading processes…"}
      </p>
    );
  }

  const rows = [...listing.processes]
    .sort((a, b) => (sort === "cpu" ? b.cpuPercent - a.cpuPercent : b.memoryBytes - a.memoryBytes))
    .slice(0, SHOWN);

  return (
    <div className="flex flex-col gap-1 px-2.5 py-2">
      <div className="flex items-center gap-1 text-2xs text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">
          {listing.processCount} processes · {listing.cores} cores
        </span>
        <SortButton active={sort === "cpu"} onClick={() => choose("cpu")}>
          CPU
        </SortButton>
        <SortButton active={sort === "memory"} onClick={() => choose("memory")}>
          RAM
        </SortButton>
        {error !== null ? (
          <span title={error} className="flex shrink-0 items-center text-warning">
            <Icon name="TriangleAlert" aria-label="Last refresh failed" className="size-3" />
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {rows.map((process) => {
          // Share of the whole machine, so one pegged core on 16 isn't red.
          const machineCpu = process.cpuPercent / listing.cores;
          return (
            <li
              key={process.pid}
              className="flex min-w-0 items-center gap-2 rounded px-1 text-2xs leading-5 hover:bg-sidebar-accent/50"
              title={[
                `PID ${process.pid}`,
                process.container !== null ? `Container ${process.container}` : null,
                process.command,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                {process.name}
                {process.container !== null ? (
                  <span className="ml-1 text-subtle-foreground">{process.container}</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "w-10 shrink-0 text-right tabular-nums",
                  sort === "cpu" ? "text-sidebar-foreground" : "text-subtle-foreground",
                  machineCpu >= 50 && "text-warning",
                  machineCpu >= 85 && "text-destructive",
                )}
              >
                {process.cpuPercent.toFixed(process.cpuPercent >= 10 ? 0 : 1)}%
              </span>
              <span
                className={cn(
                  "w-12 shrink-0 text-right tabular-nums",
                  sort === "memory" ? "text-sidebar-foreground" : "text-subtle-foreground",
                )}
              >
                {formatBytes(process.memoryBytes)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
