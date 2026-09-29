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
}: {
  item: FeedItem;
  prKey: string;
  onChanged: () => Promise<void> | void;
  /** The tab shows file:line; the diff already sits on the line. */
  showPath: boolean;
  queue?: { queued: boolean; onToggle: () => void };
  /** Extra footer buttons, like "Send to thread" in the diff. */
  actions?: ReactNode;
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
      className={cn(
        "rounded-lg border bg-card text-card-foreground",
        queue?.queued ? "border-primary" : "border-border",
        item.isResolved && "opacity-80",
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2 text-xs">
        {queue && !item.isResolved ? (
          <Checkbox checked={queue.queued} onCheckedChange={queue.onToggle} aria-label="Queue for the agent" />
        ) : null}
        <Author actor={item.author} />
        <span className="text-muted-foreground">{relativeTime(item.createdAt)}</span>
        {showPath && item.kind === "thread" ? (
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {item.path}
            {item.line !== null ? `:${item.line}` : ""}
          </span>
        ) : null}
        {item.kind === "review" && item.reviewState ? (
          <span className="text-muted-foreground">{item.reviewState.toLowerCase().replace("_", " ")}</span>
        ) : null}
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
        <UrlLink href={item.url} target="_blank" aria-label="Open on GitHub" className="text-muted-foreground hover:text-foreground">
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
          <div className="border-t border-border px-3 py-2">
            <Markdown content={item.body} className="text-sm" />
          </div>
          {item.replies.length > 0 ? (
            <ol className="space-y-3 border-t border-border px-3 py-3">
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
          <footer className="border-t border-border px-3 py-2">
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
                <button type="button" onClick={() => setReplying(true)} className="text-muted-foreground hover:text-foreground">
                  Reply
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

function Author({ actor }: { actor: Actor | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {actor ? <img src={actor.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" /> : null}
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
