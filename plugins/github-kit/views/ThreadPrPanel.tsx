// The thread side-panel tab: the PR linked to the thread (a manual link, or
// its branch's PR), with Change / Unlink, or a picker when there's none.
import { useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../server";
import { parsePrKey, prKey } from "../shared/pr-ref";
import { PrLinkPicker } from "./PrLinkPicker";
import { PullRequestDetail } from "./PullRequestDetail";
import { EmptyState, ErrorLine, errorText } from "./shared";
import { useThreadPrKey } from "./useThreadPr";

export const THREAD_PANEL_ACTION_ID = "pull-request";

export function ThreadPrPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const state = useThreadPrKey(threadId);
  const [picking, setPicking] = useState(false);
  // A tab opened for a specific PR keeps showing it.
  const pinned =
    typeof params === "object" && params !== null && !Array.isArray(params) && typeof params.key === "string"
      ? parsePrKey(params.key)
      : null;
  const key = pinned !== null ? prKey(pinned) : state.status === "found" ? state.key : null;

  const run = (promise: Promise<unknown>, message: string) =>
    promise.then(
      () => {
        toast.success(message);
        setPicking(false);
      },
      (cause) => toast.error(errorText(cause)),
    );
  const link = (picked: string) => void run(rpc.call("link_set", { threadId, key: picked }), `Linked to ${picked}`);

  const picker = <PrLinkPicker onPick={link} onCancel={key !== null ? () => setPicking(false) : undefined} />;

  if (key !== null) {
    const source = pinned === null && state.status === "found" ? state.source : null;
    return (
      <div className="space-y-3">
        {pinned === null ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{source === "manual" ? "Linked manually" : "From this thread's branch"}</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setPicking((value) => !value)}>
              <Icon name="Search" className="size-3.5" />
              Change
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => void run(rpc.call("link_set", { threadId, key: null }), "Unlinked")}>
              <Icon name="X" className="size-3.5" />
              Unlink
            </Button>
            {source === "manual" ? (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => void run(rpc.call("link_reset", { threadId }), "Back to the branch's PR")}>
                Use branch
              </Button>
            ) : null}
          </div>
        ) : null}
        {picking ? picker : null}
        <PullRequestDetail key={key} prKey={key} threadId={threadId} />
      </div>
    );
  }
  if (state.status === "error") return <ErrorLine error={state.error} />;
  if (state.status === "loading") return <EmptyState>Looking for this thread's pull request…</EmptyState>;
  if (state.status !== "none") return null;
  return (
    <div className="space-y-3">
      <EmptyState>
        {state.unlinked
          ? "This thread was unlinked from its pull request."
          : state.branch !== null
            ? `No pull request for ${state.branch} yet. Link one below.`
            : "This thread has no branch. Link a pull request below."}
      </EmptyState>
      {state.unlinked ? (
        <Button size="sm" variant="outline" onClick={() => void run(rpc.call("link_reset", { threadId }), "Back to the branch's PR")}>
          Use the branch's PR again
        </Button>
      ) : null}
      {picker}
    </div>
  );
}
