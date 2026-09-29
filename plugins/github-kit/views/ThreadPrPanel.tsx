// The thread side-panel tab: the pull request for the thread's branch.
// BB's own lookup (`gh pr view` in the worktree) comes first; when it finds
// nothing, for example because the branch tracks the base branch, the server
// searches GitHub for a PR whose head is that branch.
import { useEffect, useState } from "react";
import {
  experimental_useSidebarThreadPullRequest as useThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { parsePrKey, parsePrUrl, prKey } from "../shared/pr-ref";
import { PullRequestDetail } from "./PullRequestDetail";
import { EmptyState, ErrorLine, errorText } from "./shared";

export const THREAD_PANEL_ACTION_ID = "pull-request";

export function ThreadPrPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const core = useThreadPullRequest(threadId);
  const { threads, status } = useSidebarThreads();
  const branch = threads.find((thread) => thread.id === threadId)?.environment?.branchName ?? null;
  // A tab opened for a specific PR keeps showing it.
  const pinned = typeof params === "object" && params !== null && !Array.isArray(params) && typeof params.key === "string"
    ? parsePrKey(params.key)
    : null;
  const fromCore = core.pullRequest ? parsePrUrl(core.pullRequest.url) : null;
  const [fallback, setFallback] = useState<{ branch: string; key: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsFallback = pinned === null && fromCore === null && !core.isLoading && branch !== null;
  useEffect(() => {
    if (!needsFallback || fallback?.branch === branch) return;
    let cancelled = false;
    rpc.call("pr_for_branch", { branch }).then(
      ({ key }) => !cancelled && setFallback({ branch, key }),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, needsFallback, branch, fallback?.branch]);

  const ref = pinned ?? fromCore ?? (fallback?.branch === branch && fallback.key ? parsePrKey(fallback.key) : null);
  if (ref !== null) return <PullRequestDetail key={prKey(ref)} prKey={prKey(ref)} threadId={threadId} />;
  if (error !== null) return <ErrorLine error={error} />;
  if (core.isLoading || status === "loading" || (needsFallback && fallback?.branch !== branch)) {
    return <EmptyState>Looking for this thread's pull request…</EmptyState>;
  }
  return (
    <EmptyState>
      {branch === null ? "This thread has no branch yet." : `No pull request for ${branch} yet.`}
    </EmptyState>
  );
}
