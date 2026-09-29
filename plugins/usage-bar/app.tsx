import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  type UsageWindow,
} from "./usage";
import { windowKey } from "./prefs";
import { usePrefs } from "./use-prefs";
import { useUsageRows, type UsageRow } from "./rows";
import { UsageSettings } from "./settings";

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

// No SDK navigation to plugin settings; BB uses a BrowserRouter, which follows popstate.
function openSettings(pluginId: string): void {
  window.history.pushState(null, "", `/settings/plugins/${encodeURIComponent(pluginId)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
let settingsPluginId = "usage-bar";

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

// Bars show what's left, like a battery; tone still follows consumption.
function remainingOf(window: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function Bar({ window, className }: { window: UsageWindow; className?: string }) {
  return (
    <span className={cn("min-w-0 overflow-hidden rounded-full bg-sidebar-border", className)}>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300",
          BAR_CLASS[usageTone(window.usedPercent)],
        )}
        style={{ width: `${remainingOf(window)}%` }}
      />
    </span>
  );
}

function WindowRow({ window, now }: { window: UsageWindow; now: number }) {
  const tone = usageTone(window.usedPercent);
  return (
    <div
      className="col-span-full grid grid-cols-subgrid items-center text-2xs leading-4"
      title={describeWindow(window)}
    >
      <span className="truncate text-subtle-foreground">{shortWindowLabel(window)}</span>
      <Bar window={window} className="h-1.5" />
      <span className={cn("text-right tabular-nums", TEXT_CLASS[tone])}>
        {Math.round(remainingOf(window))}%
      </span>
      <span className="text-right tabular-nums text-subtle-foreground">
        {formatCountdown(window.resetsAt, now) ?? "—"}
      </span>
    </div>
  );
}

function ProviderBlock({ row, now }: { row: UsageRow; now: number }) {
  const { provider, usage, windows, message } = row;
  return (
    <section aria-label={`${provider.displayName} usage`} className="min-w-0">
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
      ) : windows.length > 0 ? (
        <div className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)_2.25rem_max-content] gap-x-2 gap-y-0.5 pl-5">
          {windows.map((window) => (
            <WindowRow key={window.label} window={window} now={now} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CompactProviderRow({ row, now }: { row: UsageRow; now: number }) {
  const { provider, usage, windows, message } = row;
  return (
    <section
      aria-label={`${provider.displayName} usage`}
      className="flex min-w-0 items-center gap-2"
      title={provider.displayName + (usage.status === "ok" && usage.planLabel ? ` · ${usage.planLabel}` : "")}
    >
      <ProviderIcon
        providerKind="agent"
        provider={provider}
        fallback="Bot"
        className="size-3.5 shrink-0"
        aria-label={provider.displayName}
      />
      {message !== null ? (
        <span className="min-w-0 truncate text-2xs text-muted-foreground">{message}</span>
      ) : (
        <div
          className="grid min-w-0 flex-1 gap-2"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, windows.length)}, minmax(0, 1fr))` }}
        >
          {windows.map((window) => {
            const tone = usageTone(window.usedPercent);
            const countdown = formatCountdown(window.resetsAt, now);
            return (
              <span
                key={window.label}
                className="flex min-w-0 items-center gap-1 text-2xs leading-4"
                title={describeWindow(window) + (countdown === null ? "" : ` (in ${countdown})`)}
              >
                <span className="shrink-0 text-subtle-foreground">{shortWindowLabel(window)}</span>
                <Bar window={window} className="h-1 flex-1" />
                <span className={cn("shrink-0 tabular-nums", TEXT_CLASS[tone])}>
                  {Math.round(remainingOf(window))}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IconButton({
  label,
  icon,
  spinning = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: string;
  spinning?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="flex size-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
      onClick={onClick}
    >
      <Icon name={icon} aria-hidden className={cn("size-3", spinning && "animate-spin")} />
    </button>
  );
}

function UsageBar() {
  const sdk = useSdk();
  const snapshot = useSyncExternalStore(subscribeUsage, getUsageSnapshot, getUsageSnapshot);
  const [prefs] = usePrefs();
  const { threads } = experimental_useSidebarThreads();
  const allRows = useUsageRows(snapshot.data);
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

  const rows = allRows
    .filter(
      (row) =>
        !prefs.hiddenProviders.includes(row.id) &&
        !(prefs.hideSignedOut && row.usage.status === "unauthenticated"),
    )
    .map((row) => ({
      ...row,
      windows: row.windows.filter(
        (window) => !prefs.hiddenWindows.includes(windowKey(row.id, window.label)),
      ),
    }))
    // A provider whose every window is hidden has nothing left to say.
    .filter((row) => row.message !== null || row.windows.length > 0);

  const loadedAgo =
    snapshot.loadedAt === null ? null : Math.max(0, Math.round((now - snapshot.loadedAt) / 60_000));
  const status =
    snapshot.error !== null && snapshot.data !== null
      ? snapshot.error
      : loadedAgo === null
        ? ""
        : loadedAgo === 0
          ? "Updated just now"
          : `Updated ${loadedAgo} min ago`;
  const controls = (
    <>
      <IconButton
        label="Refresh usage"
        icon="RotateCcw"
        spinning={snapshot.refreshing}
        disabled={snapshot.refreshing}
        onClick={() => void refreshUsage(sdk, 0)}
      />
      <IconButton
        label="Usage bar settings"
        icon="SlidersHorizontal"
        onClick={() => openSettings(settingsPluginId)}
      />
    </>
  );

  const empty =
    rows.length === 0 ? (
      <p className="text-2xs text-muted-foreground">
        {snapshot.data === null
          ? (snapshot.error ?? "Loading usage…")
          : allRows.length === 0
            ? "No provider reports usage on this machine."
            : "Every provider is hidden."}
      </p>
    ) : null;

  if (prefs.compact) {
    return (
      <div className="group relative flex flex-col gap-1 px-2.5 py-1.5" title={status || undefined}>
        {empty}
        {rows.map((row) => (
          <CompactProviderRow key={row.id} row={row} now={now} />
        ))}
        {/* Controls float over the card on hover so compact mode costs no extra row. */}
        <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-sm bg-sidebar opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {controls}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2">
      {empty}
      {rows.map((row) => (
        <ProviderBlock key={row.id} row={row} now={now} />
      ))}
      <div className="flex items-center gap-1 text-2xs text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">{status}</span>
        {controls}
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

  app.slots.settingsSection({
    id: "display",
    title: "Display",
    description: "What the usage card in the sidebar footer shows.",
    component: UsageSettings,
  });

  app.contentScripts.register({
    id: "keep-usage-open",
    mount({ pluginId, signal }) {
      settingsPluginId = pluginId;
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
