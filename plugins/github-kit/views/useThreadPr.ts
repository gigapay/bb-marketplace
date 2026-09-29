// Finds the pull request for a thread's branch, and caches PR details so the
// thread tab and every diff file card share one GitHub request.
import { useEffect, useState } from "react";
import {
  experimental_useSidebarThreadPullRequest as useThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PrDetail } from "../detail";
import type { rpcContract } from "../server";
import { parsePrKey, parsePrUrl, prKey } from "../shared/pr-ref";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export type ThreadPrState =
  | { status: "loading" }
  | { status: "none"; branch: string | null }
  | { status: "error"; error: string }
  | { status: "found"; key: string };

const branchLookups = new Map<string, Promise<string | null>>();

/**
 * BB's own lookup (`gh pr view` in the worktree) first. When it finds
 * nothing, for example because the branch tracks the base branch, the server
 * searches GitHub for a PR whose head is that branch.
 */
export function useThreadPrKey(threadId: string | null): ThreadPrState {
  const rpc = useRpc<typeof rpcContract>();
  const core = useThreadPullRequest(threadId ?? "");
  const { threads, status } = useSidebarThreads();
  const branch = threads.find((thread) => thread.id === threadId)?.environment?.branchName ?? null;
  const fromCore = core.pullRequest ? parsePrUrl(core.pullRequest.url) : null;
  const [fallback, setFallback] = useState<{ branch: string; key: string | null } | { branch: string; error: string } | null>(null);

  const needsFallback = threadId !== null && fromCore === null && !core.isLoading && branch !== null;
  useEffect(() => {
    if (!needsFallback || fallback?.branch === branch) return;
    let cancelled = false;
    let lookup = branchLookups.get(branch);
    if (lookup === undefined) {
      lookup = rpc.call("pr_for_branch", { branch }).then(({ key }) => key);
      branchLookups.set(branch, lookup);
      // Forget it after a minute so a PR opened later shows up.
      setTimeout(() => branchLookups.delete(branch), 60_000);
    }
    lookup.then(
      (key) => !cancelled && setFallback({ branch, key }),
      (cause) => {
        branchLookups.delete(branch);
        if (!cancelled) setFallback({ branch, error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, needsFallback, branch, fallback?.branch]);

  if (threadId === null) return { status: "none", branch: null };
  if (fromCore !== null) return { status: "found", key: prKey(fromCore) };
  if (core.isLoading || status === "loading") return { status: "loading" };
  if (branch === null) return { status: "none", branch: null };
  if (fallback?.branch !== branch) return { status: "loading" };
  if ("error" in fallback) return { status: "error", error: fallback.error };
  const ref = fallback.key === null ? null : parsePrKey(fallback.key);
  return ref === null ? { status: "none", branch } : { status: "found", key: prKey(ref) };
}

const detailCache = new Map<string, { promise: Promise<PrDetail>; at: number }>();
const DETAIL_TTL_MS = 60_000;

export function fetchPrDetail(rpc: Rpc, key: string, force = false): Promise<PrDetail> {
  const cached = detailCache.get(key);
  if (!force && cached !== undefined && Date.now() - cached.at < DETAIL_TTL_MS) return cached.promise;
  const promise = rpc.call("pr_get", { key });
  detailCache.set(key, { promise, at: Date.now() });
  promise.catch(() => detailCache.delete(key));
  return promise;
}

/** The cached PR detail, or null while loading, when missing, or on error. */
export function usePrDetail(key: string | null): PrDetail | null {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<PrDetail | null>(null);
  useEffect(() => {
    if (key === null) return setDetail(null);
    let cancelled = false;
    fetchPrDetail(rpc, key).then(
      (next) => !cancelled && setDetail(next),
      () => !cancelled && setDetail(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, key]);
  return detail;
}
