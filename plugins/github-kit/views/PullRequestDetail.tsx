// One pull request: header, reviewers, description and the comment feed with
// a queue to send to a BB thread. Shared by the GitHub page and the thread
// side-panel tab.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  Markdown,
  UrlLink,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FeedItem, PrDetail, Reviewer } from "../detail";
import type { rpcContract } from "../server";
import type { Audience } from "../shared/audience";
import { Composer, Discussion } from "./Discussion";
import { usePrDetail } from "./useThreadPr";
import { ChecksSection, usePrChecks } from "./Checks";
import { PrDiffView } from "./PrDiffView";
import { ReviewBar } from "./ReviewBar";
import { readUi, writeUi } from "./uiState";
import { ChecksIcon, EmptyState, ErrorLine, LabelChip, PrStateIcon, ReviewChip, errorText, relativeTime, useDebounced } from "./shared";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

export function PullRequestDetail({
  prKey,
  threadId,
  onBack,
}: {
  prKey: string;
  /** Set in a thread's tab: comments queue there. Otherwise the user picks a linked thread. */
  threadId: string | null;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  // Shared with the diff view, so resolving here updates it too.
  const { detail: pr, error, loading, refresh } = usePrDetail(prKey);
  const load = () => void refresh();
  const checks = usePrChecks(prKey);
  // Remembered per PR, so coming back reopens the same tab.
  const [tab, setTabState] = useState<"overview" | "diff">(() =>
    readUi(`tab.${prKey}`, "overview" as const, (value): value is "overview" | "diff" => value === "overview" || value === "diff"),
  );
  const setTab = (next: "overview" | "diff") => {
    setTabState(next);
    writeUi(`tab.${prKey}`, next);
  };
  // A new push changes the head commit: reload so comments and diff stats follow.
  const headSha = checks.checks?.headSha ?? null;
  const seenSha = useRef<string | null>(null);
  useEffect(() => {
    if (headSha === null) return;
    if (seenSha.current !== null && seenSha.current !== headSha) void refresh();
    seenSha.current = headSha;
  }, [headSha, refresh]);

  return (
    // The page gives a PR the full width; only the diff keeps it, the overview
    // stays in the usual centered container.
    <div className={cn("mx-auto space-y-5", tab === "diff" ? "max-w-none" : "max-w-5xl")}>
      {onBack ? (
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
          <Icon name="ChevronLeft" className="size-4" />
          Pull requests
        </Button>
      ) : null}
      <ErrorLine error={error} />
      {pr === null ? (
        error === null ? <EmptyState>Loading {prKey}…</EmptyState> : null
      ) : (
        <>
          <Header pr={pr} liveChecks={checks.checks?.rollup} loading={loading} onRefresh={load} />
          <div role="tablist" aria-label="Pull request view" className="flex w-fit rounded-md border border-border p-0.5">
            {(["overview", "diff"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "rounded px-3 py-1 text-sm transition-colors",
                  tab === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {id === "overview" ? "Overview" : `Diff · ${pr.changedFiles} files`}
              </button>
            ))}
          </div>
          {tab === "diff" ? (
            <PrDiffView pr={pr} threadId={threadId} onChanged={refresh} compact={threadId !== null} />
          ) : (
            <div className="space-y-5">
              {threadId === null ? <LinkedThreads branch={pr.headRefName} /> : null}
              <ChecksSection state={checks} />
              <Reviewers pr={pr} rpc={rpc} onChanged={load} />
              <Section title="Description">
                {pr.body.trim() === "" ? (
                  <p className="text-sm text-muted-foreground">No description.</p>
                ) : (
                  <Markdown content={pr.body} className="text-sm" />
                )}
              </Section>
              <Comments pr={pr} rpc={rpc} threadId={threadId} onChanged={refresh} />
            </div>
          )}
          <ReviewBar pr={pr} onSubmitted={refresh} />
        </>
      )}
    </div>
  );
}

function copyLink(url: string) {
  navigator.clipboard.writeText(url).then(
    () => toast.success("Link copied"),
    () => toast.error("Couldn't copy the link"),
  );
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-8 items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Header({
  pr,
  liveChecks,
  loading,
  onRefresh,
}: {
  pr: PrDetail;
  liveChecks: PrDetail["checks"] | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="mt-1">
          <PrStateIcon pr={pr} />
        </span>
        <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug">
          {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
        </h2>
        <Button variant="ghost" size="icon" aria-label="Refresh" onClick={onRefresh} disabled={loading}>
          <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Copy link" onClick={() => copyLink(pr.url)}>
          <Icon name="Copy" className="size-4" />
        </Button>
        <UrlLink href={pr.url} target="_blank" aria-label="Open on GitHub" className="mt-2 text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="size-4" />
        </UrlLink>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <span>{pr.repository}</span>
        <span className="font-mono">
          {pr.headRefName} → {pr.baseRefName}
        </span>
        {pr.author ? <span>by {pr.author.login}</span> : null}
        <span>updated {relativeTime(pr.updatedAt)}</span>
        <span className="font-mono">
          <span className="text-[#1f883d]">+{pr.additions}</span> <span className="text-destructive">−{pr.deletions}</span> ·{" "}
          {pr.changedFiles} files
        </span>
        <ChecksIcon checks={liveChecks === undefined ? pr.checks : liveChecks} />
        <ReviewChip decision={pr.reviewDecision} />
        {pr.labels.map((label) => (
          <LabelChip key={label.name} name={label.name} color={label.color} />
        ))}
      </div>
    </div>
  );
}

/** Threads whose worktree is on the PR's branch, so you can jump to them. */
function useLinkedThreads(branch: string) {
  const { threads } = useSidebarThreads();
  return useMemo(
    () => threads.filter((thread) => !thread.isHidden && !thread.isArchived && thread.environment?.branchName === branch),
    [threads, branch],
  );
}

function LinkedThreads({ branch }: { branch: string }) {
  const threads = useLinkedThreads(branch);
  const navigate = useBbNavigate();
  if (threads.length === 0) return null;
  return (
    <Section title="Threads on this branch">
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => navigate.toThread(thread.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
            >
              <Icon name="MessageSquare" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
              <span className="text-xs text-muted-foreground">{thread.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const REVIEWER_STATE_LABEL: Record<Reviewer["state"], string> = {
  REQUESTED: "Requested",
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  DISMISSED: "Dismissed",
  PENDING: "Pending",
};

function Reviewers({ pr, rpc, onChanged }: { pr: PrDetail; rpc: Rpc; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);

  const update = (add: string[], remove: string[], message: string) => {
    setPending(true);
    rpc.call("reviewers_update", { key: pr.key, add, remove }).then(
      () => {
        toast.success(message);
        setPending(false);
        setAdding(false);
        onChanged();
      },
      (cause) => {
        toast.error(errorText(cause));
        setPending(false);
      },
    );
  };

  return (
    <Section
      title="Reviewers"
      actions={
        pr.state === "OPEN" ? (
          <Button size="sm" variant="outline" onClick={() => setAdding((value) => !value)} disabled={pending}>
            <Icon name="Plus" className="size-4" />
            Request review
          </Button>
        ) : null
      }
    >
      {adding ? (
        <ReviewerPicker
          pr={pr}
          rpc={rpc}
          onPick={(login) => update([login], [], `Requested a review from ${login}`)}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {pr.reviewers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reviewers yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {pr.reviewers.map((reviewer) => (
            <li
              key={`${reviewer.isTeam ? "team:" : ""}${reviewer.login}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-1 pr-2 text-xs"
            >
              {reviewer.avatarUrl ? <img src={reviewer.avatarUrl} alt="" className="size-5 rounded-full" /> : null}
              <span className="font-medium">{reviewer.isTeam ? `@${reviewer.login}` : reviewer.login}</span>
              <span className="text-muted-foreground">{REVIEWER_STATE_LABEL[reviewer.state]}</span>
              {reviewer.state === "REQUESTED" && !reviewer.isTeam && pr.state === "OPEN" ? (
                <button
                  type="button"
                  aria-label={`Remove ${reviewer.login}`}
                  disabled={pending}
                  onClick={() => update([], [reviewer.login], `Removed ${reviewer.login}`)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="X" className="size-3" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ReviewerPicker({
  pr,
  rpc,
  onPick,
  onClose,
}: {
  pr: PrDetail;
  rpc: Rpc;
  onPick: (login: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 300);
  const [users, setUsers] = useState<{ login: string; avatarUrl: string; name: string | null; suggested: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("reviewer_candidates", { key: pr.key, query }).then(
      (result) => !cancelled && setUsers(result.users),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, pr.key, query]);

  // Already requested people and the author can't be requested again.
  const taken = new Set([
    ...pr.reviewers.filter((reviewer) => reviewer.state === "REQUESTED").map((reviewer) => reviewer.login),
    pr.author?.login,
  ]);
  const visible = (users ?? []).filter((user) => !taken.has(user.login));

  return (
    <div className="mb-3 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && onClose()}
          placeholder="Search people"
          aria-label="Search reviewers"
        />
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </div>
      <ErrorLine error={error} />
      <ul className="mt-2 max-h-60 overflow-y-auto">
        {users === null && error === null ? <li className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</li> : null}
        {users !== null && visible.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">Nobody matches.</li>
        ) : null}
        {visible.map((user) => (
          <li key={user.login}>
            <button
              type="button"
              onClick={() => onPick(user.login)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/50"
            >
              <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
              <span className="font-medium">{user.login}</span>
              {user.name ? <span className="truncate text-muted-foreground">{user.name}</span> : null}
              {user.suggested ? <span className="ml-auto text-xs text-muted-foreground">Suggested</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const AUDIENCES: { id: Audience; label: string }[] = [
  { id: "all", label: "All" },
  { id: "humans", label: "Humans" },
  { id: "bots", label: "Bots" },
];

function matchesAudience(item: FeedItem, audience: Audience): boolean {
  if (audience === "all") return true;
  const isBot = item.author?.isBot ?? false;
  return audience === "bots" ? isBot : !isBot;
}

function Comments({
  pr,
  rpc,
  threadId,
  onChanged,
}: {
  pr: PrDetail;
  rpc: Rpc;
  threadId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [audience, setAudience] = useState<Audience>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set());
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const linkedThreads = useLinkedThreads(pr.headRefName);
  const [pickedThread, setPickedThread] = useState<string | null>(null);
  const target = threadId ?? pickedThread ?? linkedThreads[0]?.id ?? null;

  // Drop queued ids that vanished or got resolved after a refresh.
  useEffect(() => {
    const open = new Set(pr.feed.filter((item) => !item.isResolved).map((item) => item.id));
    setQueued((current) => new Set([...current].filter((id) => open.has(id))));
  }, [pr.feed]);

  const counts = useMemo(() => {
    const unresolved = pr.feed.filter((item) => !item.isResolved);
    return {
      all: unresolved.length,
      humans: unresolved.filter((item) => !(item.author?.isBot ?? false)).length,
      bots: unresolved.filter((item) => item.author?.isBot ?? false).length,
    };
  }, [pr.feed]);
  const shown = pr.feed.filter((item) => matchesAudience(item, audience));
  const open = shown.filter((item) => !item.isResolved);
  const resolved = shown.filter((item) => item.isResolved);

  const toggle = (id: string) =>
    setQueued((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const queueVisible = () => setQueued((current) => new Set([...current, ...open.map((item) => item.id)]));

  const send = () => {
    if (target === null || queued.size === 0) return;
    setSending(true);
    rpc.call("comments_send", { threadId: target, key: pr.key, itemIds: [...queued], note }).then(
      ({ queued: count }) => {
        toast.success(`Queued ${count} ${count === 1 ? "comment" : "comments"} on the thread`);
        setQueued(new Set());
        setNote("");
        setSending(false);
      },
      (cause) => {
        toast.error(errorText(cause));
        setSending(false);
      },
    );
  };

  return (
    <Section
      title="Comments"
      actions={
        open.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={queueVisible}>
            Queue all shown
          </Button>
        ) : null
      }
    >
      <div role="tablist" aria-label="Comment authors" className="mb-3 flex w-fit rounded-md border border-border p-0.5">
        {AUDIENCES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={audience === item.id}
            onClick={() => setAudience(item.id)}
            className={cn(
              "rounded px-2.5 py-1 text-sm transition-colors",
              audience === item.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label} <span className="text-muted-foreground">{counts[item.id]}</span>
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {open.length === 0 && resolved.length === 0 ? (
          <EmptyState>
            {audience === "bots" ? "No bot comments." : audience === "humans" ? "No human comments." : "No comments yet."}
          </EmptyState>
        ) : null}
        {open.map((item) => (
          <Discussion
            key={item.id}
            item={item}
            prKey={pr.key}
            onChanged={onChanged}
            showPath
            queue={{ queued: queued.has(item.id), onToggle: () => toggle(item.id) }}
          />
        ))}
        {resolved.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setShowResolved((current) => !current)}
              aria-expanded={showResolved}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", showResolved && "rotate-90")} />
              {resolved.length} resolved {resolved.length === 1 ? "discussion" : "discussions"}
            </button>
            {showResolved ? (
              <div className="mt-2 space-y-3">
                {resolved.map((item) => (
                  <Discussion key={item.id} item={item} prKey={pr.key} onChanged={onChanged} showPath />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {pr.state === "OPEN" ? <Composer prKey={pr.key} itemId={null} placeholder="Leave a comment…" onPosted={onChanged} /> : null}
      </div>

      {queued.size > 0 ? (
        <div className="sticky bottom-0 mt-3 space-y-2 rounded-lg border border-border bg-card p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              {queued.size} {queued.size === 1 ? "comment" : "comments"} queued
            </span>
            <Button size="sm" variant="ghost" onClick={() => setQueued(new Set())}>
              Clear
            </Button>
            <span className="flex-1" />
            {threadId === null ? (
              linkedThreads.length === 0 ? (
                <span className="text-xs text-muted-foreground">No thread works on {pr.headRefName}.</span>
              ) : (
                <select
                  aria-label="Target thread"
                  value={target ?? ""}
                  onChange={(event) => setPickedThread(event.target.value)}
                  className="h-8 max-w-64 truncate rounded-md border border-border bg-background px-2 text-sm"
                >
                  {linkedThreads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.displayTitle}
                    </option>
                  ))}
                </select>
              )
            ) : null}
            <Button size="sm" onClick={send} disabled={sending || target === null}>
              <Icon name="ArrowUpRight" className="size-4" />
              Send to thread
            </Button>
          </div>
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional note for the agent"
            aria-label="Note for the agent"
            maxLength={4000}
          />
        </div>
      ) : null}
    </Section>
  );
}
