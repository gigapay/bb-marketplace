import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PullRequest, rpcContract } from "../server";
import { PR_SCOPES, type PrScope } from "../shared/search";
import { readUi, writeUi } from "./uiState";
import {
  ChecksIcon,
  EmptyState,
  ErrorLine,
  LabelChip,
  PrStateIcon,
  ReviewChip,
  errorText,
  relativeTime,
  useDebounced,
} from "./shared";

const SCOPES: { id: PrScope; label: string }[] = [
  { id: "review", label: "Review requested" },
  { id: "reviewed", label: "Reviewed" },
  { id: "authored", label: "Created" },
  { id: "assigned", label: "Assigned" },
  { id: "involved", label: "Involved" },
];

type Group = { repository: string; pullRequests: PullRequest[] };

// Repos keep the order of their most recently updated PR, since search
// already sorts by update time.
function groupByRepository(pullRequests: PullRequest[]): Group[] {
  const groups = new Map<string, Group>();
  for (const pr of pullRequests) {
    const group = groups.get(pr.repository) ?? { repository: pr.repository, pullRequests: [] };
    group.pullRequests.push(pr);
    groups.set(pr.repository, group);
  }
  return [...groups.values()];
}

export function PullRequestList({ viewer, onOpen }: { viewer: string; onOpen: (key: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  // Kept for the session, so coming back to the page keeps your tab.
  const [scope, setScopeState] = useState<PrScope>(() =>
    readUi("list.scope", "review" as PrScope, (value): value is PrScope => typeof value === "string" && (PR_SCOPES as readonly string[]).includes(value)),
  );
  const [includeClosed, setIncludeClosedState] = useState(() =>
    readUi("list.closed", false, (value): value is boolean => typeof value === "boolean"),
  );
  const setScope = (next: PrScope) => {
    setScopeState(next);
    writeUi("list.scope", next);
  };
  const setIncludeClosed = (next: boolean) => {
    setIncludeClosedState(next);
    writeUi("list.closed", next);
  };
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 400);
  const [result, setResult] = useState<{ pullRequests: PullRequest[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call("prs_list", { scope, includeClosed, query }).then(
      (next) => {
        if (cancelled) return;
        setResult(next);
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
  }, [rpc, scope, includeClosed, query]);

  useEffect(() => load(), [load]);

  const groups = useMemo(() => (result === null ? [] : groupByRepository(result.pullRequests)), [result]);

  const toggleGroup = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Pull request scope" className="flex rounded-md border border-border p-0.5">
          {SCOPES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={scope === item.id}
              onClick={() => setScope(item.id)}
              className={cn(
                "rounded px-2.5 py-1 text-sm transition-colors",
                scope === item.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search, or repo:owner/name label:bug"
            aria-label="Search pull requests"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={includeClosed} onCheckedChange={(checked) => setIncludeClosed(checked === true)} />
          Show closed
        </label>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={load} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <ErrorLine error={error} />

      <div className="mt-4 space-y-4">
        {result === null ? (
          error === null ? <EmptyState>Loading pull requests…</EmptyState> : null
        ) : result.pullRequests.length === 0 ? (
          <EmptyState>No pull requests here.</EmptyState>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.repository);
            return (
              <section key={group.repository}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.repository)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 px-1 py-1.5 text-sm font-medium"
                >
                  <Icon
                    name="ChevronRight"
                    className={cn("size-3.5 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")}
                  />
                  {group.repository}
                  <span className="text-muted-foreground">{group.pullRequests.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                    {group.pullRequests.map((pr) => (
                      <PullRequestRow key={pr.id} pr={pr} viewer={viewer} onOpen={() => onOpen(`${pr.repository}#${pr.number}`)} />
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
        {result !== null && result.total > result.pullRequests.length ? (
          <p className="text-center text-xs text-muted-foreground">
            Showing {result.pullRequests.length} of {result.total}. Narrow the search to see the rest.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function PullRequestRow({ pr, viewer, onOpen }: { pr: PullRequest; viewer: string; onOpen: () => void }) {
  const author = pr.author?.login ?? "ghost";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        <PrStateIcon pr={pr} />
        <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">#{pr.number}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{pr.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {author === viewer ? "You" : author} · {pr.headRefName} → {pr.baseRefName}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1 lg:flex">
          {pr.labels.slice(0, 2).map((label) => (
            <LabelChip key={label.name} name={label.name} color={label.color} />
          ))}
        </span>
        <ReviewChip decision={pr.reviewDecision} />
        <ChecksIcon checks={pr.checks} />
        <span className="hidden w-24 shrink-0 text-right font-mono text-xs md:inline">
          <span className="text-[#1f883d]">+{pr.additions}</span>{" "}
          <span className="text-destructive">−{pr.deletions}</span>
        </span>
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:inline">
          {relativeTime(pr.updatedAt)}
        </span>
      </button>
    </li>
  );
}
