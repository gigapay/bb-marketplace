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
import { usePrChecks } from "./Checks";
import { MenuItem, Popover } from "./Popover";
import { fileGroup, type FileGroup } from "../diff";
import { PrDiffView } from "./PrDiffView";
import { ReviewBar } from "./ReviewBar";
import { readUi, writeUi } from "./uiState";
import { EmptyState, ErrorLine, LabelChip, PrStateIcon, ReviewChip, errorText, prState, relativeTime, useDebounced } from "./shared";

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
  const checks = usePrChecks(prKey);
  // Remembered per PR, so coming back reopens the same tab.
  const [tab, setTabState] = useState<"overview" | "diff">(() =>
    readUi(`tab.${prKey}`, "overview" as const, (value): value is "overview" | "diff" => value === "overview" || value === "diff"),
  );
  const setTab = (next: "overview" | "diff") => {
    setTabState(next);
    writeUi(`tab.${prKey}`, next);
  };
  // "Files changed" in the overview jumps to a file in the diff: the diff
  // restores the remembered file when it mounts.
  const openFile = (path: string) => {
    writeUi(`file.${prKey}`, path);
    setTab("diff");
  };
  // A new push changes the head commit: reload so comments and diff stats follow.
  const headSha = checks.checks?.headSha ?? null;
  const seenSha = useRef<string | null>(null);
  useEffect(() => {
    if (headSha === null) return;
    if (seenSha.current !== null && seenSha.current !== headSha) void refresh();
    seenSha.current = headSha;
  }, [headSha, refresh]);
  // The thread side panel is narrow: the sidebar stacks under the title there.
  const narrow = threadId !== null;

  return (
    // The page gives a PR the full width; only the diff keeps it, the overview
    // stays in the usual centered container.
    <div className={cn("mx-auto space-y-5", tab === "diff" ? "max-w-none" : "max-w-6xl")}>
      <div className="flex flex-wrap items-center gap-2">
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mr-1">
            <Icon name="ChevronLeft" className="size-4" />
            Pull requests
          </Button>
        ) : null}
        <div role="tablist" aria-label="Pull request view" className="flex items-center gap-1.5">
          {(["overview", "diff"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "rounded-full border px-3.5 py-1 text-sm transition-colors",
                tab === id
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/60 bg-muted/30 text-muted-foreground hover:text-foreground",
              )}
            >
              {id === "overview" ? "Overview" : pr ? `Diff · ${pr.changedFiles}` : "Diff"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {pr ? (
          <>
            <Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void refresh()} disabled={loading}>
              <Icon name="ArrowReloadHorizontal" className={cn("size-4", loading && "animate-spin")} />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Copy link" onClick={() => copyLink(pr.url)}>
              <Icon name="Copy" className="size-4" />
            </Button>
            <UrlLink href={pr.url} target="_blank" aria-label="Open on GitHub" className="inline-flex size-9 items-center justify-center text-muted-foreground hover:text-foreground">
              <Icon name="ExternalLink" className="size-4" />
            </UrlLink>
          </>
        ) : null}
      </div>
      <ErrorLine error={error} />
      {pr === null ? (
        error === null ? <EmptyState>Loading {prKey}…</EmptyState> : null
      ) : (
        <>
          {tab === "diff" ? (
            <>
              <TitleBlock pr={pr} compact />
              <PrDiffView pr={pr} threadId={threadId} onChanged={refresh} compact={narrow} />
            </>
          ) : (
            <div className={cn("grid gap-x-12 gap-y-8", !narrow && "lg:grid-cols-[minmax(0,1fr)_17rem]")}>
              <div className="min-w-0 space-y-8">
                <TitleBlock pr={pr} compact={false} />
                {narrow ? <PrSidebar pr={pr} rpc={rpc} checks={checks} threadId={threadId} onChanged={refresh} onOpenFile={openFile} /> : null}
                <DescriptionBlock pr={pr} />
                <Comments pr={pr} rpc={rpc} threadId={threadId} onChanged={refresh} />
              </div>
              {narrow ? null : (
                <aside className="lg:sticky lg:top-0 lg:self-start">
                  <PrSidebar pr={pr} rpc={rpc} checks={checks} threadId={threadId} onChanged={refresh} onOpenFile={openFile} />
                </aside>
              )}
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

function TitleBlock({ pr, compact }: { pr: PrDetail; compact: boolean }) {
  return (
    <div className="space-y-2">
      <h1 className={cn("font-semibold leading-tight tracking-tight", compact ? "text-lg" : "text-2xl md:text-[1.7rem]")}>
        {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {pr.author ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <img src={pr.author.avatarUrl} alt="" className="size-5 rounded-full" />
            {pr.author.login}
          </span>
        ) : null}
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate font-mono text-xs">
          {pr.baseRefName} ← {pr.headRefName}
        </span>
        <span aria-hidden>·</span>
        <span className="text-xs">{pr.repository}</span>
        {pr.labels.map((label) => (
          <LabelChip key={label.name} name={label.name} color={label.color} />
        ))}
      </div>
    </div>
  );
}

function DescriptionBlock({ pr }: { pr: PrDetail }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Description
        <Icon name="ChevronRight" className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        pr.body.trim() === "" ? (
          <p className="text-sm text-muted-foreground">No description.</p>
        ) : (
          <Markdown content={pr.body} className="text-[15px] leading-relaxed" />
        )
      ) : null}
    </section>
  );
}

/** One block of the right column: a muted label, an optional action, content. */
function SideBlock({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex-1">{title}</span>
        {action}
      </div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </section>
  );
}

const MERGE_STATE: Record<string, { chip: string | null; branch: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  BEHIND: { chip: "Branch behind", branch: "Behind base, update required", tone: "warn" },
  DIRTY: { chip: "Conflicts", branch: "Has conflicts with the base branch", tone: "bad" },
  BLOCKED: { chip: "Blocked", branch: "Up to date, merging is blocked", tone: "muted" },
  UNSTABLE: { chip: "Checks failing", branch: "Up to date with the base branch", tone: "warn" },
  CLEAN: { chip: "Ready to merge", branch: "Up to date with the base branch", tone: "ok" },
  HAS_HOOKS: { chip: null, branch: "Up to date with the base branch", tone: "ok" },
  DRAFT: { chip: null, branch: "Draft, not mergeable yet", tone: "muted" },
  UNKNOWN: { chip: null, branch: "GitHub is still checking mergeability", tone: "muted" },
};

const TONE_CLASS = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-destructive",
  muted: "text-muted-foreground",
} as const;

const STATE_LABEL = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const;

function PrSidebar({
  pr,
  rpc,
  checks,
  threadId,
  onChanged,
  onOpenFile,
}: {
  pr: PrDetail;
  rpc: Rpc;
  checks: ReturnType<typeof usePrChecks>;
  threadId: string | null;
  onChanged: () => Promise<void>;
  onOpenFile: (path: string) => void;
}) {
  const merge = MERGE_STATE[pr.mergeStateStatus] ?? MERGE_STATE.UNKNOWN!;
  const open = pr.state === "OPEN";
  const linkedThreads = useLinkedThreads(pr.headRefName);
  const agentThreadId = threadId ?? linkedThreads[0]?.id ?? null;
  return (
    <div className="space-y-7">
      <SideBlock title="Status">
        <div className="flex flex-wrap items-center gap-2">
          <StatusMenu pr={pr} rpc={rpc} onChanged={onChanged} />
          {open && merge.chip ? (
            <span className={cn("rounded-md bg-muted/50 px-2 py-0.5 text-xs", TONE_CLASS[merge.tone])}>{merge.chip}</span>
          ) : null}
          {pr.reviewDecision ? <ReviewChip decision={pr.reviewDecision} /> : null}
        </div>
      </SideBlock>
      {threadId === null ? <LinkedThreads branch={pr.headRefName} /> : null}
      <SidebarReviewers pr={pr} rpc={rpc} onChanged={onChanged} />
      <SidebarChecks state={checks} pr={pr} rpc={rpc} agentThreadId={agentThreadId} />
      {open ? (
        <SideBlock title="Branch">
          <BranchMenu pr={pr} rpc={rpc} onChanged={onChanged} merge={merge} />
        </SideBlock>
      ) : null}
      <SidebarFiles pr={pr} onOpenFile={onOpenFile} />
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
    <SideBlock title="Threads">
      {threads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          onClick={() => navigate.toThread(thread.id)}
          className="flex w-full items-center gap-2 rounded text-left hover:text-foreground"
        >
          <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{thread.displayTitle}</span>
        </button>
      ))}
    </SideBlock>
  );
}

const REVIEWER_STATE: Record<Reviewer["state"], { label: string; className: string; icon: string }> = {
  REQUESTED: { label: "Review requested", className: "text-amber-500", icon: "Clock" },
  APPROVED: { label: "Approved", className: "text-emerald-500", icon: "Check" },
  CHANGES_REQUESTED: { label: "Changes requested", className: "text-destructive", icon: "X" },
  COMMENTED: { label: "Commented", className: "text-muted-foreground", icon: "MessageSquare" },
  DISMISSED: { label: "Dismissed", className: "text-muted-foreground", icon: "X" },
  PENDING: { label: "Pending", className: "text-muted-foreground", icon: "Clock" },
};

function SidebarReviewers({ pr, rpc, onChanged }: { pr: PrDetail; rpc: Rpc; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);

  const update = (add: string[], remove: string[], message: string) => {
    setPending(true);
    rpc.call("reviewers_update", { key: pr.key, add, remove }).then(
      async () => {
        toast.success(message);
        setPending(false);
        setAdding(false);
        await onChanged();
      },
      (cause) => {
        toast.error(errorText(cause));
        setPending(false);
      },
    );
  };

  return (
    <SideBlock
      title="Reviewers"
      action={
        pr.state === "OPEN" ? (
          <button
            type="button"
            aria-label="Request a review"
            onClick={() => setAdding((value) => !value)}
            disabled={pending}
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="Plus" className="size-4" />
          </button>
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
      {pr.reviewers.length === 0 ? <p className="text-muted-foreground">No reviewers</p> : null}
      {pr.reviewers.map((reviewer) => {
        const state = REVIEWER_STATE[reviewer.state];
        return (
          <div key={`${reviewer.isTeam ? "team:" : ""}${reviewer.login}`} className="group flex items-center gap-2">
            {reviewer.avatarUrl ? <img src={reviewer.avatarUrl} alt="" className="size-5 rounded-full" /> : <span className="size-5" />}
            <span className="min-w-0 flex-1 truncate">{reviewer.isTeam ? `@${reviewer.login}` : reviewer.login}</span>
            {reviewer.state === "REQUESTED" && !reviewer.isTeam && pr.state === "OPEN" ? (
              <button
                type="button"
                aria-label={`Remove ${reviewer.login}`}
                disabled={pending}
                onClick={() => update([], [reviewer.login], `Removed ${reviewer.login}`)}
                className="hidden text-muted-foreground hover:text-foreground group-hover:inline-flex"
              >
                <Icon name="X" className="size-3.5" />
              </button>
            ) : null}
            <span title={state.label} className={cn("inline-flex", state.className)}>
              <Icon name={state.icon} aria-label={state.label} className="size-3.5" />
            </span>
          </div>
        );
      })}
    </SideBlock>
  );
}

function useAction(onDone?: () => Promise<void> | void) {
  const [pending, setPending] = useState(false);
  const run = (promise: Promise<unknown>, message: string) => {
    setPending(true);
    promise.then(
      async () => {
        toast.success(message);
        setPending(false);
        await onDone?.();
      },
      (cause) => {
        toast.error(errorText(cause));
        setPending(false);
      },
    );
  };
  return { pending, run };
}

const TRIGGER_CLASS = "inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1 -mx-2 text-left hover:bg-accent/60 disabled:opacity-60";

function StatusMenu({ pr, rpc, onChanged }: { pr: PrDetail; rpc: Rpc; onChanged: () => Promise<void> }) {
  const { pending, run } = useAction(onChanged);
  const current = prState(pr);
  const label = (
    <>
      <PrStateIcon pr={pr} />
      <span>{STATE_LABEL[current]}</span>
    </>
  );
  // A merged PR is final.
  if (current === "merged") return <span className="inline-flex items-center gap-2">{label}</span>;
  const options = [
    { id: "draft" as const, glyph: { state: "OPEN" as const, isDraft: true }, label: "Draft", message: "Converted to draft" },
    { id: "open" as const, glyph: { state: "OPEN" as const, isDraft: false }, label: current === "closed" ? "Reopen" : "Open", message: current === "closed" ? "Reopened" : "Ready for review" },
    { id: "closed" as const, glyph: { state: "CLOSED" as const, isDraft: false }, label: "Closed", message: "Closed" },
  ];
  return (
    <Popover
      className="w-48"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} disabled={pending} aria-haspopup="menu" className={TRIGGER_CLASS}>
          {label}
          <Icon name="ChevronRight" className="size-3 rotate-90 text-muted-foreground" />
        </button>
      )}
    >
      {(close) =>
        options.map((option) => (
          <MenuItem
            key={option.id}
            checked={option.id === current}
            onSelect={() => {
              close();
              if (option.id !== current) run(rpc.call("pr_set_state", { key: pr.key, state: option.id }), option.message);
            }}
          >
            <PrStateIcon pr={option.glyph} />
            {option.label}
          </MenuItem>
        ))
      }
    </Popover>
  );
}

function BranchMenu({
  pr,
  rpc,
  onChanged,
  merge,
}: {
  pr: PrDetail;
  rpc: Rpc;
  onChanged: () => Promise<void>;
  merge: { branch: string; tone: keyof typeof TONE_CLASS };
}) {
  const { pending, run } = useAction(onChanged);
  const label = (
    <>
      <Icon name="GitPullRequest" className={cn("size-4 shrink-0", TONE_CLASS[merge.tone])} />
      <span className={merge.tone === "muted" ? "text-muted-foreground" : "text-foreground"}>{pending ? "Updating…" : merge.branch}</span>
    </>
  );
  // GitHub only offers an update when the branch is behind its base.
  if (pr.mergeStateStatus !== "BEHIND") return <div className="flex items-center gap-2">{label}</div>;
  const update = (method: "REBASE" | "MERGE") =>
    run(rpc.call("pr_update_branch", { key: pr.key, method }), method === "REBASE" ? "Branch rebased on the base" : "Base merged into the branch");
  return (
    <Popover
      className="w-56"
      trigger={({ toggle }) => (
        <button type="button" onClick={toggle} disabled={pending} aria-haspopup="menu" className={TRIGGER_CLASS}>
          {label}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem onSelect={() => (close(), update("REBASE"))}>Update with rebase</MenuItem>
          <MenuItem onSelect={() => (close(), update("MERGE"))}>Update with merge commit</MenuItem>
        </>
      )}
    </Popover>
  );
}

const CHECK_ORDER = ["failure", "cancelled", "running", "queued", "neutral", "skipped", "success"];

function checkDuration(check: { startedAt: string | null; completedAt: string | null }): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const seconds = Math.max(0, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

function CheckStateIcon({ state }: { state: string }) {
  if (state === "success") return <Icon name="Check" aria-label="Passed" className="size-4 shrink-0 text-emerald-500" />;
  if (state === "failure" || state === "cancelled") return <Icon name="X" aria-label="Failed" className="size-4 shrink-0 text-destructive" />;
  if (state === "running" || state === "queued")
    return <span aria-label="Running" className="mx-1 size-2 shrink-0 animate-pulse rounded-full bg-amber-500" />;
  return <span aria-label="Skipped" className="mx-1 h-0.5 w-2 shrink-0 bg-muted-foreground" />;
}

function SidebarChecks({
  state,
  pr,
  rpc,
  agentThreadId,
}: {
  state: ReturnType<typeof usePrChecks>;
  pr: PrDetail;
  rpc: Rpc;
  agentThreadId: string | null;
}) {
  const [filter, setFilter] = useState("");
  const { pending, run } = useAction();
  const list = state.checks?.checks ?? [];
  if (state.checks === null || list.length === 0) {
    return (
      <SideBlock title="Checks">
        <p className="text-muted-foreground">{state.checks === null ? (state.error ?? "Loading…") : "No checks on this commit"}</p>
      </SideBlock>
    );
  }
  const passed = list.filter((check) => check.state === "success" || check.state === "skipped" || check.state === "neutral").length;
  const failing = list.filter((check) => check.state === "failure" || check.state === "cancelled");
  const running = list.filter((check) => check.state === "running" || check.state === "queued");
  const tone = failing.length > 0 ? "text-destructive" : running.length > 0 ? "text-amber-500" : "text-emerald-500";
  const needle = filter.trim().toLowerCase();
  const sorted = [...list]
    .filter((check) => needle === "" || `${check.workflow ?? ""} ${check.name}`.toLowerCase().includes(needle))
    .sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) || `${a.workflow}${a.name}`.localeCompare(`${b.workflow}${b.name}`));

  return (
    <SideBlock title="Checks">
      <Popover
        align="end"
        className="w-[min(32rem,85vw)] p-0"
        trigger={({ toggle }) => (
          <button type="button" onClick={toggle} aria-haspopup="menu" className={TRIGGER_CLASS}>
            <Icon name="CircleCheck" className={cn("size-4", tone)} />
            <span>
              {passed} / {list.length} passed
            </span>
            {running.length > 0 ? <span className="text-xs text-muted-foreground">· {running.length} running</span> : null}
          </button>
        )}
      >
        {(close) => (
          <div className="flex max-h-[70vh] flex-col">
            <input
              autoFocus
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter pull request checks…"
              aria-label="Filter checks"
              className="border-b border-border bg-transparent px-4 py-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
            />
            {failing.length > 0 ? (
              <div className="border-b border-border p-1">
                <MenuItem
                  disabled={agentThreadId === null || pending}
                  onSelect={() => {
                    close();
                    run(rpc.call("checks_to_agent", { threadId: agentThreadId!, key: pr.key }), "Failing checks queued on the thread");
                  }}
                >
                  <Icon name="ArrowUpRight" className="size-4" />
                  Resolve with agent
                  {agentThreadId === null ? <span className="text-xs text-muted-foreground">(no thread on this branch)</span> : null}
                </MenuItem>
              </div>
            ) : null}
            <div className="overflow-y-auto p-1">
              {sorted.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">No check matches.</p> : null}
              {sorted.map((check) => (
                <UrlLink
                  key={check.id}
                  href={check.url ?? pr.url + "/checks"}
                  target="_blank"
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground no-underline hover:bg-accent"
                >
                  <CheckStateIcon state={check.state} />
                  <span className="min-w-0 flex-1 truncate">
                    {check.workflow ? <span className="text-muted-foreground">{check.workflow} / </span> : null}
                    {check.name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {check.state === "running" ? "running" : check.state === "queued" ? "queued" : checkDuration(check)}
                  </span>
                </UrlLink>
              ))}
            </div>
          </div>
        )}
      </Popover>
      {[...failing, ...running].slice(0, 6).map((check) => (
        <UrlLink
          key={check.id}
          href={check.url ?? pr.url + "/checks"}
          target="_blank"
          className="flex items-center gap-2 text-foreground no-underline hover:underline"
        >
          <span
            aria-hidden
            className={cn(
              "mx-1 size-2 shrink-0 rounded-full",
              check.state === "failure" || check.state === "cancelled" ? "bg-destructive" : "animate-pulse bg-amber-500",
            )}
          />
          <span className="min-w-0 truncate">{check.name}</span>
        </UrlLink>
      ))}
    </SideBlock>
  );
}

function SidebarFiles({ pr, onOpenFile }: { pr: PrDetail; onOpenFile: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<FileGroup>>(new Set(["Tests", "Documentation"]));
  const groups = (["Implementation", "Tests", "Documentation"] as const)
    .map((group) => ({ group, files: pr.files.filter((file) => fileGroup(file.path) === group) }))
    .filter((entry) => entry.files.length > 0);
  const toggle = (group: FileGroup) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  return (
    <SideBlock title={`${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"} changed`}>
      {groups.map(({ group, files }) => {
        const additions = files.reduce((sum, file) => sum + file.additions, 0);
        const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
        const isOpen = !collapsed.has(group);
        return (
          <div key={group}>
            <button type="button" onClick={() => toggle(group)} aria-expanded={isOpen} className="flex w-full items-center gap-1.5 text-left">
              <span>{group}</span>
              <span className="text-muted-foreground">{files.length}</span>
              <Icon name="ChevronRight" className={cn("size-3 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
              <span className="ml-auto font-mono text-xs">
                {additions > 0 ? <span className="text-[#3fb950]">+{additions}</span> : null}{" "}
                {deletions > 0 ? <span className="text-destructive">-{deletions}</span> : null}
              </span>
            </button>
            {isOpen ? (
              <ul className="ml-1.5 mt-1 space-y-1 border-l border-border pl-3">
                {files.map((file) => {
                  const slash = file.path.lastIndexOf("/");
                  return (
                    <li key={file.path}>
                      <button type="button" onClick={() => onOpenFile(file.path)} title={file.path} className="flex w-full min-w-0 items-baseline gap-1.5 text-left hover:underline">
                        <span className="shrink-0 truncate">{file.path.slice(slash + 1)}</span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground/70">{slash === -1 ? "" : file.path.slice(0, slash)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
      {pr.files.length < pr.changedFiles ? (
        <p className="text-xs text-muted-foreground">Showing the first {pr.files.length}; the Diff tab has them all.</p>
      ) : null}
    </SideBlock>
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
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-xs text-muted-foreground">Activity</h3>
        <span className="flex-1" />
        <div role="tablist" aria-label="Comment authors" className="flex items-center gap-1">
          {AUDIENCES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={audience === item.id}
              onClick={() => setAudience(item.id)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs transition-colors",
                audience === item.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label} <span className="opacity-70">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        {open.length > 0 ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={queueVisible}>
            Queue all for the agent
          </Button>
        ) : null}
      </div>

      <div className="space-y-4">
        <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <span className="inline-flex text-emerald-500">
            <PrStateIcon pr={{ state: "OPEN", isDraft: false }} />
          </span>
          Opened by {pr.author?.login ?? "ghost"} with {pr.commitCount} {pr.commitCount === 1 ? "commit" : "commits"} · {relativeTime(pr.createdAt)}
        </p>
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
    </section>
  );
}
