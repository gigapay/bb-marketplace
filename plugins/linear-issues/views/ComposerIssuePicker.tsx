import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalComposerSelection, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { buildIssuePrompt } from "@/lib/prompt";
import type { IssueDetail, rpcContract } from "../server";
import { LINKED_ISSUE_PREFIX, linkedIssueFromPrompt } from "../shared/links";
import { IssuePickerDialog } from "./pickers";
import { errorText } from "./shared";

// Registered by this plugin's server (worktree/provider.ts).
const LINEAR_WORKTREE_PROVIDER_ID = "linear-worktree";

// The `+` menu row runs outside React; it asks the mounted action to open
// its picker. Only the root new-thread composer mounts this action.
const openRequests = new Set<() => void>();
export function requestIssuePicker(): void {
  for (const open of openRequests) open();
}

/** Text the user typed around a previously inserted ticket, kept on re-pick. */
function userNotes(draft: string): string {
  if (linkedIssueFromPrompt(draft) === null) return draft;
  const lines = draft.split("\n");
  const markerIndex = lines.findIndex((line) => line.startsWith(LINKED_ISSUE_PREFIX));
  return lines.slice(1, markerIndex).join("\n").trim();
}

type Environment = NonNullable<ExperimentalComposerSelection["environment"]>;

function hostIdOf(environment: Environment | undefined): string | null {
  if (environment?.type === "provider" && environment.machine?.type === "existing") {
    return environment.machine.hostId;
  }
  if (environment?.type === "host") return environment.hostId ?? null;
  return null;
}

/**
 * Switches to a Linear worktree on the machine already selected. It branches
 * off the project's primary branch and names the branch after the ticket.
 */
async function ensureWorktree(composer: PluginComposerApi): Promise<void> {
  const current = await composer.experimental_setSelection({});
  const environment = current.environment;
  if (environment?.type === "provider" && environment.environmentProviderId === LINEAR_WORKTREE_PROVIDER_ID) {
    return;
  }
  const hostId = hostIdOf(environment);
  if (hostId === null) {
    toast.info("Pick the Linear worktree environment so the thread gets the ticket's branch.");
    return;
  }
  const next = await composer.experimental_setSelection({
    environment: {
      type: "provider",
      environmentProviderId: LINEAR_WORKTREE_PROVIDER_ID,
      machine: { type: "existing", hostId },
      inputs: {},
    },
  });
  if (next.environment?.type !== "provider" || next.environment.environmentProviderId !== LINEAR_WORKTREE_PROVIDER_ID) {
    toast.info("Couldn't switch to a worktree here. Pick the environment by hand.");
  }
}

export function ComposerIssuePicker() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const { projects } = useSidebarThreads();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const request = () => setOpen(true);
    openRequests.add(request);
    return () => {
      openRequests.delete(request);
    };
  }, []);

  if (view.scope.kind !== "new-thread") return null;
  const projectId = view.scope.projectId;
  const isPersonal = projects.find((project) => project.id === projectId)?.isPersonal ?? false;
  const current = linkedIssueFromPrompt(view.draft.text);

  const pick = async (identifier: string) => {
    setOpen(false);
    setLoading(true);
    try {
      const issue: IssueDetail = await rpc.call("issue_get", { id: identifier });
      // Worktree first: switching environments can remount this surface, and
      // the draft survives that while local state would not.
      if (!isPersonal) await ensureWorktree(composer);
      composer.setText(buildIssuePrompt(issue, userNotes(composer.text)));
      composer.focus();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-muted-foreground"
        aria-label={current ? `Linear issue ${current}, change` : "Start from a Linear issue"}
        disabled={loading}
        onClick={() => setOpen(true)}
      >
        <Icon name={loading ? "LoaderCircle" : "linear-issues/linear"} className={loading ? "size-4 animate-spin" : "size-4"} />
        <span className="font-mono text-xs">{current ?? "Linear"}</span>
      </Button>
      <IssuePickerDialog open={open} onOpenChange={setOpen} onPick={(issue) => void pick(issue.identifier)} />
    </>
  );
}
