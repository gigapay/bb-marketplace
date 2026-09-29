import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, useSdk } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { getUsageSnapshot, refreshUsage, shortWindowLabel, subscribeUsage } from "./usage";
import { windowKey } from "./prefs";
import { toggleIn, usePrefs } from "./use-prefs";
import { useUsageRows } from "./rows";

function Toggle({
  checked,
  disabled = false,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", disabled && "opacity-50")}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
      <label htmlFor={id} className="min-w-0 text-sm">
        <span className="flex items-center gap-1.5 text-foreground">{children}</span>
        {hint === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </label>
    </div>
  );
}

export function UsageSettings() {
  const sdk = useSdk();
  const snapshot = useSyncExternalStore(subscribeUsage, getUsageSnapshot, getUsageSnapshot);
  const rows = useUsageRows(snapshot.data);
  const [prefs, update] = usePrefs();

  useEffect(() => {
    void refreshUsage(sdk, 60_000);
  }, [sdk]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Toggle
          checked={prefs.compact}
          onChange={(compact) => update((current) => ({ ...current, compact }))}
          hint="One line per provider with small bars. Hover a bar for the window name and reset time."
        >
          Compact mode
        </Toggle>
        <Toggle
          checked={prefs.hideSignedOut}
          onChange={(hideSignedOut) => update((current) => ({ ...current, hideSignedOut }))}
          hint="Hides tools that are installed but have no account, like an OpenCode you never set up. Expired sessions still show."
        >
          Hide providers you’re not signed in to
        </Toggle>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">Providers and gauges</h3>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {snapshot.data === null
              ? (snapshot.error ?? "Loading providers…")
              : "No provider reports usage on this machine."}
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {rows.map((row) => {
              const providerShown = !prefs.hiddenProviders.includes(row.id);
              const signedOutHidden =
                prefs.hideSignedOut && row.usage.status === "unauthenticated";
              return (
                <li key={row.id} className="flex flex-col gap-2 px-4 py-3">
                  <Toggle
                    checked={providerShown}
                    onChange={(shown) =>
                      update((current) => ({
                        ...current,
                        hiddenProviders: toggleIn(current.hiddenProviders, row.id, !shown),
                      }))
                    }
                    hint={
                      signedOutHidden
                        ? "Not signed in, hidden by the option above."
                        : (row.message ?? undefined)
                    }
                  >
                    <ProviderIcon
                      providerKind="agent"
                      provider={row.provider}
                      fallback="Bot"
                      className="size-4"
                      aria-hidden
                    />
                    {row.provider.displayName}
                  </Toggle>
                  {row.windows.length === 0 ? null : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
                      {row.windows.map((window) => {
                        const key = windowKey(row.id, window.label);
                        return (
                          <Toggle
                            key={key}
                            checked={!prefs.hiddenWindows.includes(key)}
                            disabled={!providerShown}
                            onChange={(shown) =>
                              update((current) => ({
                                ...current,
                                hiddenWindows: toggleIn(current.hiddenWindows, key, !shown),
                              }))
                            }
                          >
                            {shortWindowLabel(window) === window.label ? null : (
                              <span className="text-muted-foreground">{shortWindowLabel(window)}</span>
                            )}
                            {window.label}
                          </Toggle>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Gauges only appear here once the provider has reported them. Settings sync across your BB windows.
        </p>
      </div>
    </div>
  );
}
