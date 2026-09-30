// Sticky review bar under the PR, like Linear's: Approve in one click, or
// Submit review with a summary, a verdict and the pending line comments.
import { useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { PrDetail } from "../detail";
import type { rpcContract } from "../server";
import { clearDrafts, useDrafts } from "./reviewDrafts";
import { errorText } from "./shared";

type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

const VERDICTS: { id: Verdict; label: string; hint: string }[] = [
  { id: "COMMENT", label: "Comment", hint: "General feedback, no verdict" },
  { id: "APPROVE", label: "Approve", hint: "Ready to merge" },
  { id: "REQUEST_CHANGES", label: "Request changes", hint: "Must be addressed before merging" },
];

export function ReviewBar({ pr, onSubmitted }: { pr: PrDetail; onSubmitted: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const drafts = useDrafts(pr.key);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const [sending, setSending] = useState(false);

  if (pr.state !== "OPEN") return null;
  // GitHub only takes plain comments on your own PR.
  const verdicts = pr.viewerIsAuthor ? VERDICTS.filter((item) => item.id === "COMMENT") : VERDICTS;

  const submit = async (event: Verdict, summary: string) => {
    setSending(true);
    try {
      await rpc.call("review_submit", {
        key: pr.key,
        event,
        body: summary.trim(),
        comments: drafts.map((draft) => ({ anchor: draft.anchor, body: draft.body })),
      });
      clearDrafts(pr.key);
      setBody("");
      setOpen(false);
      toast.success(event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Changes requested" : "Review submitted");
      await onSubmitted();
    } catch (cause) {
      // Drafts and the summary stay, so nothing is lost.
      toast.error(errorText(cause));
    } finally {
      setSending(false);
    }
  };

  const canSubmit = verdict === "APPROVE" || body.trim() !== "" || drafts.length > 0;

  return (
    <div className="sticky bottom-0 z-10 flex justify-end pt-2">
      <div className="w-full max-w-xl rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg">
        {open ? (
          <div className="space-y-2 p-1">
            <textarea
              autoFocus
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
                  event.preventDefault();
                  void submit(verdict, body);
                } else if (event.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="Leave a summary (optional)…"
              aria-label="Review summary"
              rows={3}
              disabled={sending}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div role="radiogroup" aria-label="Verdict" className="space-y-1">
              {verdicts.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm hover:bg-accent/40">
                  <input
                    type="radio"
                    name="verdict"
                    checked={verdict === item.id}
                    onChange={() => setVerdict(item.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{item.label}</span>
                    <span className="block text-xs text-muted-foreground">{item.hint}</span>
                  </span>
                </label>
              ))}
              {pr.viewerIsAuthor ? (
                <p className="px-1 text-xs text-muted-foreground">It's your pull request, so GitHub only takes comments.</p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {drafts.length} pending {drafts.length === 1 ? "comment" : "comments"}
              </span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={sending}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void submit(verdict, body)} disabled={sending || !canSubmit}>
                <Icon name={sending ? "Loading" : "ArrowUp"} className={cn("size-4", sending && "animate-spin")} />
                Submit review
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="ml-2 text-xs text-muted-foreground">
              {drafts.length > 0
                ? `${drafts.length} pending ${drafts.length === 1 ? "comment" : "comments"}`
                : "Hover a line number and press + to comment"}
            </span>
            <span className="flex-1" />
            {drafts.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => clearDrafts(pr.key)} disabled={sending}>
                Discard
              </Button>
            ) : null}
            {!pr.viewerIsAuthor ? (
              <Button size="sm" variant="outline" onClick={() => void submit("APPROVE", "")} disabled={sending}>
                <Icon name="Check" className="size-4 text-[#1f883d]" />
                Approve
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setOpen(true)} disabled={sending}>
              Submit review
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
