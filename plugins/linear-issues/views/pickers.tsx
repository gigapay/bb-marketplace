import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { IssueSummary, rpcContract } from "../server";
import { EmptyState, ErrorLine, StateIcon, errorText, relativeTime, useDebounced } from "./shared";

/** Search Linear and pick one issue. Empty query lists your open assigned issues. */
export function IssuePickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (issue: IssueSummary) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const request =
      query === ""
        ? { scope: "assigned" as const, includeCompleted: false, query }
        : { scope: "all" as const, includeCompleted: true, query };
    rpc.call("issues_list", request).then(
      (result) => !cancelled && (setIssues(result.issues.slice(0, 30)), setError(null)),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, open, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a Linear issue</DialogTitle>
          <DialogDescription>Search by title, or pick one of your open issues.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search all issues"
          aria-label="Search issues"
        />
        <ErrorLine error={error} />
        <div className="max-h-80 overflow-y-auto">
          {issues === null ? (
            <EmptyState>Loading…</EmptyState>
          ) : issues.length === 0 ? (
            <EmptyState>No matching issues.</EmptyState>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {issues.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    onClick={() => onPick(issue)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                  >
                    <StateIcon state={issue.state} />
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                      {issue.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pick one of your active BB threads, filtered by title or branch. */
export function ThreadPickerDialog({
  open,
  onOpenChange,
  threads,
  projectName,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: readonly PluginSidebarThread[];
  projectName: (projectId: string) => string | null;
  onPick: (thread: PluginSidebarThread) => void;
}) {
  const [search, setSearch] = useState("");
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return threads
      .filter((thread) => !thread.isHidden)
      .filter(
        (thread) =>
          needle === "" ||
          thread.displayTitle.toLowerCase().includes(needle) ||
          (thread.environment?.branchName ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  }, [threads, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link a thread</DialogTitle>
          <DialogDescription>Pick the BB thread that works on this issue.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter by title or branch"
          aria-label="Filter threads"
        />
        <div className="max-h-80 overflow-y-auto">
          {visible.length === 0 ? (
            <EmptyState>No threads to link.</EmptyState>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visible.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => onPick(thread)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent/50"
                  >
                    <span className="truncate">{thread.displayTitle}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{projectName(thread.projectId) ?? "Unknown project"}</span>
                      {thread.environment?.branchName ? (
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                          <Icon name="GitBranch" className="size-3 shrink-0" />
                          <span className="truncate">{thread.environment.branchName}</span>
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0">{relativeTime(new Date(thread.updatedAt).toISOString())}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
