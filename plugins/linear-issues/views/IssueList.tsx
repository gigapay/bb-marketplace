import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { IssueScope, IssueSummary, rpcContract } from "../server";
import {
  EmptyState,
  ErrorLine,
  LabelChip,
  PriorityIcon,
  StateIcon,
  errorText,
  relativeTime,
  stateTypeRank,
  useDebounced,
} from "./shared";
import { useIssueLinks } from "./links";
import { TriageDialog } from "./Triage";

// "linked" is local: the issues that have at least one BB thread.
type ListScope = Exclude<IssueScope, "all"> | "linked";

const SCOPES: { id: ListScope; label: string }[] = [
  { id: "assigned", label: "Assigned" },
  { id: "created", label: "Created" },
  { id: "subscribed", label: "Subscribed" },
  { id: "linked", label: "With threads" },
];

type Group = { key: string; state: IssueSummary["state"]; issues: IssueSummary[] };

function groupByState(issues: IssueSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const issue of issues) {
    // Teams have their own state ids, so group by name + type to merge
    // "In Progress" across teams.
    const key = `${issue.state.type}:${issue.state.name}`;
    const group = groups.get(key) ?? { key, state: issue.state, issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      stateTypeRank(a.state.type) - stateTypeRank(b.state.type) ||
      a.state.position - b.state.position,
  );
}

// Urgent first, "no priority" (0) last, then most recently updated.
function byPriority(a: IssueSummary, b: IssueSummary): number {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
}

export function IssueList({ onOpen }: { onOpen: (identifier: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const links = useIssueLinks();
  const [scope, setScope] = useState<ListScope>("assigned");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [triageOpen, setTriageOpen] = useState(false);

  // Sorted so a new Map instance with the same keys doesn't refetch.
  const linkedKey = [...links.byIssue.keys()].sort().join(",");
  const linkedDependency = scope === "linked" ? linkedKey : "";

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    const request =
      scope === "linked"
        ? rpc
            .call("issues_by_identifiers", {
              identifiers: linkedDependency === "" ? [] : linkedDependency.split(",").slice(0, 100),
            })
            .then(({ issues }) => ({ issues: filterLocally(issues, includeCompleted, query) }))
        : rpc.call("issues_list", { scope, includeCompleted, query });
    request.then(
      (result) => {
        if (cancelled) return;
        setIssues(result.issues);
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
  }, [rpc, scope, includeCompleted, query, linkedDependency]);

  useEffect(() => load(), [load]);

  const groups = useMemo(
    () =>
      issues === null
        ? []
        : groupByState(issues).map((group) => ({
            ...group,
            issues: [...group.issues].sort(byPriority),
          })),
    [issues],
  );

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
        <div role="tablist" aria-label="Issue scope" className="flex rounded-md border border-border p-0.5">
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
            placeholder="Search issues"
            aria-label="Search issues"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={includeCompleted}
            onCheckedChange={(checked) => setIncludeCompleted(checked === true)}
          />
          Show done
        </label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTriageOpen(true)}
          disabled={!issues || issues.length === 0}
        >
          <Icon name="linear-issues/linear" className="size-3.5 text-[#5E6AD2]" />
          Triage with Jev
        </Button>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={load} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
        </Button>
      </div>

      <ErrorLine error={error} />
      <TriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        issues={issues ?? []}
        linkedIdentifiers={new Set(links.byIssue.keys())}
        onApplied={load}
      />

      <div className="mt-4 space-y-4">
        {issues === null ? (
          error === null ? <EmptyState>Loading issues…</EmptyState> : null
        ) : issues.length === 0 ? (
          <EmptyState>No issues here.</EmptyState>
        ) : (
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <section key={group.key}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 px-1 py-1.5 text-sm font-medium"
                >
                  <Icon
                    name="ChevronRight"
                    className={cn("size-3.5 text-muted-foreground transition-transform", !isCollapsed && "rotate-90")}
                  />
                  <StateIcon state={group.state} />
                  {group.state.name}
                  <span className="text-muted-foreground">{group.issues.length}</span>
                </button>
                {isCollapsed ? null : (
                  <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                    {group.issues.map((issue) => (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        threadCount={links.byIssue.get(issue.identifier)?.length ?? 0}
                        onOpen={() => onOpen(issue.identifier)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function filterLocally(issues: IssueSummary[], includeCompleted: boolean, query: string): IssueSummary[] {
  const needle = query.toLowerCase();
  return issues.filter(
    (issue) =>
      (includeCompleted || (issue.state.type !== "completed" && issue.state.type !== "canceled")) &&
      (needle === "" || issue.title.toLowerCase().includes(needle) || issue.identifier.toLowerCase().includes(needle)),
  );
}

function IssueRow({
  issue,
  threadCount,
  onOpen,
}: {
  issue: IssueSummary;
  threadCount: number;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        <PriorityIcon priority={issue.priority} label={issue.priorityLabel} />
        <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
        <StateIcon state={issue.state} />
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
        <span className="hidden shrink-0 items-center gap-1 lg:flex">
          {issue.labels.slice(0, 2).map((label) => (
            <LabelChip key={label.id} name={label.name} color={label.color} />
          ))}
        </span>
        {issue.project ? (
          <span className="hidden max-w-36 shrink-0 truncate text-xs text-muted-foreground md:inline">
            {issue.project.name}
          </span>
        ) : null}
        {threadCount > 0 ? (
          <span
            aria-label={`${threadCount} linked ${threadCount === 1 ? "thread" : "threads"}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
          >
            <Icon name="MessageSquare" className="size-3" />
            {threadCount}
          </span>
        ) : null}
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:inline">
          {relativeTime(issue.updatedAt)}
        </span>
      </button>
    </li>
  );
}
