import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { LinearMarkdown } from "./LinearMarkdown";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";
import { errorText } from "./shared";

type Health = "onTrack" | "atRisk" | "offTrack";

const HEALTH_OPTIONS: { value: Health; label: string; active: string }[] = [
  { value: "onTrack", label: "On track", active: "border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  { value: "atRisk", label: "At risk", active: "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  { value: "offTrack", label: "Off track", active: "border-red-500 bg-red-500/15 text-red-700 dark:text-red-400" },
];

const POLL_MS = 3_000;
const POLL_LIMIT_MS = 6 * 60_000;

type Stored = { body: string; health: Health; threadId: string | null };
/** What the update is posted on: projects and initiatives share this composer. */
export type UpdateTarget = { kind: "project" | "initiative"; id: string };

// Project drafts keep their original key so drafts in progress survive.
const storageKey = (target: UpdateTarget) =>
  target.kind === "project" ? `linear-issues:update-draft:${target.id}` : `linear-issues:initiative-update-draft:${target.id}`;

function readStored(target: UpdateTarget): Stored | null {
  try {
    return JSON.parse(localStorage.getItem(storageKey(target)) ?? "null");
  } catch {
    return null;
  }
}

/**
 * Write a project or initiative update, or have an agent draft it from its
 * recent activity. The draft stays here (and survives reloads) until you
 * post it; nothing reaches Linear before that.
 */
export function UpdateComposer({
  target,
  currentHealth,
  onPosted,
}: {
  target: UpdateTarget;
  currentHealth: Health | null;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const stored = readStored(target);
  const [body, setBody] = useState(stored?.body ?? "");
  const [health, setHealth] = useState<Health>(stored?.health ?? currentHealth ?? "onTrack");
  const [threadId, setThreadId] = useState<string | null>(stored?.threadId ?? null);
  const [notes, setNotes] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [preview, setPreview] = useState(false);
  const [posting, setPosting] = useState(false);
  const pollStarted = useRef(0);

  useEffect(() => {
    if (body.trim() === "" && threadId === null) localStorage.removeItem(storageKey(target));
    else localStorage.setItem(storageKey(target), JSON.stringify({ body, health, threadId } satisfies Stored));
  }, [target.kind, target.id, body, health, threadId]);

  // Poll the drafting thread until the agent answers.
  useEffect(() => {
    if (!drafting || threadId === null) return;
    let cancelled = false;
    // A blip while polling shouldn't abandon a draft the agent is still writing.
    let failures = 0;
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await rpc.call("update_draft_get", { threadId });
        if (cancelled) return;
        failures = 0;
        if (result.status === "ready" && result.draft) {
          setBody(result.draft.body);
          if (result.draft.health) setHealth(result.draft.health);
          setDrafting(false);
          setPreview(true);
          toast.success("Draft ready. Review it before posting.");
          return;
        }
        if (result.status === "failed") {
          setDrafting(false);
          toast.error(result.error ?? "The agent couldn't draft the update");
          return;
        }
        if (Date.now() - pollStarted.current > POLL_LIMIT_MS) {
          setDrafting(false);
          toast.error("The agent is taking long. Open its thread, then pull the draft when it's done.");
          return;
        }
      } catch (cause) {
        if (cancelled) return;
        failures += 1;
        if (failures >= 3) {
          setDrafting(false);
          toast.error(`${errorText(cause)}. The agent may still be writing: use "Pull latest draft" in a moment.`);
          return;
        }
      }
      setTimeout(tick, POLL_MS);
    };
    const timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rpc, drafting, threadId]);

  const startDraft = async () => {
    if (body.trim() !== "" && !window.confirm("Replace the current text with a new draft from the agent?")) return;
    try {
      const { threadId: id } =
        target.kind === "project"
          ? await rpc.call("update_draft_start", { projectId: target.id, notes })
          : await rpc.call("initiative_update_draft_start", { initiativeId: target.id, notes });
      setThreadId(id);
      pollStarted.current = Date.now();
      setDrafting(true);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  // After asking the agent for changes in its thread, fetch its latest version.
  const pullDraft = () => {
    pollStarted.current = Date.now();
    setDrafting(true);
  };

  const post = async () => {
    if (body.trim() === "" || posting) return;
    setPosting(true);
    try {
      if (target.kind === "project") {
        await rpc.call("project_update_create", { projectId: target.id, body, health, draftThreadId: threadId });
      } else {
        await rpc.call("initiative_update_create", { initiativeId: target.id, body, health, draftThreadId: threadId });
      }
      toast.success(`${target.kind === "project" ? "Project" : "Initiative"} update posted to Linear`);
      setBody("");
      setThreadId(null);
      setNotes("");
      setPreview(false);
      onPosted();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium">New update</h3>
        <div role="radiogroup" aria-label={`${target.kind === "project" ? "Project" : "Initiative"} health`} className="flex gap-1">
          {HEALTH_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={health === option.value}
              onClick={() => setHealth(option.value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                health === option.value ? option.active : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-2">
        <Icon name="Bot" className="size-4 shrink-0 text-muted-foreground" />
        <Input
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Optional: what should the update stress? (e.g. the Tailwind v4 migration landed)"
          aria-label="Notes for the agent"
          className="h-8 min-w-48 flex-1"
          disabled={drafting}
        />
        <Button size="sm" variant="outline" onClick={() => void startDraft()} disabled={drafting}>
          <Icon name={drafting ? "Loading" : "Edit"} className={drafting ? "size-4 animate-spin" : "size-4"} />
          {drafting ? "Agent is writing…" : "Draft with an agent"}
        </Button>
        {threadId ? (
          <>
            <button
              type="button"
              onClick={() => navigate.toThread(threadId)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Open its thread
            </button>
            {!drafting ? (
              <button
                type="button"
                onClick={pullDraft}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Pull latest draft
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mb-1 flex gap-1 text-xs">
        {(["Write", "Preview"] as const).map((label) => {
          const active = (label === "Preview") === preview;
          return (
            <button
              key={label}
              type="button"
              onClick={() => setPreview(label === "Preview")}
              className={cn("rounded px-2 py-0.5", active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {label}
            </button>
          );
        })}
      </div>
      {preview ? (
        <div className="min-h-32 rounded-md border border-border bg-background px-3 py-2">
          {body.trim() ? (
            <LinearMarkdown content={body} />
          ) : (
            <p className="text-sm italic text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={`Where does the ${target.kind} stand? What shipped, what's next, any risks…`}
          aria-label={`${target.kind === "project" ? "Project" : "Initiative"} update`}
          rows={8}
          disabled={drafting}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        />
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Markdown · saved locally until you post</span>
        {body.trim() ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm("Discard this draft?")) {
                setBody("");
                setThreadId(null);
              }
            }}
            disabled={posting || drafting}
          >
            Discard
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void post()} disabled={posting || drafting || body.trim() === ""}>
          <Icon name={posting ? "Loading" : "Sent"} className={posting ? "size-4 animate-spin" : "size-4"} />
          Post update
        </Button>
      </div>
    </section>
  );
}
