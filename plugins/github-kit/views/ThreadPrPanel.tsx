// The thread side-panel tab: the pull request for the thread's branch.
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { parsePrKey, prKey } from "../shared/pr-ref";
import { PullRequestDetail } from "./PullRequestDetail";
import { EmptyState, ErrorLine } from "./shared";
import { useThreadPrKey } from "./useThreadPr";

export const THREAD_PANEL_ACTION_ID = "pull-request";

export function ThreadPrPanel({ threadId, params }: PluginThreadPanelProps) {
  const state = useThreadPrKey(threadId);
  // A tab opened for a specific PR keeps showing it.
  const pinned =
    typeof params === "object" && params !== null && !Array.isArray(params) && typeof params.key === "string"
      ? parsePrKey(params.key)
      : null;
  const key = pinned !== null ? prKey(pinned) : state.status === "found" ? state.key : null;

  if (key !== null) return <PullRequestDetail key={key} prKey={key} threadId={threadId} />;
  if (state.status === "error") return <ErrorLine error={state.error} />;
  if (state.status === "loading") return <EmptyState>Looking for this thread's pull request…</EmptyState>;
  return (
    <EmptyState>
      {state.status === "none" && state.branch !== null ? `No pull request for ${state.branch} yet.` : "This thread has no branch yet."}
    </EmptyState>
  );
}
