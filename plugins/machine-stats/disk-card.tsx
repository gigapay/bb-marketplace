// Disk tab of the Machine card: folder sizes under a path, largest first,
// filling in as the background scan measures them. Click a folder to go in.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { DiskEntry, DiskLevel } from "./contract";
import type { rpcContract } from "./server";
import { formatBytes } from "./stats-card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// Fast while sizes are coming in; a finished level is cached on the server.
const SCANNING_POLL_MS = 2_000;

function useDiskLevel(hostId: string | null, dir: string | null, nonce: number) {
  const rpc = useRpc<typeof rpcContract>();
  const [level, setLevel] = useState<DiskLevel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLevel(null);
    setError(null);
  }, [hostId, dir]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // Only the first call of a manual refresh asks for a rescan.
    let rescan = nonce > 0;
    const load = () => {
      rpc.call("disk_level", { hostId, path: dir, rescan }).then(
        (next) => {
          if (cancelled) return;
          rescan = false;
          setLevel(next);
          setError(null);
          if (next.scanning) timer = window.setTimeout(load, SCANNING_POLL_MS);
        },
        (cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rpc, hostId, dir, nonce]);

  return { level, error };
}

function formatAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function Breadcrumb({
  path,
  rootPath,
  onOpen,
}: {
  path: string;
  rootPath: string;
  onOpen: (dir: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: "/", dir: "/" }].concat(
    parts.map((part, index) => ({ label: part, dir: `/${parts.slice(0, index + 1).join("/")}` })),
  );
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden text-2xs leading-4" title={path}>
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={crumb.dir} className={cn("flex min-w-0 items-center gap-0.5", !last && "shrink")}>
            {index > 1 ? <span className="text-muted-foreground">/</span> : null}
            <button
              type="button"
              disabled={last}
              onClick={() => onOpen(crumb.dir)}
              className={cn(
                "truncate rounded px-0.5",
                last
                  ? "font-medium text-sidebar-foreground"
                  : "text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground",
                crumb.dir === rootPath && !last && "underline decoration-dotted underline-offset-2",
              )}
            >
              {crumb.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function EntryRow({
  entry,
  largest,
  isTop,
  onOpen,
}: {
  entry: DiskEntry;
  largest: number;
  isTop: boolean;
  onOpen: (() => void) | null;
}) {
  const share = entry.bytes !== null && largest > 0 ? (entry.bytes / largest) * 100 : 0;
  const label = entry.kind === "files" ? "Other files" : entry.name;
  const size =
    entry.kind === "mount"
      ? "other disk"
      : entry.unreadable
        ? "unreadable"
        : entry.bytes === null
          ? null
          : formatBytes(entry.bytes);
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
        <Icon
          name={entry.kind === "dir" || entry.kind === "mount" ? "machine-stats/folder" : "machine-stats/file"}
          aria-hidden
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            entry.kind === "dir" ? "text-sidebar-foreground" : "text-subtle-foreground",
          )}
        >
          {label}
        </span>
        {size === null ? (
          <span className="h-3 w-10 shrink-0 animate-pulse rounded bg-sidebar-border" aria-label="Measuring" />
        ) : (
          <span className="shrink-0 tabular-nums text-sidebar-foreground">{size}</span>
        )}
      </span>
      {/* Bars are relative to the largest entry, like ncdu. */}
      <span className="mt-1 block h-0.5 overflow-hidden rounded-full bg-sidebar-border">
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500",
            isTop ? "bg-primary" : "bg-subtle-foreground",
          )}
          style={{ width: `${share}%` }}
        />
      </span>
    </>
  );
  if (onOpen === null) return <li className="px-1.5 py-1">{body}</li>;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${entry.name}`}
        className="block w-full rounded px-1.5 py-1 hover:bg-sidebar-accent/60"
      >
        {body}
      </button>
    </li>
  );
}

export function DiskUsage({ hostId }: { hostId: string | null }) {
  const [dir, setDir] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const { level, error } = useDiskLevel(hostId, dir, nonce);

  useEffect(() => {
    setDir(null);
    setNonce(0);
  }, [hostId]);

  const open = (next: string) => {
    setNonce(0);
    setDir(next);
  };

  if (level === null) {
    return (
      <p className="px-2.5 py-2 text-2xs text-muted-foreground">{error ?? "Reading folders…"}</p>
    );
  }

  const measured = level.entries.filter((e) => e.bytes !== null);
  const largest = Math.max(0, ...measured.map((e) => e.bytes ?? 0));
  const pending = level.entries.filter((e) => e.kind === "dir" && e.bytes === null && !e.unreadable).length;
  const total = measured.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  const parent = level.path === "/" ? null : level.path.replace(/\/[^/]+$/, "") || "/";

  return (
    <div className="flex flex-col gap-1 px-1.5 py-2">
      <div className="flex min-w-0 items-center gap-1 px-1">
        {parent !== null ? (
          <button
            type="button"
            onClick={() => open(parent)}
            aria-label="Up one folder"
            title="Up one folder"
            className="shrink-0 rounded px-1 text-2xs leading-4 text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            ..
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <Breadcrumb path={level.path} rootPath={level.rootPath} onOpen={open} />
        </div>
      </div>
      {level.error !== null ? (
        <p className="px-1 text-2xs text-destructive" title={level.error}>
          {level.error}
        </p>
      ) : level.entries.length === 0 && !level.scanning ? (
        <p className="px-1 text-2xs text-subtle-foreground">Empty folder.</p>
      ) : (
        <ul className="flex max-h-96 flex-col overflow-y-auto">
          {level.entries.map((entry, index) => (
            <EntryRow
              key={`${entry.kind}:${entry.name}`}
              entry={entry}
              largest={largest}
              isTop={index === 0 && entry.bytes !== null}
              onOpen={
                entry.kind === "dir"
                  ? () => open(level.path === "/" ? `/${entry.name}` : `${level.path}/${entry.name}`)
                  : null
              }
            />
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 px-1 text-2xs text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">
          {level.scanning
            ? `Measuring… ${pending} folder${pending === 1 ? "" : "s"} left`
            : [
                formatBytes(total),
                level.scannedAt !== null ? `scanned ${formatAgo(level.scannedAt)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        {level.partial ? (
          <span
            title="Some folders couldn't be read, so their sizes are a floor."
            className="flex shrink-0 items-center text-warning"
          >
            <Icon name="TriangleAlert" aria-label="Some folders unreadable" className="size-3" />
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          disabled={level.scanning}
          aria-label="Rescan"
          title="Rescan"
          className="shrink-0 rounded p-0.5 hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-40"
        >
          <Icon name="RefreshCw" aria-hidden className={cn("size-3", level.scanning && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}
