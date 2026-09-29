import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { toast } from "sonner";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { proxyLinearUploads } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import type { IssueComment, IssueDetail, rpcContract } from "../server";
import { groupCommentThreads, type CommentThread } from "../shared/comments";
import { errorText, relativeTime } from "./shared";

/** Linear's discussions: root comments with their replies, plus a composer. */
export function CommentThreads({ issue, onChanged }: { issue: IssueDetail; onChanged: () => void }) {
  const threads = useMemo(() => groupCommentThreads(issue.comments), [issue.comments]);
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const [showResolved, setShowResolved] = useState(false);

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        Activity <span className="font-normal text-muted-foreground">{issue.comments.length}</span>
      </h3>
      <div className="space-y-3">
        {open.map((thread) => (
          <Discussion key={thread.root.id} issueId={issue.id} thread={thread} onChanged={onChanged} />
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
                {resolved.map((thread) => (
                  <Discussion key={thread.root.id} issueId={issue.id} thread={thread} onChanged={onChanged} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <CommentComposer issueId={issue.id} parentId={null} placeholder="Leave a comment…" onPosted={onChanged} />
      </div>
    </section>
  );
}

function Discussion({
  issueId,
  thread,
  onChanged,
}: {
  issueId: string;
  thread: CommentThread<IssueComment>;
  onChanged: () => void;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <article className={cn("rounded-lg border border-border bg-card", thread.resolved && "opacity-75")}>
      <div className="p-3">
        <CommentBody comment={thread.root} />
        {thread.resolved ? (
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Icon name="Check" className="size-3" />
            Resolved{thread.root.resolvedBy ? ` by ${thread.root.resolvedBy}` : ""}
          </p>
        ) : null}
      </div>
      {thread.replies.length > 0 ? (
        // Replies hang off the root with a rail, like Linear's threads.
        <ol className="space-y-3 border-t border-border px-3 py-3">
          {thread.replies.map((reply) => (
            <li key={reply.id} className="ml-2 border-l-2 border-border pl-3">
              <CommentBody comment={reply} />
            </li>
          ))}
        </ol>
      ) : null}
      <div className="border-t border-border px-3 py-2">
        {replying ? (
          <CommentComposer
            issueId={issueId}
            parentId={thread.root.id}
            placeholder="Reply…"
            autoFocus
            onPosted={() => {
              setReplying(false);
              onChanged();
            }}
            onCancel={() => setReplying(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Reply
          </button>
        )}
      </div>
    </article>
  );
}

function CommentBody({ comment }: { comment: IssueComment }) {
  const initial = comment.author.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div>
      <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-medium text-accent-foreground"
        >
          {comment.author.kind === "user" ? initial : <Icon name="Toolbox" className="size-3" />}
        </span>
        <span className="font-medium text-foreground">{comment.author.name}</span>
        <span>{relativeTime(comment.createdAt)}</span>
        {comment.editedAt ? <span>(edited)</span> : null}
      </p>
      {comment.quotedText ? (
        <blockquote className="mb-1 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {comment.quotedText}
        </blockquote>
      ) : null}
      <Markdown content={proxyLinearUploads(comment.body)} />
    </div>
  );
}

function CommentComposer({
  issueId,
  parentId,
  placeholder,
  autoFocus = false,
  onPosted,
  onCancel,
}: {
  issueId: string;
  parentId: string | null;
  placeholder: string;
  autoFocus?: boolean;
  onPosted: () => void;
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
      await rpc.call("comment_create", { issueId, body: text, parentId });
      setBody("");
      toast.success(parentId === null ? "Comment posted to Linear" : "Reply posted to Linear");
      onPosted();
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
        rows={parentId === null ? 3 : 2}
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
          {parentId === null ? "Comment" : "Reply"}
        </Button>
      </div>
    </div>
  );
}
