// Finds the pull request for a thread's branch, and caches PR details so the
// thread tab and every diff file card share one GitHub request.
import { useCallback, useEffect, useState } from "react";
import {
  experimental_useSidebarThreadPullRequest as useThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PrDetail } from "../detail";
import type { rpcContract } from "../server";
import { LINKS_CHANGED, parsePrKey, parsePrUrl, prKey } from "../shared/pr-ref";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export type LinkSource = "manual" | "branch";

export type ThreadPrState =
  | { status: "loading" }
  | { status: "none"; branch: string | null; unlinked: boolean }
  | { status: "error"; error: string }
  | { status: "found"; key: string; source: LinkSource };

/** The thread's stored link, kept live across every view through realtime. */
export function useStoredLink(threadId: string | null): { stored: boolean; key: string | null } | null {
  const rpc = useRpc<typeof rpcContract>();
  const [link, setLink] = useState<{ threadId: string; stored: boolean; key: string | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  useRealtime(LINKS_CHANGED, (payload) => {
    if (typeof payload === "object" && payload !== null && (payload as { threadId?: unknown }).threadId === threadId) {
      setNonce((value) => value + 1);
    }
  });
  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    rpc.call("link_get", { threadId }).then(
      (result) => !cancelled && setLink({ threadId, ...result }),
      // Links are secondary: on failure fall back to the branch.
      () => !cancelled && setLink({ threadId, stored: false, key: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, nonce]);
  return link !== null && link.threadId === threadId ? link : null;
}

const branchLookups = new Map<string, Promise<string | null>>();

/**
 * BB's own lookup (`gh pr view` in the worktree) first. When it finds
 * nothing, for example because the branch tracks the base branch, the server
 * searches GitHub for a PR whose head is that branch.
 */
export function useThreadPrKey(threadId: string | null): ThreadPrState {
  const rpc = useRpc<typeof rpcContract>();
  const stored = useStoredLink(threadId);
  const core = useThreadPullRequest(threadId ?? "");
  const { threads, status } = useSidebarThreads();
  const branch = threads.find((thread) => thread.id === threadId)?.environment?.branchName ?? null;
  const fromCore = core.pullRequest ? parsePrUrl(core.pullRequest.url) : null;
  const [fallback, setFallback] = useState<{ branch: string; key: string | null } | { branch: string; error: string } | null>(null);

  const needsFallback = threadId !== null && stored !== null && !stored.stored && fromCore === null && !core.isLoading && branch !== null;
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

  if (threadId === null) return { status: "none", branch: null, unlinked: false };
  // A manual link (or unlink) wins over anything the branch says.
  if (stored === null) return { status: "loading" };
  if (stored.stored) {
    const ref = stored.key === null ? null : parsePrKey(stored.key);
    return ref === null ? { status: "none", branch, unlinked: true } : { status: "found", key: prKey(ref), source: "manual" };
  }
  if (fromCore !== null) return { status: "found", key: prKey(fromCore), source: "branch" };
  if (core.isLoading || status === "loading") return { status: "loading" };
  if (branch === null) return { status: "none", branch: null, unlinked: false };
  if (fallback?.branch !== branch) return { status: "loading" };
  if ("error" in fallback) return { status: "error", error: fallback.error };
  const ref = fallback.key === null ? null : parsePrKey(fallback.key);
  return ref === null ? { status: "none", branch, unlinked: false } : { status: "found", key: prKey(ref), source: "branch" };
}

// One entry per PR, shared by the tab and every diff file card. A refresh
// after resolving or replying reaches all of them at once.
type Entry = { promise: Promise<PrDetail>; at: number; value: PrDetail | null; error: string | null };
const detailCache = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const DETAIL_TTL_MS = 60_000;

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function fetchPrDetail(rpc: Rpc, key: string, force = false): Promise<PrDetail> {
  const cached = detailCache.get(key);
  if (!force && cached !== undefined && Date.now() - cached.at < DETAIL_TTL_MS) return cached.promise;
  const promise = rpc.call("pr_get", { key });
  const entry: Entry = { promise, at: Date.now(), value: cached?.value ?? null, error: null };
  detailCache.set(key, entry);
  promise.then(
    (value) => {
      entry.value = value;
      notify(key);
    },
    (cause) => {
      detailCache.delete(key);
      entry.error = cause instanceof Error ? cause.message : String(cause);
      notify(key);
    },
  );
  return promise;
}

export type PrDetailState = {
  detail: PrDetail | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

/** The shared PR detail; `refresh` refetches for every subscriber. */
export function usePrDetail(key: string | null): PrDetailState {
  const rpc = useRpc<typeof rpcContract>();
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (key === null) return;
    const listener = () => bump((value) => value + 1);
    const set = listeners.get(key) ?? new Set();
    set.add(listener);
    listeners.set(key, set);
    setLoading(true);
    fetchPrDetail(rpc, key).then(
      () => {
        setError(null);
        setLoading(false);
      },
      (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => {
      set.delete(listener);
    };
  }, [rpc, key]);

  const refresh = useCallback(async () => {
    if (key === null) return;
    setLoading(true);
    try {
      await fetchPrDetail(rpc, key, true);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [rpc, key]);

  return { detail: key === null ? null : (detailCache.get(key)?.value ?? null), error, loading, refresh };
}
