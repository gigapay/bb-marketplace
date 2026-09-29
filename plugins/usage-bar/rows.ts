import { useMemo } from "react";
import { experimental_useProviders } from "@get-bb/plugin-sdk/app";
import type { ProviderUsage, UsageLimits, UsageWindow } from "./usage";

type ProviderInfo = ReturnType<typeof experimental_useProviders>["providers"][number];

export interface UsageRow {
  id: string;
  provider: ProviderInfo | { id: string; displayName: string };
  usage: ProviderUsage;
  windows: UsageWindow[];
  /** One-line status shown instead of bars; null when there are bars to show. */
  message: string | null;
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

/** Every installed provider in BB's picker order, unfiltered by prefs. */
export function useUsageRows(data: UsageLimits | null): UsageRow[] {
  const { providers } = experimental_useProviders();
  return useMemo(() => {
    const order = new Map(providers.map((provider, index) => [provider.id, index]));
    return Object.entries(data ?? {})
      .filter(([, usage]) => usage.status !== "not_installed")
      .sort(
        ([a], [b]) =>
          (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(([id, usage]) => ({
        id,
        usage,
        provider: providers.find((provider) => provider.id === id) ?? { id, displayName: id },
        windows: usage.status === "ok" ? usage.windows : [],
        message: statusMessage(usage),
      }));
  }, [data, providers]);
}
