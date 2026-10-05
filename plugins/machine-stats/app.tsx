// Machine card in the sidebar footer, next to Usage Bar, for the machine
// running the open thread (or the server). Usage is the hub (bars, charts, top
// processes); Processes, Disk and Slugs are the details.
import { useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { DiskUsage } from "./disk-card";
import { ProcessList } from "./processes-card";
import { TraefikStacks } from "./stacks-card";
import { MachineStats } from "./stats-card";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "usage", label: "Usage" },
  { id: "processes", label: "Processes" },
  { id: "disk", label: "Disk" },
  { id: "slugs", label: "Slugs" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const TAB_KEY = "machine-stats:tab";

/** The open thread's machine, or null (the server machine) when there's none. */
function useSelectedMachine(): { hostId: string | null; name: string | null } {
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const host = threads.find((thread) => thread.id === threadId)?.host ?? null;
  return host === null ? { hostId: null, name: null } : { hostId: host.id, name: host.name };
}

function MachineCard() {
  const machine = useSelectedMachine();
  // Only the open tab is mounted, so only it polls.
  const [tab, setTab] = useState<TabId>(() => {
    const saved = window.localStorage.getItem(TAB_KEY);
    return TABS.find((t) => t.id === saved)?.id ?? "usage";
  });
  const choose = (next: TabId) => {
    setTab(next);
    window.localStorage.setItem(TAB_KEY, next);
  };

  return (
    <div className="flex flex-col">
      <div role="tablist" className="flex gap-0.5 border-b border-sidebar-border px-1.5 pt-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => choose(t.id)}
            className={cn(
              "-mb-px border-b-2 px-1.5 pb-1 text-2xs font-medium leading-4",
              tab === t.id
                ? "border-primary text-sidebar-foreground"
                : "border-transparent text-subtle-foreground hover:text-sidebar-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "usage" ? (
        <MachineStats
          hostId={machine.hostId}
          machineName={machine.name}
          onShowProcesses={() => choose("processes")}
        />
      ) : null}
      {tab === "processes" ? <ProcessList hostId={machine.hostId} /> : null}
      {tab === "disk" ? <DiskUsage hostId={machine.hostId} /> : null}
      {tab === "slugs" ? <TraefikStacks hostId={machine.hostId} /> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "machine-stats",
    label: "Machine",
    icon: "machine-stats/server",
    component: MachineCard,
  });
});
