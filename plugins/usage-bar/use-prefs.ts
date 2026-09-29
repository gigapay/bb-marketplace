import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { DEFAULT_PREFS, type UsagePrefs } from "./prefs";

const CACHE_KEY = "bb.usage-bar.prefs.v1";

// Cached locally so the card renders filtered on first paint; the server copy wins once loaded.
let prefs: UsagePrefs = readCache();
let loaded = false;
const listeners = new Set<() => void>();

function readCache(): UsagePrefs {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw === null ? DEFAULT_PREFS : { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function store(next: UsagePrefs): void {
  prefs = next;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isPrefs(value: unknown): value is UsagePrefs {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "compact") === "boolean" &&
    Array.isArray(Reflect.get(value, "hiddenProviders")) &&
    Array.isArray(Reflect.get(value, "hiddenWindows"))
  );
}

export function usePrefs(): [UsagePrefs, (update: (current: UsagePrefs) => UsagePrefs) => void] {
  const rpc = useRpc<typeof rpcContract>();
  const current = useSyncExternalStore(subscribe, () => prefs, () => prefs);

  useEffect(() => {
    if (loaded) return;
    loaded = true;
    rpc.call("prefs_get", null).then(store, (cause: unknown) => {
      loaded = false;
      console.warn("[usage-bar] prefs load failed", cause);
    });
  }, [rpc]);

  useRealtime("prefs-changed", (payload) => {
    if (isPrefs(payload)) store({ ...DEFAULT_PREFS, ...payload });
  });

  const update = useCallback(
    (change: (current: UsagePrefs) => UsagePrefs) => {
      const next = change(prefs);
      store(next);
      rpc.call("prefs_set", next).catch((cause: unknown) => {
        console.warn("[usage-bar] prefs save failed", cause);
      });
    },
    [rpc],
  );

  return [current, update];
}

export function toggleIn(list: readonly string[], value: string, hidden: boolean): string[] {
  const rest = list.filter((item) => item !== value);
  return hidden ? [...rest, value] : rest;
}
