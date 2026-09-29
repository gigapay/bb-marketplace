import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { StoredLink, rpcContract } from "../server";
import { LINKS_CHANGED, resolveLink, type LinkSource } from "../shared/links";

export type LinkedThread = { thread: PluginSidebarThread; source: LinkSource };

/**
 * Every thread ↔ issue link, resolved from stored rows plus worktree branch
 * names. Mount it wherever links show; each instance follows the realtime
 * signal so a link made anywhere shows up everywhere.
 */
export function useIssueLinks() {
  const rpc = useRpc<typeof rpcContract>();
  const { threads, projects, status } = useSidebarThreads();
  const [stored, setStored] = useState<{ links: StoredLink[]; teamKeys: string[] } | null>(null);

  const refetch = useCallback(() => {
    // A failed fetch keeps the last good state; links are secondary UI.
    rpc.call("links_list").then(setStored, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(LINKS_CHANGED, refetch);

  const resolved = useMemo(() => {
    const rows = new Map((stored?.links ?? []).map((link) => [link.threadId, link]));
    const teamKeys = new Set(stored?.teamKeys ?? []);
    const byThread = new Map<string, { identifier: string; source: LinkSource }>();
    const byIssue = new Map<string, LinkedThread[]>();
    for (const thread of threads) {
      if (thread.isHidden) continue;
      const link = resolveLink(rows.get(thread.id), thread.environment?.branchName, teamKeys);
      if (link === null) continue;
      byThread.set(thread.id, link);
      const list = byIssue.get(link.identifier) ?? [];
      list.push({ thread, source: link.source });
      byIssue.set(link.identifier, list);
    }
    return { byThread, byIssue, rows, teamKeys };
  }, [stored, threads]);

  const projectName = useCallback(
    (projectId: string) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      return project === undefined ? null : project.isPersonal ? "No project" : project.name;
    },
    [projects],
  );

  return {
    ready: stored !== null && status !== "loading",
    threads,
    projectName,
    ...resolved,
  };
}

export const SOURCE_LABELS: Record<LinkSource, string> = {
  spawn: "Started from issue",
  manual: "Linked manually",
  branch: "Matched from branch",
};
