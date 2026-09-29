import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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

/** Linear's priority glyphs: signal bars, an alert square for urgent, a dash for none. */
export function PriorityIcon({ priority, label }: { priority: number; label: string }) {
  if (priority === 1) {
    return (
      <svg role="img" aria-label={label} viewBox="0 0 16 16" className="size-4 shrink-0 text-destructive">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" />
        <path d="M8 4.5v4.5M8 11.2v.3" stroke="var(--background, #fff)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (priority < 2 || priority > 4) {
    return (
      <svg role="img" aria-label={label} viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground">
        <path d="M3 8h2M7 8h2M11 8h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // High lights three bars, medium two, low one.
  const lit = 5 - priority;
  return (
    <svg role="img" aria-label={label} viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground">
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2 + bar * 4.5}
          y={10 - bar * 3.5}
          width="3"
          height={4 + bar * 3.5}
          rx="1"
          fill="currentColor"
          opacity={bar < lit ? 1 : 0.3}
        />
      ))}
    </svg>
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
