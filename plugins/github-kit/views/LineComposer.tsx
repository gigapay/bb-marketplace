// The comment box that opens from the diff gutter, with Linear's three modes:
// Agent queues the note on the BB thread, Comment posts one review comment
// now, Review adds it to the pending review until you submit.
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { toast } from "sonner";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { addDraft, removeDraft, type Draft, type LineAnchor } from "./reviewDrafts";
import { errorText } from "./shared";

type Mode = "agent" | "comment" | "review";

function anchorLabel(anchor: LineAnchor): string {
  const lines = anchor.startLine === null ? `line ${anchor.line}` : `lines ${anchor.startLine}–${anchor.line}`;
  return anchor.side === "LEFT" ? `${lines} (old)` : lines;
}

export function LineComposer({
  anchor,
  prKey,
  agentThreadId,
  onDone,
  onPosted,
}: {
  anchor: LineAnchor;
  prKey: string;
  /** The thread the Agent mode queues on; null disables it. */
  agentThreadId: string | null;
  onDone: () => void;
  onPosted: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("review");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = body.trim();
    if (text === "" || sending) return;
    if (mode === "review") {
      addDraft(prKey, anchor, text);
      onDone();
      return;
    }
    setSending(true);
    try {
      if (mode === "agent") {
        await rpc.call("line_to_agent", { threadId: agentThreadId!, key: prKey, anchor, body: text });
        toast.success("Queued on the thread");
      } else {
        await rpc.call("review_comment", { key: prKey, anchor, body: text });
        toast.success("Comment posted to GitHub");
        await onPosted();
      }
      onDone();
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
    } else if (event.key === "Escape") {
      event.preventDefault();
      onDone();
    }
  };

  const modes: { id: Mode; label: string; icon: string; disabled: boolean; hint: string }[] = [
    {
      id: "agent",
      label: "Agent",
      icon: "ArrowUpRight",
      disabled: agentThreadId === null,
      hint: agentThreadId === null ? "No BB thread works on this branch" : "Queue this note on the thread",
    },
    { id: "comment", label: "Comment", icon: "MessageSquare", disabled: false, hint: "Post one comment on GitHub now" },
    { id: "review", label: "Review", icon: "Check", disabled: false, hint: "Add to your pending review" },
  ];

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <span>{anchorLabel(anchor)}</span>
        <span className="flex-1" />
        <button type="button" aria-label="Cancel" onClick={onDone} className="hover:text-foreground">
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={mode === "agent" ? "Tell the agent what to change…" : "Add comment to review…"}
        aria-label="Comment"
        rows={3}
        disabled={sending}
        className="w-full resize-y bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:opacity-60"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <span className="ml-1 text-xs text-muted-foreground">⌘/Ctrl+Enter</span>
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Send as" className="flex rounded-md border border-border p-0.5">
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              title={item.hint}
              disabled={item.disabled}
              onClick={() => setMode(item.id)}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:opacity-40",
                mode === item.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon name={item.icon} className="size-3.5" />
              {item.label}
            </button>
          ))}
        </div>
        <Button size="icon" aria-label="Send" onClick={() => void send()} disabled={sending || body.trim() === ""} className="size-7">
          <Icon name={sending ? "Loading" : "ArrowUp"} className={sending ? "size-4 animate-spin" : "size-4"} />
        </Button>
      </div>
    </div>
  );
}

/** A comment waiting in your pending review. */
export function PendingComment({ draft, prKey }: { draft: Draft; prKey: string }) {
  return (
    <div className="rounded-lg border border-dashed border-primary/60 bg-card text-card-foreground">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">Pending</span>
        <span className="text-muted-foreground">{anchorLabel(draft.anchor)} · sent when you submit the review</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Delete pending comment"
          onClick={() => removeDraft(prKey, draft.id)}
          className="text-muted-foreground hover:text-foreground"
        >
          <Icon name="Trash2" className="size-3.5" />
        </button>
      </div>
      <div className="border-t border-border px-3 py-2">
        <Markdown content={draft.body} className="text-sm" />
      </div>
    </div>
  );
}
