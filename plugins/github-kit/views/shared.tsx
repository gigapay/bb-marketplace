import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { PullRequest } from "../server";
import { CheckGlyphIcon, PrGlyphIcon, type CheckGlyph } from "./icons";

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

// GitHub's own colors for open, draft, merged and closed.
const PR_STATE_STYLE = {
  open: { color: "#1f883d", label: "Open" },
  draft: { color: "#8c959f", label: "Draft" },
  merged: { color: "#8250df", label: "Merged" },
  closed: { color: "#cf222e", label: "Closed" },
} as const;

export function prState(pr: Pick<PullRequest, "state" | "isDraft">): keyof typeof PR_STATE_STYLE {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

export function PrStateIcon({ pr }: { pr: Pick<PullRequest, "state" | "isDraft"> }) {
  const kind = prState(pr);
  const style = PR_STATE_STYLE[kind];
  return (
    <span className="inline-flex shrink-0" style={{ color: style.color }}>
      <PrGlyphIcon kind={kind} label={style.label} />
    </span>
  );
}

const CHECKS_STYLE: Record<NonNullable<PullRequest["checks"]>, { kind: CheckGlyph; className: string; label: string }> = {
  SUCCESS: { kind: "success", className: "text-[#1f883d]", label: "Checks passed" },
  FAILURE: { kind: "failure", className: "text-destructive", label: "Checks failed" },
  ERROR: { kind: "failure", className: "text-destructive", label: "Checks errored" },
  PENDING: { kind: "pending", className: "text-[#bf8700]", label: "Checks running" },
  EXPECTED: { kind: "pending", className: "text-[#bf8700]", label: "Checks expected" },
};

export function ChecksIcon({ checks }: { checks: PullRequest["checks"] }) {
  if (checks === null) return <span aria-hidden className="size-4 shrink-0" />;
  const style = CHECKS_STYLE[checks];
  return (
    <span className={cn("inline-flex shrink-0", style.className)}>
      <CheckGlyphIcon kind={style.kind} label={style.label} />
    </span>
  );
}

const REVIEW_STYLE: Record<NonNullable<PullRequest["reviewDecision"]>, { label: string; className: string }> = {
  APPROVED: { label: "Approved", className: "border-[#1f883d]/40 text-[#1f883d]" },
  CHANGES_REQUESTED: { label: "Changes requested", className: "border-destructive/40 text-destructive" },
  REVIEW_REQUIRED: { label: "Review required", className: "border-border text-muted-foreground" },
};

export function ReviewChip({ decision }: { decision: PullRequest["reviewDecision"] }) {
  if (decision === null) return null;
  const style = REVIEW_STYLE[decision];
  return (
    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs", style.className)}>{style.label}</span>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `#${color}` }} />
      <span className="truncate">{name}</span>
    </span>
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
