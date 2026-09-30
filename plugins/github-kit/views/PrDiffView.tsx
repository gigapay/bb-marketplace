// The PR "Diff" tab, after Linear's PR review: a file tree grouped into
// Implementation / Tests / Documentation, file cards with a "Reviewed"
// checkbox (GitHub's Viewed state), a commit range picker, and inline review
// comments filtered by who wrote them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UrlLink, experimental_useSidebarThreads as useSidebarThreads, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FeedItem, PrDetail } from "../detail";
import { fileGroup, type DiffFile, type DiffRange, type FileGroup, type PrDiff } from "../diff";
import type { rpcContract } from "../server";
import { toGitPatch } from "../shared/patch";
import { AnnotatedDiff } from "./DiffWithComments";
import { EmptyState, ErrorLine, errorText, relativeTime } from "./shared";

type CommentFilter = "all" | "humans" | "bots" | "none";
const COMMENT_FILTERS: { id: CommentFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "humans", label: "Comments" },
  { id: "bots", label: "Agents & bots" },
  { id: "none", label: "Hide" },
];
const GROUPS: FileGroup[] = ["Implementation", "Tests", "Documentation"];

function rangeValue(range: DiffRange): string {
  return range.kind === "commit" ? `commit:${range.sha}` : range.kind;
}

function parseRange(value: string): DiffRange {
  if (value.startsWith("commit:")) return { kind: "commit", sha: value.slice("commit:".length) };
  return value === "since-review" ? { kind: "since-review" } : { kind: "all" };
}

function fileId(path: string): string {
  return `github-kit-file-${encodeURIComponent(path)}`;
}

// Linear's palette: indigo for reviewed, orange for changed since your review.
const REVIEWED_CLASS = "text-indigo-400";
const UPDATED_DOT_CLASS = "bg-orange-400";

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  return index === -1 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index + 1) };
}

export function PrDiffView({
  pr,
  threadId,
  onChanged,
  compact,
}: {
  pr: PrDetail;
  threadId: string | null;
  onChanged: () => Promise<void>;
  /** The thread side panel is narrow: the file tree starts hidden there. */
  compact: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [range, setRange] = useState<DiffRange>({ kind: "all" });
  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [comments, setComments] = useState<CommentFilter>("all");
  const [showTree, setShowTree] = useState(!compact);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<FileGroup>>(new Set());
  const toggleGroup = (group: FileGroup) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const [view, setView] = useState<"unified" | "split">(compact ? "unified" : "split");
  // Viewed files start collapsed, like on GitHub; the user's clicks win.
  const [expandedOverride, setExpandedOverride] = useState<Map<string, boolean>>(new Map());
  const [viewedOverride, setViewedOverride] = useState<Map<string, boolean>>(new Map());

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call("pr_diff", { key: pr.key, range }).then(
      (next) => {
        if (cancelled) return;
        setDiff(next);
        setViewedOverride(new Map());
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(errorText(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, pr.key, range]);
  useEffect(() => load(), [load]);

  // Agent notes go to this thread, or the first one working on the PR's branch.
  const { threads: sidebarThreads } = useSidebarThreads();
  const agentThreadId =
    threadId ??
    sidebarThreads.find((thread) => !thread.isHidden && !thread.isArchived && thread.environment?.branchName === pr.headRefName)?.id ??
    null;
  // Line comments anchor on the head commit, so only the full diff takes them.
  const canComment = range.kind === "all" && pr.state === "OPEN";

  // Changed after you reviewed it: GitHub un-views a file that moves after
  // you ticked it (DISMISSED), and your last review's compare covers the rest.
  const changedSinceReview = useMemo(() => new Set(diff?.changedSinceReview ?? []), [diff]);
  const isUpdated = (file: DiffFile) => !isViewed(file) && (file.viewed === "DISMISSED" || changedSinceReview.has(file.path));

  const isViewed = (file: DiffFile) => viewedOverride.get(file.path) ?? file.viewed === "VIEWED";
  const isExpanded = (file: DiffFile) => expandedOverride.get(file.path) ?? !isViewed(file);

  // Review threads only line up with the head commit, so they show on the full diff.
  const threadsByPath = useMemo(() => {
    const map = new Map<string, FeedItem[]>();
    if (range.kind !== "all" || comments === "none") return map;
    for (const item of pr.feed) {
      if (item.kind !== "thread" || item.isOutdated || item.line === null || item.path === null) continue;
      const isBot = item.author?.isBot ?? false;
      if ((comments === "humans" && isBot) || (comments === "bots" && !isBot)) continue;
      map.set(item.path, [...(map.get(item.path) ?? []), item]);
    }
    return map;
  }, [pr.feed, range.kind, comments]);
  const openThreadPaths = useMemo(
    () => new Set(pr.feed.filter((item) => item.kind === "thread" && !item.isResolved && item.path).map((item) => item.path!)),
    [pr.feed],
  );

  const files = diff?.files ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = files.filter((file) => needle === "" || file.path.toLowerCase().includes(needle));
  const grouped = GROUPS.map((group) => ({ group, files: shown.filter((file) => fileGroup(file.path) === group) })).filter(
    (entry) => entry.files.length > 0,
  );
  const ordered = grouped.flatMap((entry) => entry.files);
  const reviewedCount = files.filter(isViewed).length;

  const setViewed = (file: DiffFile, viewed: boolean) => {
    setViewedOverride((current) => new Map(current).set(file.path, viewed));
    // Checking a file folds it away; unchecking opens it again.
    setExpandedOverride((current) => new Map(current).set(file.path, !viewed));
    rpc.call("file_viewed", { key: pr.key, path: file.path, viewed }).catch((cause) => {
      toast.error(errorText(cause));
      setViewedOverride((current) => new Map(current).set(file.path, !viewed));
    });
  };
  const toggleExpanded = (file: DiffFile) =>
    setExpandedOverride((current) => new Map(current).set(file.path, !isExpanded(file)));
  const setAllExpanded = (expanded: boolean) => setExpandedOverride(new Map(files.map((file) => [file.path, expanded])));
  const jumpTo = (file: DiffFile) => {
    setExpandedOverride((current) => new Map(current).set(file.path, true));
    requestAnimationFrame(() => document.getElementById(fileId(file.path))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const commits = diff?.commits ?? [];
  const sinceReviewCount =
    diff?.lastReviewSha == null ? 0 : commits.length - 1 - commits.findIndex((commit) => commit.sha === diff.lastReviewSha);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" aria-label={showTree ? "Hide files" : "Show files"} onClick={() => setShowTree((value) => !value)}>
          <Icon name="PanelLeft" className="size-4" />
        </Button>
        <select
          aria-label="Commits"
          value={rangeValue(range)}
          onChange={(event) => setRange(parseRange(event.target.value))}
          className="h-8 max-w-72 truncate rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="all">All commits ({commits.length})</option>
          {diff?.lastReviewSha ? (
            <option value="since-review">
              Since your last review ({sinceReviewCount} {sinceReviewCount === 1 ? "commit" : "commits"})
            </option>
          ) : null}
          <optgroup label="One commit">
            {[...commits].reverse().map((commit) => (
              <option key={commit.sha} value={`commit:${commit.sha}`}>
                {commit.shortSha} {commit.message.length > 60 ? `${commit.message.slice(0, 60)}…` : commit.message} · {relativeTime(commit.committedAt)}
              </option>
            ))}
          </optgroup>
        </select>
        <span className="text-xs text-muted-foreground">
          {files.length} files · {reviewedCount} reviewed
        </span>
        <span className="flex-1" />
        <div role="tablist" aria-label="Inline comments" className="flex rounded-md border border-border p-0.5">
          {COMMENT_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={comments === item.id}
              onClick={() => setComments(item.id)}
              className={cn(
                "rounded px-2 py-0.5 text-xs transition-colors",
                comments === item.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={view === "split" ? "Unified view" : "Split view"}
          onClick={() => setView((value) => (value === "split" ? "unified" : "split"))}
        >
          <Icon name={view === "split" ? "Rows2" : "Columns2"} className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAllExpanded(!files.some(isExpanded))}>
          {files.some(isExpanded) ? "Collapse all" : "Expand all"}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Refresh diff" onClick={load} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <ErrorLine error={error} />
      {diff?.truncated ? (
        <p className="text-xs text-[#bf8700]">This diff is too big to show whole. Some files are missing or shown without their patch.</p>
      ) : null}

      {diff === null ? (
        error === null ? <EmptyState>Loading the diff…</EmptyState> : null
      ) : (
        <div className="flex items-start gap-3">
          {showTree ? (
            <nav aria-label="Changed files" className="sticky top-0 hidden max-h-[85vh] w-80 shrink-0 space-y-3 overflow-y-auto sm:block">
              <div className="relative">
                <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files…" aria-label="Filter files" className="pl-8" />
              </div>
              {grouped.map(({ group, files: groupFiles }) => {
                const additions = groupFiles.reduce((sum, file) => sum + file.additions, 0);
                const deletions = groupFiles.reduce((sum, file) => sum + file.deletions, 0);
                return (
                  <div key={group}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      aria-expanded={!collapsedGroups.has(group)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/50"
                    >
                      <span className="font-medium">{group}</span>
                      <span>{groupFiles.length}</span>
                      <Icon
                        name="ChevronRight"
                        className={cn("size-3 transition-transform", !collapsedGroups.has(group) && "rotate-90")}
                      />
                      <span className="ml-auto font-mono">
                        <span className="text-[#1f883d]">+{additions}</span> <span className="text-destructive">−{deletions}</span>
                      </span>
                    </button>
                    <ul hidden={collapsedGroups.has(group)}>
                      {groupFiles.map((file) => {
                        const { name, dir } = splitPath(file.path);
                        return (
                          <li key={file.path}>
                            <button
                              type="button"
                              onClick={() => jumpTo(file)}
                              title={file.path}
                              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent/50"
                            >
                              <span
                                className={cn(
                                  "shrink-0 truncate text-foreground",
                                  file.status === "added" && "text-[#3fb950]",
                                  file.status === "removed" && "text-destructive line-through",
                                )}
                              >
                                {name}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70">{dir}</span>
                              {openThreadPaths.has(file.path) ? (
                                <Icon name="MessageSquare" aria-label="Has open comments" className="size-3 shrink-0 text-muted-foreground" />
                              ) : null}
                              {isViewed(file) ? (
                                <Icon name="Check" aria-label="Reviewed" className={cn("size-3.5 shrink-0", REVIEWED_CLASS)} />
                              ) : isUpdated(file) ? (
                                <span aria-label="Updated since your review" title="Updated since your review" className={cn("mx-1 size-1.5 shrink-0 rounded-full", UPDATED_DOT_CLASS)} />
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </nav>
          ) : null}

          <div className="min-w-0 flex-1 space-y-2">
            {ordered.length === 0 ? <EmptyState>No files match.</EmptyState> : null}
            {ordered.map((file) => (
              <FileCard
                key={`${rangeValue(range)}:${file.path}`}
                file={file}
                prUrl={pr.url}
                prKey={pr.key}
                threadId={threadId}
                viewed={isViewed(file)}
                updated={isUpdated(file)}
                expanded={isExpanded(file)}
                threads={threadsByPath.get(file.path) ?? []}
                view={view}
                review={canComment ? { path: file.path, agentThreadId } : undefined}
                onToggle={() => toggleExpanded(file)}
                onViewed={(viewed) => setViewed(file, viewed)}
                onChanged={onChanged}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FileCard({
  file,
  prUrl,
  prKey,
  threadId,
  viewed,
  updated,
  expanded,
  threads,
  view,
  review,
  onToggle,
  onViewed,
  onChanged,
}: {
  file: DiffFile;
  review: { path: string; agentThreadId: string | null } | undefined;
  prUrl: string;
  prKey: string;
  threadId: string | null;
  viewed: boolean;
  updated: boolean;
  expanded: boolean;
  threads: FeedItem[];
  view: "unified" | "split";
  onToggle: () => void;
  onViewed: (viewed: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const { name, dir } = splitPath(file.path);
  const patch = useMemo(() => (file.patch === null ? null : toGitPatch({ ...file, patch: file.patch })), [file]);
  return (
    <section id={fileId(file.path)} className="scroll-mt-2 overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 px-3 py-2 text-sm">
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? "Collapse file" : "Expand file"} className="text-muted-foreground hover:text-foreground">
          <Icon name="ChevronRight" className={cn("size-4 transition-transform", expanded && "rotate-90")} />
        </button>
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
          <span
            className={cn(
              "shrink-0 font-medium text-foreground",
              file.status === "added" && "text-[#3fb950]",
              file.status === "removed" && "text-destructive",
            )}
          >
            {name}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground/70">
            {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ""}
            {dir}
          </span>
        </button>
        {updated ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-orange-400">
            <span aria-hidden className={cn("size-1.5 rounded-full", UPDATED_DOT_CLASS)} />
            Updated since review
          </span>
        ) : null}
        {threads.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Icon name="MessageSquare" className="size-3.5" />
            {threads.length}
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-xs">
          {file.additions > 0 ? <span className="text-[#1f883d]">+{file.additions}</span> : null}{" "}
          {file.deletions > 0 ? <span className="text-destructive">−{file.deletions}</span> : null}
        </span>
        <label className={cn("flex shrink-0 items-center gap-1.5 text-xs", viewed ? REVIEWED_CLASS : "text-muted-foreground")}>
          <Checkbox
            checked={viewed}
            onCheckedChange={(checked) => onViewed(checked === true)}
            className="data-[state=checked]:border-indigo-500 data-[state=checked]:bg-indigo-500"
          />
          Reviewed
        </label>
        <UrlLink href={`${prUrl}/files`} target="_blank" aria-label="Open on GitHub" className="shrink-0 text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="size-3.5" />
        </UrlLink>
      </header>
      {expanded ? (
        patch === null ? (
          <p className="border-t border-border px-3 py-3 text-sm text-muted-foreground">
            {file.status === "renamed" && file.additions + file.deletions === 0
              ? "Renamed without changes."
              : "No diff to show here (binary or too large). Open it on GitHub."}
          </p>
        ) : (
          <LazyMount>
            <div className="border-t border-border">
              <AnnotatedDiff
                patch={patch}
                view={view}
                overflow="scroll"
                showLineNumbers
                threadId={threadId}
                prKey={prKey}
                threads={threads}
                onChanged={onChanged}
                review={review}
              />
            </div>
          </LazyMount>
        )
      ) : null}
    </section>
  );
}

/** Renders children once they come near the viewport, so big PRs don't highlight every file up front. */
function LazyMount({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null || visible) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setVisible(true), {
      rootMargin: "600px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return <div ref={ref}>{visible ? children : <div className="h-24 animate-pulse bg-muted/30" />}</div>;
}
