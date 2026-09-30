import { useCallback, useSyncExternalStore } from "react";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export type UsageLimits = Awaited<
  ReturnType<PluginBrowserBbSdk["system"]["usageLimits"]>
>;
export type ProviderUsage = UsageLimits[string];
export type UsageWindow = Extract<ProviderUsage, { status: "ok" }>["windows"][number];

export interface UsageSnapshot {
  data: UsageLimits | null;
  error: string | null;
  refreshing: boolean;
  /** Epoch ms of the last successful load. */
  loadedAt: number | null;
}

const EMPTY: UsageSnapshot = { data: null, error: null, refreshing: false, loadedAt: null };
const PRIMARY = "";

// One cache per machine so switching machines never shows another machine's numbers.
const snapshots = new Map<string, UsageSnapshot>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function update(key: string, next: Partial<UsageSnapshot>): void {
  snapshots.set(key, { ...(snapshots.get(key) ?? EMPTY), ...next });
  for (const listener of listeners) listener();
}

/** `hostId` null means BB's primary machine. */
export function useUsageSnapshot(hostId: string | null): UsageSnapshot {
  const key = hostId ?? PRIMARY;
  const get = useCallback(() => snapshots.get(key) ?? EMPTY, [key]);
  return useSyncExternalStore(subscribe, get, get);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Every call hits the provider bridges (no server-side cache), so callers pass
 * `maxAgeMs` and concurrent calls for one machine share a request.
 */
export function refreshUsage(
  sdk: PluginBrowserBbSdk,
  maxAgeMs: number,
  hostId: string | null,
): Promise<void> {
  const key = hostId ?? PRIMARY;
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const loadedAt = snapshots.get(key)?.loadedAt ?? null;
  if (loadedAt !== null && Date.now() - loadedAt < maxAgeMs) return Promise.resolve();
  update(key, { refreshing: true });
  const request = sdk.system
    .usageLimits({
      ...(hostId === null ? {} : { hostId }),
      signal: AbortSignal.timeout(60_000),
    })
    .then(
      (data) => update(key, { data, error: null, loadedAt: Date.now() }),
      (cause: unknown) => {
        console.warn("[usage-bar] usage refresh failed", cause);
        // Keep the last good data on screen; only flag the failure.
        update(key, { error: "Couldn’t refresh usage." });
      },
    )
    .finally(() => {
      inFlight.delete(key);
      update(key, { refreshing: false });
    });
  inFlight.set(key, request);
  return request;
}

/** Short column label: "5h", "7d", "1d", or the provider's own label (e.g. a model family). */
export function shortWindowLabel(window: UsageWindow): string {
  const model = Reflect.get(window, "model");
  if (typeof model !== "string" || model === "") {
    switch (Reflect.get(window, "kind")) {
      case "five-hour":
        return "5h";
      case "weekly":
        return "7d";
      case "daily":
        return "1d";
    }
  }
  return window.label
    .replace(/^(Current session|Five-hour limit|5 hours)$/u, "5h")
    .replace(/^Weekly( limit)?$/u, "7d")
    .replace(/^Daily( limit)?$/u, "1d");
}

export function usageTone(usedPercent: number): "ok" | "warning" | "critical" {
  if (usedPercent >= 95) return "critical";
  return usedPercent >= 80 ? "warning" : "ok";
}

export function formatCountdown(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const remaining = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
}

export function describeWindow(window: UsageWindow): string {
  const left = Math.max(0, Math.round(100 - window.usedPercent));
  const parts = [`${window.label}: ${left}% left (${Math.round(window.usedPercent)}% used)`];
  if (window.cost !== undefined)
    parts.push(
      `$${(window.cost.usedUsdCents / 100).toFixed(2)} / $${(window.cost.limitUsdCents / 100).toFixed(2)}`,
    );
  const reset = window.resetsAt === null ? null : new Date(window.resetsAt);
  parts.push(
    reset === null || Number.isNaN(reset.getTime())
      ? "reset time not reported"
      : `resets ${reset.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
  );
  return parts.join(" · ");
}
