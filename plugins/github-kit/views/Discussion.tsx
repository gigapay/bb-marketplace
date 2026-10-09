// A GitHub discussion, laid out like the Linear plugin's: the root comment,
// replies on a rail, then Reply / Resolve. Resolved threads start collapsed.
// Used by the PR tab and inline in the diff.
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { toast } from "sonner";
import { Markdown, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Actor, FeedItem } from "../detail";
import type { rpcContract } from "../server";
import { errorText, relativeTime } from "./shared";

export function Discussion({
  item,
  prKey,
  onChanged,
  showPath,
  queue,
  actions,
  onOpenInDiff,
}: {
  item: FeedItem;
  prKey: string;
  onChanged: () => Promise<void> | void;
  /** The tab shows file:line; the diff already sits on the line. */
  showPath: boolean;
  queue?: { queued: boolean; onToggle: () => void };
  /** Extra footer buttons, like "Send to thread" in the diff. */
  actions?: ReactNode;
  /** Set in the overview: the file:line chip opens the thread in the Diff tab. */
  onOpenInDiff?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [expanded, setExpanded] = useState(!item.isResolved);
  const [replying, setReplying] = useState(false);
  const [resolving, setResolving] = useState(false);

  const setResolved = (resolved: boolean) => {
    setResolving(true);
    rpc.call("thread_resolve", { key: prKey, itemId: item.id, resolved }).then(
      async () => {
        toast.success(resolved ? "Resolved on GitHub" : "Reopened on GitHub");
        if (resolved) setExpanded(false);
        await onChanged();
        setResolving(false);
      },
      (cause) => {
        toast.error(errorText(cause));
        setResolving(false);
      },
    );
  };

  return (
    <article
      id={threadAnchorId(item.id)}
      className={cn(
        "rounded-xl border bg-card text-card-foreground",
        queue?.queued ? "border-primary" : "border-border/70",
        item.isResolved && "opacity-80",
      )}
    >
      <header className="flex items-center gap-2 px-4 pb-1 pt-3 text-sm">
        {queue && !item.isResolved ? (
          <Checkbox checked={queue.queued} onCheckedChange={queue.onToggle} aria-label="Queue for the agent" />
        ) : null}
        <Author actor={item.author} />
        <span className="text-muted-foreground">{relativeTime(item.createdAt)}</span>
        {showPath && item.kind === "thread" ? (
          onOpenInDiff ? (
            <button
              type="button"
              onClick={onOpenInDiff}
              title="Open in the Diff tab"
              className="min-w-0 truncate text-left font-mono text-muted-foreground hover:text-foreground hover:underline"
            >
              {item.path}
              {item.line !== null ? `:${item.line}` : ""}
            </button>
          ) : (
            <span className="min-w-0 truncate font-mono text-muted-foreground">
              {item.path}
              {item.line !== null ? `:${item.line}` : ""}
            </span>
          )
        ) : null}
        {item.kind === "review" && item.reviewState ? <ReviewStateChip state={item.reviewState} /> : null}
        {item.isOutdated ? <span className="shrink-0 text-[#bf8700]">Outdated</span> : null}
        {item.isResolved ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-[#1f883d]">
            <Icon name="Check" className="size-3" />
            Resolved{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </span>
        ) : null}
        <span className="flex-1" />
        {!expanded && item.replies.length > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            {item.replies.length} {item.replies.length === 1 ? "reply" : "replies"}
          </span>
        ) : null}
        <UrlLink data-github-kit-external="" href={item.url} target="_blank" aria-label="Open on GitHub" className="text-muted-foreground hover:text-foreground">
          <Icon name="ExternalLink" className="size-3.5" />
        </UrlLink>
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon name="ChevronRight" className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        </button>
      </header>

      {expanded ? (
        <>
          {showPath && item.kind === "thread" && item.diffHunk ? <HunkPreview hunk={item.diffHunk} onOpen={onOpenInDiff} /> : null}
          <div className="px-4 pb-3 pt-1">
            <Markdown content={item.body} className="text-[15px] leading-relaxed" />
          </div>
          {item.replies.length > 0 ? (
            <ol className="space-y-3 border-t border-border/70 px-4 py-3">
              {item.replies.map((reply) => (
                <li key={reply.id} className="ml-2 border-l-2 border-border pl-3">
                  <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <Author actor={reply.author} />
                    <span>{relativeTime(reply.createdAt)}</span>
                  </p>
                  <Markdown content={reply.body} className="text-sm" />
                </li>
              ))}
            </ol>
          ) : null}
          <footer className="border-t border-border/70 px-4 py-2.5">
            {replying ? (
              <Composer
                prKey={prKey}
                itemId={item.id}
                placeholder={item.kind === "thread" ? "Reply…" : "Reply (posts a comment quoting this one)…"}
                autoFocus
                onPosted={async () => {
                  setReplying(false);
                  await onChanged();
                }}
                onCancel={() => setReplying(false)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => setReplying(true)}
                  className="min-w-40 flex-1 text-left text-sm text-muted-foreground hover:text-foreground"
                >
                  Leave a reply…
                </button>
                {item.kind === "thread" && (item.isResolved ? item.canUnresolve : item.canResolve) ? (
                  <button
                    type="button"
                    onClick={() => setResolved(!item.isResolved)}
                    disabled={resolving}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {resolving ? "…" : item.isResolved ? "Unresolve" : "Resolve"}
                  </button>
                ) : null}
                <span className="flex-1" />
                {actions}
              </div>
            )}
          </footer>
        </>
      ) : null}
    </article>
  );
}

/** DOM id of a review thread, so the Diff tab can scroll to it. */
export function threadAnchorId(itemId: string): string {
  return `github-kit-thread-${itemId}`;
}

const PREVIEW_LINES = 6;

/**
 * The last lines of the diff hunk a review comment sits on, like GitHub's
 * conversation view: GitHub's hunk ends on the commented line.
 */
function HunkPreview({ hunk, onOpen }: { hunk: string; onOpen?: () => void }) {
  const lines = hunk.split("\n").filter((line) => !line.startsWith("@@")).slice(-PREVIEW_LINES);
  if (lines.length === 0) return null;
  const body = (
    <pre className="overflow-x-auto py-1.5 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "whitespace-pre px-3",
            line.startsWith("+") && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
            line.startsWith("-") && "bg-destructive/10 text-destructive",
            !line.startsWith("+") && !line.startsWith("-") && "text-muted-foreground",
            index === lines.length - 1 && "font-semibold",
          )}
        >
          {line === "" ? " " : line}
        </div>
      ))}
    </pre>
  );
  return (
    <div className="mx-4 mb-2 mt-1 overflow-hidden rounded-md border border-border/70 bg-muted/30">
      {onOpen ? (
        <button type="button" onClick={onOpen} title="Open in the Diff tab" className="block w-full text-left hover:bg-muted/50">
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}

const REVIEW_STATE_CHIP: Record<string, { label: string; className: string }> = {
  APPROVED: { label: "Approved", className: "text-emerald-500" },
  CHANGES_REQUESTED: { label: "Changes requested", className: "text-destructive" },
  COMMENTED: { label: "Reviewed", className: "text-muted-foreground" },
  DISMISSED: { label: "Dismissed", className: "text-muted-foreground" },
};

function ReviewStateChip({ state }: { state: string }) {
  const chip = REVIEW_STATE_CHIP[state] ?? { label: state.toLowerCase(), className: "text-muted-foreground" };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 text-xs", chip.className)}>
      <Icon name={state === "APPROVED" ? "Check" : "MessageSquare"} className="size-3" />
      {chip.label}
    </span>
  );
}

function Author({ actor }: { actor: Actor | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {actor ? <img src={actor.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" /> : null}
      <span className="truncate font-medium text-foreground">{actor?.login ?? "ghost"}</span>
      {actor?.isBot ? (
        <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent-foreground">bot</span>
      ) : null}
    </span>
  );
}

export function Composer({
  prKey,
  itemId,
  placeholder,
  autoFocus = false,
  onPosted,
  onCancel,
}: {
  prKey: string;
  /** null posts a new top-level PR comment. */
  itemId: string | null;
  placeholder: string;
  autoFocus?: boolean;
  onPosted: () => Promise<void> | void;
  onCancel?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = body.trim();
    if (text === "" || sending) return;
    setSending(true);
    try {
      await rpc.call("comment_post", { key: prKey, itemId, body: text });
      setBody("");
      toast.success(itemId === null ? "Comment posted to GitHub" : "Reply posted to GitHub");
      await onPosted();
    } catch (cause) {
      // Keep the text so nothing typed is lost.
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        rows={itemId === null ? 3 : 2}
        disabled={sending}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Markdown · ⌘/Ctrl+Enter to send</span>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={sending}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void send()} disabled={sending || body.trim() === ""}>
          <Icon name={sending ? "Loading" : "ArrowUp"} className={sending ? "size-4 animate-spin" : "size-4"} />
          {itemId === null ? "Comment" : "Reply"}
        </Button>
      </div>
    </div>
  );
}
