// Live checks for a PR. GitHub offers API clients no push channel, so this
// polls: every 10s while something runs, every minute once all is settled,
// and not at all while the window is hidden.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Check, PrChecks } from "../checks";
import type { rpcContract } from "../server";
import { CheckGlyphIcon, type CheckGlyph } from "./icons";
import { ErrorLine, errorText } from "./shared";

const ACTIVE_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 60_000;

function isActive(check: Check): boolean {
  return check.state === "queued" || check.state === "running";
}

export function usePrChecks(key: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [checks, setChecks] = useState<PrChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<PrChecks | null>(null);

  const poll = useCallback(async () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (document.visibilityState === "hidden") return;
    setLoading(true);
    try {
      const next = await rpc.call("pr_checks", { key });
      latest.current = next;
      setChecks(next);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
    const active = latest.current?.checks.some(isActive) ?? false;
    timer.current = setTimeout(() => void poll(), active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
  }, [rpc, key]);

  useEffect(() => {
    void poll();
    // Coming back to the window refreshes right away.
    const onVisibility = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [poll]);

  return { checks, error, loading, refresh: poll };
}

const STATE_ORDER: Check["state"][] = ["failure", "running", "queued", "cancelled", "neutral", "skipped", "success"];

const STATE_STYLE: Record<Check["state"], { glyph: CheckGlyph; className: string; label: string }> = {
  failure: { glyph: "failure", className: "text-destructive", label: "Failed" },
  running: { glyph: "pending", className: "text-[#bf8700] animate-spin [animation-duration:3s]", label: "Running" },
  queued: { glyph: "pending", className: "text-muted-foreground", label: "Queued" },
  cancelled: { glyph: "skipped", className: "text-muted-foreground", label: "Cancelled" },
  neutral: { glyph: "skipped", className: "text-muted-foreground", label: "Neutral" },
  skipped: { glyph: "skipped", className: "text-muted-foreground", label: "Skipped" },
  success: { glyph: "success", className: "text-[#1f883d]", label: "Passed" },
};

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Ticks once a second, only while something runs, so durations count up. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function ChecksSection({ state }: { state: ReturnType<typeof usePrChecks> }) {
  const { checks, error, loading, refresh } = state;
  const [showPassed, setShowPassed] = useState(false);
  const list = checks?.checks ?? [];
  const active = list.some(isActive);
  const now = useNow(active);

  const sorted = useMemo(
    () =>
      [...list].sort(
        (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name),
      ),
    [list],
  );
  const counts = useMemo(() => {
    const byState = new Map<Check["state"], number>();
    for (const check of list) byState.set(check.state, (byState.get(check.state) ?? 0) + 1);
    return byState;
  }, [list]);
  const settled = sorted.filter((check) => check.state === "success" || check.state === "skipped" || check.state === "neutral");
  const attention = sorted.filter((check) => !settled.includes(check));

  const summary = [
    counts.get("failure") ? `${counts.get("failure")} failed` : null,
    counts.get("running") ? `${counts.get("running")} running` : null,
    counts.get("queued") ? `${counts.get("queued")} queued` : null,
    counts.get("success") ? `${counts.get("success")} passed` : null,
  ].filter(Boolean);

  return (
    <section>
      <div className="mb-2 flex min-h-8 items-center gap-2">
        <h3 className="text-sm font-medium">Checks</h3>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {checks === null ? "" : list.length === 0 ? "No checks on this commit." : summary.join(" · ")}
        </span>
        {active ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-[#1f883d]" />
            Live
          </span>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="Refresh checks" onClick={() => void refresh()} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>
      <ErrorLine error={error} />
      {list.length > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {attention.map((check) => (
            <CheckRow key={check.id} check={check} now={now} />
          ))}
          {settled.length > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setShowPassed((value) => !value)}
                aria-expanded={showPassed}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
              >
                <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", showPassed && "rotate-90")} />
                {settled.length} successful or skipped
              </button>
            </li>
          ) : null}
          {showPassed ? settled.map((check) => <CheckRow key={check.id} check={check} now={now} />) : null}
        </ul>
      ) : null}
    </section>
  );
}

function CheckRow({ check, now }: { check: Check; now: number }) {
  const style = STATE_STYLE[check.state];
  const started = check.startedAt ? Date.parse(check.startedAt) : null;
  const ended = check.completedAt ? Date.parse(check.completedAt) : null;
  const duration =
    started === null ? null : check.state === "running" ? formatDuration(now - started) : ended !== null ? formatDuration(ended - started) : null;
  const content = (
    <>
      <span className={cn("inline-flex shrink-0", style.className)}>
        <CheckGlyphIcon kind={style.glyph} label={style.label} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{check.name}</span>
        {check.workflow ? <span className="block truncate text-xs text-muted-foreground">{check.workflow}</span> : null}
      </span>
      {check.isRequired ? (
        <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Required</span>
      ) : null}
      <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {check.state === "queued" ? "queued" : duration}
      </span>
      {check.url ? <Icon name="ExternalLink" className="size-3.5 shrink-0 text-muted-foreground" /> : <span className="size-3.5" />}
    </>
  );
  return (
    <li>
      {check.url ? (
        <UrlLink
          href={check.url}
          target="_blank"
          className="flex w-full items-center gap-3 px-3 py-2 text-sm text-foreground no-underline hover:bg-accent/50"
        >
          {content}
        </UrlLink>
      ) : (
        <div className="flex items-center gap-3 px-3 py-2 text-sm">{content}</div>
      )}
    </li>
  );
}
