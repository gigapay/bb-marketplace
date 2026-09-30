// "Reviews" home-screen section: open PRs waiting for your review, plus the
// ones you already reviewed, filterable by repository.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginHomepageSectionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { PullRequest, rpcContract } from "../server";
import { ChecksIcon, PrStateIcon, ReviewChip, relativeTime } from "./shared";

const MAX_ROWS = 8;
const ALL_REPOS = "";
// The repo filter is a UI preference, so it lives with the browser.
const REPO_STORAGE_KEY = "github-kit.home.repo";

type ReviewRow = PullRequest & { role: "requested" | "reviewed" };

function readStoredRepo(): string {
  try {
    return localStorage.getItem(REPO_STORAGE_KEY) ?? ALL_REPOS;
  } catch {
    return ALL_REPOS;
  }
}

export function HomeSection(_props: PluginHomepageSectionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unconfigured" | "error">("loading");
  const [repo, setRepo] = useState(readStoredRepo);

  const load = useCallback(() => {
    let cancelled = false;
    setState((current) => (current === "ready" ? current : "loading"));
    rpc.call("status").then(async (status) => {
      if (cancelled) return;
      if (!status.configured) return setState("unconfigured");
      if (status.viewer === null) return setState("error");
      try {
        const [requested, reviewed] = await Promise.all([
          rpc.call("prs_list", { scope: "review", includeClosed: false, query: "" }),
          rpc.call("prs_list", { scope: "reviewed", includeClosed: false, query: "" }),
        ]);
        if (cancelled) return;
        // A re-requested review shows once, as requested.
        const seen = new Set<string>();
        const merged: ReviewRow[] = [];
        for (const pr of requested.pullRequests) {
          seen.add(pr.id);
          merged.push({ ...pr, role: "requested" });
        }
        for (const pr of reviewed.pullRequests) {
          if (!seen.has(pr.id)) merged.push({ ...pr, role: "reviewed" });
        }
        setRows(merged);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    }, () => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  useEffect(() => load(), [load]);

  const repos = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows ?? []) counts.set(row.repository, (counts.get(row.repository) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [rows]);
  // A stored repo with nothing left to review falls back to all.
  const activeRepo = repo !== ALL_REPOS && repos.some(([name]) => name === repo) ? repo : ALL_REPOS;
  const filtered = useMemo(() => {
    const list = (rows ?? []).filter((row) => activeRepo === ALL_REPOS || row.repository === activeRepo);
    // Waiting on you first, then most recently updated.
    return list.sort((a, b) =>
      a.role === b.role ? b.updatedAt.localeCompare(a.updatedAt) : a.role === "requested" ? -1 : 1,
    );
  }, [rows, activeRepo]);
  const visible = filtered.slice(0, MAX_ROWS);
  const requestedCount = filtered.filter((row) => row.role === "requested").length;

  const pickRepo = (value: string) => {
    setRepo(value);
    try {
      localStorage.setItem(REPO_STORAGE_KEY, value);
    } catch {
      // Private mode or a full quota: the filter just won't stick.
    }
  };
  const open = (row: ReviewRow) => {
    const [owner, name] = row.repository.split("/");
    navigate.toPluginPanel("pulls", { subPath: `${owner}/${name}/${row.number}` });
  };

  if (state === "unconfigured") {
    return (
      <p className="text-sm text-muted-foreground">
        Connect GitHub with <code>gh auth login</code> or a token in the GitHub Kit settings to see your reviews here.
      </p>
    );
  }
  if (state === "error") return <p className="text-sm text-muted-foreground">Couldn't reach GitHub.</p>;

  return (
    <div>
      {/* BB renders the section title; this row adds the count, the repo filter and a way out. */}
      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name="github-kit/github" className="size-3.5" />
        <span className="truncate">
          {rows === null ? "Your reviews" : `${requestedCount} waiting on you · ${filtered.length - requestedCount} reviewed`}
        </span>
        {repos.length > 1 ? (
          <select
            aria-label="Filter by repository"
            value={activeRepo}
            onChange={(event) => pickRepo(event.target.value)}
            className="ml-auto h-7 max-w-56 truncate rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            <option value={ALL_REPOS}>All repositories ({rows?.length ?? 0})</option>
            {repos.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-7 text-muted-foreground", repos.length <= 1 && "ml-auto")}
          onClick={() => navigate.toPluginPanel("pulls")}
        >
          View all
          <Icon name="ChevronRight" className="size-3.5" />
        </Button>
      </div>
      {state === "loading" ? (
        <div className="space-y-1.5" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-9 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open pull requests to review. Nice.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {visible.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => open(row)}
                className="group flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-accent/50"
              >
                <PrStateIcon pr={row} />
                <span className="w-44 shrink-0 truncate font-mono text-xs text-muted-foreground">
                  {row.repository.split("/")[1]}#{row.number}
                </span>
                <span className="min-w-0 flex-1 truncate group-hover:underline">{row.title}</span>
                {row.role === "requested" ? (
                  <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">Review requested</span>
                ) : (
                  <ReviewChip decision={row.reviewDecision} />
                )}
                <ChecksIcon checks={row.checks} />
                <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                  {relativeTime(row.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {filtered.length > MAX_ROWS ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{filtered.length - MAX_ROWS} more in the GitHub page.</p>
      ) : null}
    </div>
  );
}
