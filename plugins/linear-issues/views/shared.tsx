import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { IssueSummary } from "../server";

type IssueState = IssueSummary["state"];

// Linear's own board order: active work first, closed work last.
const STATE_TYPE_ORDER = ["triage", "started", "unstarted", "backlog", "completed", "canceled"];

export function stateTypeRank(type: string): number {
  const rank = STATE_TYPE_ORDER.indexOf(type);
  return rank === -1 ? STATE_TYPE_ORDER.length : rank;
}

export function StateIcon({ state, className }: { state: IssueState; className?: string }) {
  const fill =
    state.type === "completed" || state.type === "canceled"
      ? state.color
      : state.type === "started"
        ? `conic-gradient(${state.color} 0 50%, transparent 50% 100%)`
        : "transparent";
  return (
    <span
      aria-hidden
      className={cn("inline-block size-3 shrink-0 rounded-full border-[1.5px]", className)}
      style={{
        borderColor: state.color,
        borderStyle: state.type === "backlog" ? "dashed" : "solid",
        background: fill,
      }}
    />
  );
}

const PRIORITY_ICONS: Record<number, string> = {
  1: "AlertOctagon",
  2: "SignalHigh",
  3: "SignalMedium",
  4: "SignalLow",
};

export function PriorityIcon({ priority, label }: { priority: number; label: string }) {
  const name = PRIORITY_ICONS[priority];
  if (name === undefined) {
    return <span aria-label={label} className="inline-block w-4 text-center text-muted-foreground">–</span>;
  }
  return (
    <Icon
      name={name}
      aria-label={label}
      className={cn("size-4 shrink-0", priority === 1 ? "text-destructive" : "text-muted-foreground")}
    />
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="mt-3 text-sm text-destructive">
      {error}
    </p>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
