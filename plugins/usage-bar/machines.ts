import { useEffect, useState } from "react";
import { experimental_useSidebarThreads, useBbContext, useSdk } from "@get-bb/plugin-sdk/app";
import { PRIMARY_MACHINE, THREAD_MACHINE, type UsagePrefs } from "./prefs";

export interface Machine {
  id: string;
  name: string;
  connected: boolean;
  primary: boolean;
}

/** Persistent machines for the settings picker, primary first. */
export function useMachines(): Machine[] | null {
  const sdk = useSdk();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([sdk.hosts.list(), sdk.system.config().catch(() => null)]).then(
      ([hosts, config]) => {
        if (cancelled) return;
        const primaryId = config?.primaryHostId ?? null;
        setMachines(
          hosts
            .filter((host) => host.type !== "ephemeral")
            .map((host) => ({
              id: host.id,
              name: host.name,
              connected: host.status === "connected",
              primary: host.id === primaryId,
            }))
            .sort((a, b) => Number(b.primary) - Number(a.primary)),
        );
      },
      (cause: unknown) => {
        console.warn("[usage-bar] machine list failed", cause);
        if (!cancelled) setMachines([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);
  return machines;
}

/**
 * The machine the card should read. `hostId` null means BB's primary machine
 * (the server picks it), which is also the fallback when following a thread
 * that has no machine yet or when no thread is open.
 */
export function useUsageMachine(prefs: UsagePrefs): { hostId: string | null; name: string | null } {
  const { threadId } = useBbContext();
  const { threads, experimental_hosts: hosts } = experimental_useSidebarThreads();
  if (prefs.machine === PRIMARY_MACHINE) return { hostId: null, name: null };
  if (prefs.machine === THREAD_MACHINE) {
    const host = threads.find((thread) => thread.id === threadId)?.host ?? null;
    return host === null ? { hostId: null, name: null } : { hostId: host.id, name: host.name };
  }
  return {
    hostId: prefs.machine,
    name: hosts?.find((host) => host.id === prefs.machine)?.name ?? null,
  };
}
