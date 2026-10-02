// Machine card in the sidebar footer, next to Usage Bar: live CPU, RAM and
// disk usage, then the staging slugs and Traefik services, for the machine
// running the open thread (or the server).
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbContext,
} from "@get-bb/plugin-sdk/app";
import { TraefikStacks } from "./stacks-card";
import { MachineStats } from "./stats-card";

/** The open thread's machine, or null (the server machine) when there's none. */
function useSelectedMachine(): { hostId: string | null; name: string | null } {
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const host = threads.find((thread) => thread.id === threadId)?.host ?? null;
  return host === null ? { hostId: null, name: null } : { hostId: host.id, name: host.name };
}

function MachineCard() {
  const machine = useSelectedMachine();
  return (
    <div className="flex flex-col">
      <MachineStats hostId={machine.hostId} machineName={machine.name} />
      <div className="border-t border-sidebar-border">
        <TraefikStacks hostId={machine.hostId} />
      </div>
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
