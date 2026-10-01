// Picks the PR to link a thread to: paste a URL or owner/repo#N, or choose
// from your open PRs (created, review requested, involved).
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { PullRequest, rpcContract } from "../server";
import { parsePrReference, prKey } from "../shared/pr-ref";
import { ErrorLine, PrStateIcon, errorText, relativeTime, useDebounced } from "./shared";

export function PrLinkPicker({ onPick, onCancel }: { onPick: (key: string) => void; onCancel?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A pasted URL or owner/repo#N links directly; other text searches.
  const direct = useMemo(() => {
    const ref = parsePrReference(search);
    return ref !== null && "owner" in ref ? prKey(ref) : null;
  }, [search]);

  useEffect(() => {
    if (direct !== null) return;
    let cancelled = false;
    Promise.all(
      (["authored", "review", "involved"] as const).map((scope) => rpc.call("prs_list", { scope, includeClosed: false, query })),
    ).then(
      (results) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: PullRequest[] = [];
        for (const pr of results.flatMap((result) => result.pullRequests)) {
          if (seen.has(pr.id)) continue;
          seen.add(pr.id);
          merged.push(pr);
        }
        setPrs(merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30));
        setError(null);
      },
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, query, direct]);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && direct !== null) onPick(direct);
              else if (event.key === "Escape") onCancel?.();
            }}
            placeholder="Search your PRs, or paste a URL / owner/repo#123"
            aria-label="Find a pull request"
            className="pl-8"
          />
        </div>
        {onCancel ? (
          <Button variant="ghost" size="icon" aria-label="Cancel" onClick={onCancel}>
            <Icon name="X" className="size-4" />
          </Button>
        ) : null}
      </div>
      {direct !== null ? (
        <Button size="sm" onClick={() => onPick(direct)}>
          <Icon name="Check" className="size-4" />
          Link {direct}
        </Button>
      ) : (
        <>
          <ErrorLine error={error} />
          <ul className="max-h-72 overflow-y-auto">
            {prs === null && error === null ? <li className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</li> : null}
            {prs !== null && prs.length === 0 ? <li className="px-2 py-1.5 text-sm text-muted-foreground">No open PRs match.</li> : null}
            {(prs ?? []).map((pr) => (
              <li key={pr.id}>
                <button
                  type="button"
                  onClick={() => onPick(`${pr.repository}#${pr.number}`)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                >
                  <PrStateIcon pr={pr} />
                  <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">
                    {pr.repository.split("/")[1]}#{pr.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(pr.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
