import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useSdk,
  type ExperimentalSidebarFooterDisclosureController,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  describeWindow,
  formatCountdown,
  getUsageSnapshot,
  refreshUsage,
  shortWindowLabel,
  subscribeUsage,
  usageTone,
  type ProviderUsage,
  type UsageWindow,
} from "./usage";

const DISCLOSURE_ID = "usage";
const PINNED_STORAGE_KEY = "bb.usage-bar.pinned.v1";
const POLL_INTERVAL_MS = 2 * 60_000;
const STALE_AFTER_MS = 60_000;
const AFTER_TURN_DELAY_MS = 5_000;

// The host only offers a click-to-open disclosure, so "always visible" means
// re-opening it whenever it closes for a reason other than the user clicking
// its footer icon (Escape, sidebar remount, another plugin's disclosure).
let pinned = readPinned();
let mountedCount = 0;
let controller: ExperimentalSidebarFooterDisclosureController | null = null;
let ensureOpen: () => void = () => {};

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PINNED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setPinned(value: boolean): void {
  pinned = value;
  try {
    window.localStorage.setItem(PINNED_STORAGE_KEY, String(value));
  } catch {}
}

const BAR_CLASS = {
  ok: "bg-primary",
  warning: "bg-warning",
  critical: "bg-destructive",
} as const;

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const used = Math.round(window.usedPercent);
  const tone = usageTone(window.usedPercent);
  return (
    <div
      className="col-span-full grid grid-cols-subgrid items-center text-2xs leading-4"
      title={describeWindow(window)}
    >
      <span className="truncate text-subtle-foreground">{shortWindowLabel(window)}</span>
      <span className="h-1.5 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-300", BAR_CLASS[tone])}
          style={{ width: `${Math.max(2, Math.min(100, window.usedPercent))}%` }}
        />
      </span>
      <span
        className={cn(
          "text-right tabular-nums",
          tone === "critical"
            ? "text-destructive"
            : tone === "warning"
              ? "text-warning"
              : "text-sidebar-foreground",
        )}
      >
        {used}%
      </span>
      <span className="text-right tabular-nums text-subtle-foreground">
        {formatCountdown(window.resetsAt, now) ?? "—"}
      </span>
    </div>
  );
}

function statusMessage(usage: ProviderUsage): string | null {
  switch (usage.status) {
    case "ok":
      return usage.windows.length === 0 ? "No limits reported" : null;
    case "unauthenticated":
      return "Sign in to see usage";
    case "expired":
      return "Session expired, sign in again";
    case "error":
      return "Couldn’t load usage";
    case "not_installed":
      return null;
  }
}

function UsageBar() {
  const sdk = useSdk();
  const snapshot = useSyncExternalStore(subscribeUsage, getUsageSnapshot, getUsageSnapshot);
  const { providers } = experimental_useProviders();
  const { threads } = experimental_useSidebarThreads();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    mountedCount += 1;
    return () => {
      mountedCount -= 1;
      // Let the host settle (another disclosure may be taking the slot) before re-opening.
      window.setTimeout(ensureOpen, 80);
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      void refreshUsage(sdk, POLL_INTERVAL_MS - 5_000);
    };
    const onFocus = () => {
      setNow(Date.now());
      void refreshUsage(sdk, STALE_AFTER_MS);
    };
    void refreshUsage(sdk, STALE_AFTER_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    const poll = window.setInterval(tick, POLL_INTERVAL_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [sdk]);

  // A finished turn is when usage actually moves, so refresh shortly after one.
  const busyCount = threads.filter(
    (thread) => thread.status === "active" || thread.status === "starting",
  ).length;
  const previousBusy = useRef(busyCount);
  useEffect(() => {
    const dropped = busyCount < previousBusy.current;
    previousBusy.current = busyCount;
    if (!dropped) return;
    const timer = window.setTimeout(
      () => void refreshUsage(sdk, STALE_AFTER_MS / 2),
      AFTER_TURN_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [busyCount, sdk]);

  const rows = useMemo(() => {
    const data = snapshot.data ?? {};
    const order = new Map(providers.map((provider, index) => [provider.id, index]));
    return Object.entries(data)
      .filter(([, usage]) => usage.status !== "not_installed")
      .sort(
        ([a], [b]) =>
          (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(([id, usage]) => ({
        id,
        usage,
        provider: providers.find((provider) => provider.id === id) ?? { id, displayName: id },
      }));
  }, [snapshot.data, providers]);

  const loadedAgo =
    snapshot.loadedAt === null ? null : Math.max(0, Math.round((now - snapshot.loadedAt) / 60_000));

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {rows.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {snapshot.data === null
            ? snapshot.error ?? "Loading usage…"
            : "No provider reports usage on this machine."}
        </p>
      ) : (
        rows.map(({ id, usage, provider }) => {
          const message = statusMessage(usage);
          return (
            <section key={id} aria-label={`${provider.displayName} usage`} className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <ProviderIcon
                  providerKind="agent"
                  provider={provider}
                  fallback="Bot"
                  className="size-3.5 shrink-0"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground">
                  {provider.displayName}
                </span>
                {usage.status === "ok" && usage.planLabel !== null ? (
                  <span className="shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">
                    {usage.planLabel}
                  </span>
                ) : null}
              </div>
              {message !== null ? (
                <p
                  className="mt-0.5 pl-5 text-2xs text-muted-foreground"
                  title={usage.status === "error" ? usage.message : undefined}
                >
                  {message}
                </p>
              ) : usage.status === "ok" ? (
                <div className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)_2.25rem_max-content] gap-x-2 gap-y-0.5 pl-5">
                  {usage.windows.map((window) => (
                    <WindowRow key={`${window.label}-${window.resetsAt}`} window={window} now={now} />
                  ))}
                </div>
              ) : null}
            </section>
          );
        })
      )}
      <div className="flex items-center justify-between gap-2 text-2xs text-subtle-foreground">
        <span className="truncate">
          {snapshot.error !== null && snapshot.data !== null
            ? snapshot.error
            : loadedAgo === null
              ? ""
              : loadedAgo === 0
                ? "Updated just now"
                : `Updated ${loadedAgo} min ago`}
        </span>
        <button
          type="button"
          aria-label="Refresh usage"
          disabled={snapshot.refreshing}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
          onClick={() => void refreshUsage(sdk, 0)}
        >
          <Icon
            name="RotateCcw"
            aria-hidden
            className={cn("size-3", snapshot.refreshing && "animate-spin")}
          />
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  controller = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: DISCLOSURE_ID,
    label: "Usage",
    icon: "ChartColumn",
    component: UsageBar,
  });

  app.contentScripts.register({
    id: "keep-usage-open",
    mount({ pluginId, signal }) {
      const triggerSelector = `[id^="plugin-sidebar-footer-trigger-${pluginId}-${DISCLOSURE_ID}-"]`;
      let lastOpenAt = 0;
      ensureOpen = () => {
        if (signal.aborted || !pinned || mountedCount > 0) return;
        if (document.visibilityState === "hidden") return;
        // Only while our icon sits in the footer: hidden, in "More", or a collapsed sidebar means no.
        if (document.querySelector(triggerSelector) === null) return;
        // Don't fight another plugin's open disclosure; ours comes back when it closes.
        if (document.querySelector('[data-testid^="plugin-sidebar-footer-disclosure-"]') !== null)
          return;
        if (Date.now() - lastOpenAt < 1_000) return;
        lastOpenAt = Date.now();
        controller?.open();
      };
      // Clicking our footer icon is the one explicit "show / hide" signal.
      const onClick = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest(triggerSelector) === null) return;
        setPinned(mountedCount === 0);
      };
      document.addEventListener("click", onClick, true);
      const timer = window.setInterval(ensureOpen, 1_000);
      ensureOpen();
      return () => {
        ensureOpen = () => {};
        window.clearInterval(timer);
        document.removeEventListener("click", onClick, true);
      };
    },
  });
});
