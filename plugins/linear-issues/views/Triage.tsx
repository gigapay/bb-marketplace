import { useEffect, useMemo, useState } from "react";
import { LINEAR_ICON } from "@/lib/plugin-id";
import { toast } from "sonner";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { IssueSummary, TriageChangeDto, TriageProposalDto, rpcContract } from "../server";
import { EmptyState, ErrorLine, PriorityIcon, errorText } from "./shared";
import { LINKED_ISSUE_PREFIX } from "../shared/links";

const MAX_ISSUES = 50;

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "review"; proposals: TriageProposalDto[] }
  | { kind: "applying"; proposals: TriageProposalDto[] };

const changeKey = (issueId: string, index: number) => `${issueId}:${index}`;

// Each kind of change gets its own colour so a long review reads at a glance:
// amber priority, the label's own Linear colour, violet project, blue comment,
// red for the one destructive action.
type Tone = "priority" | "label" | "project" | "comment" | "cancel";

const TONES: Record<Tone, { row: string; verb: string }> = {
  priority: { row: "border-amber-500 bg-amber-500/5", verb: "text-amber-600 dark:text-amber-400" },
  label: { row: "border-border bg-transparent", verb: "text-muted-foreground" },
  project: { row: "border-violet-500 bg-violet-500/5", verb: "text-violet-600 dark:text-violet-400" },
  comment: { row: "border-sky-500 bg-sky-500/5", verb: "text-sky-600 dark:text-sky-400" },
  cancel: { row: "border-red-500 bg-red-500/10", verb: "text-red-600 dark:text-red-400" },
};

const PRIORITY_NUMBERS: Record<string, number> = { "No priority": 0, Urgent: 1, High: 2, Medium: 3, Low: 4 };

function ChangeSummary({ change }: { change: TriageChangeDto }) {
  if (change.kind === "priority") {
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
        <PriorityIcon priority={PRIORITY_NUMBERS[change.currentLabel] ?? 0} label={change.currentLabel} />
        <span className="text-muted-foreground line-through decoration-muted-foreground/50">{change.currentLabel}</span>
        <Icon name="ArrowRight" className="size-3 text-muted-foreground" />
        <PriorityIcon priority={change.value} label={change.label} />
        <span className="font-medium">{change.label}</span>
      </span>
    );
  }
  if (change.kind === "label") {
    return (
      <span
        className="inline-flex max-w-full items-center gap-1.5 break-words rounded-full border px-2 py-0.5 text-xs font-medium"
        style={change.color ? { borderColor: `${change.color}80`, backgroundColor: `${change.color}1a` } : undefined}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: change.color ?? "currentColor" }} />
        <span className="min-w-0">+ {change.label}</span>
      </span>
    );
  }
  // Everything wraps: review text is read, not scanned, and it must never
  // push the dialog wider than the screen.
  if (change.kind === "project") return <span className="block break-words font-medium">→ {change.label}</span>;
  if (change.kind === "cancel") return <span className="block break-words">{change.reason}</span>;
  return (
    <span className="block">
      <span className="text-muted-foreground">Ask the reporter for:</span>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {change.gaps.map((gap) => (
          <li key={gap} className="break-words">
            {gap}
          </li>
        ))}
      </ul>
    </span>
  );
}

const VERBS: Record<TriageChangeDto["kind"], string> = {
  priority: "Priority",
  label: "Label",
  project: "Project",
  comment: "Comment",
  cancel: "Cancel",
};

export function ConfidencePill({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px] font-medium",
        value >= 0.85
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : value >= 0.7
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
            : "bg-muted text-muted-foreground",
      )}
      aria-label={`${percent}% confident`}
    >
      {percent}%
    </span>
  );
}

/** Jev proposes, you review, and only the checked changes reach Linear. */
export function TriageDialog({
  open,
  onOpenChange,
  issues,
  linkedIdentifiers,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issues: IssueSummary[];
  /** Issues with a BB thread; they're never proposed for cancellation. */
  linkedIdentifiers: ReadonlySet<string>;
  onApplied: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [edited, setEdited] = useState<ReadonlyMap<string, string>>(new Map());
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const batch = issues.slice(0, MAX_ISSUES);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "confirm" });
    setError(null);
    rpc.call("triage_status").then(
      (status) => setConfigured(status.configured),
      () => setConfigured(false),
    );
  }, [open, rpc]);

  const run = async () => {
    setError(null);
    setPhase({ kind: "running" });
    try {
      const { proposals } = await rpc.call("triage_run", {
        issueIds: batch.map((issue) => issue.id),
        linkedIssueIds: issues.filter((issue) => linkedIdentifiers.has(issue.identifier)).map((issue) => issue.id),
      });
      setEdited(new Map());
      setSelected(
        new Set(
          proposals.flatMap((proposal) =>
            proposal.changes.flatMap((change, index) => (change.preselected ? [changeKey(proposal.issueId, index)] : [])),
          ),
        ),
      );
      setPhase({ kind: "review", proposals });
    } catch (cause) {
      setError(errorText(cause));
      setPhase({ kind: "confirm" });
    }
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const proposals = phase.kind === "review" || phase.kind === "applying" ? phase.proposals : [];
  const withChanges = proposals.filter((proposal) => proposal.changes.length > 0 || proposal.needsInfo || proposal.error);
  const untouched = proposals.length - withChanges.length;

  const updates = useMemo(
    () =>
      proposals.flatMap((proposal) => {
        const kept = proposal.changes
          .map((change, index) => ({ change, key: changeKey(proposal.issueId, index) }))
          .filter(({ key }) => selected.has(key));
        if (kept.length === 0) return [];
        const find = <K extends TriageChangeDto["kind"]>(kind: K) =>
          kept.find(({ change }) => change.kind === kind) as { change: Extract<TriageChangeDto, { kind: K }>; key: string } | undefined;
        const priority = find("priority");
        const project = find("project");
        const cancel = find("cancel");
        const comment = find("comment");
        const labels = kept.flatMap(({ change }) => (change.kind === "label" ? [change.labelId] : []));
        const text = (entry: { key: string; change: { comment?: string; body?: string } } | undefined) =>
          entry ? (edited.get(entry.key) ?? entry.change.body ?? entry.change.comment ?? "").trim() : "";
        const comments = [text(comment), text(cancel)].filter((body) => body !== "");
        return [
          {
            issueId: proposal.issueId,
            ...(priority ? { priority: priority.change.value } : {}),
            ...(project ? { projectId: project.change.projectId } : {}),
            ...(cancel ? { stateId: cancel.change.stateId } : {}),
            ...(labels.length ? { addedLabelIds: labels } : {}),
            ...(comments.length ? { comments } : {}),
          },
        ];
      }),
    [proposals, selected, edited],
  );

  const apply = async () => {
    if (phase.kind !== "review" || updates.length === 0) return;
    setPhase({ kind: "applying", proposals: phase.proposals });
    try {
      const { results } = await rpc.call("triage_apply", { updates });
      const failed = results.filter((result) => result.error !== null);
      if (failed.length === 0) {
        toast.success(`Updated ${results.length} ${results.length === 1 ? "issue" : "issues"} in Linear`);
        onOpenChange(false);
      } else {
        toast.error(`${failed.length} of ${results.length} updates failed: ${failed[0]!.error}`);
        setPhase({ kind: "review", proposals: phase.proposals });
      }
      onApplied();
    } catch (cause) {
      toast.error(errorText(cause));
      setPhase({ kind: "review", proposals: phase.proposals });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => phase.kind !== "applying" && onOpenChange(next)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name={LINEAR_ICON} className="size-4 text-[#5E6AD2]" />
            Triage with Jev
          </DialogTitle>
          <DialogDescription>
            Jev suggests priority, labels and project. Nothing changes in Linear until you apply.
          </DialogDescription>
        </DialogHeader>

        <ErrorLine error={error} />

        {phase.kind === "confirm" ? (
          configured === false ? (
            <EmptyState>
              Add an OpenRouter API key in Settings → Plugins → Linear Issues, or run{" "}
              <code>bb plugin config linear-issues set openRouterApiKey &lt;key&gt;</code>.
            </EmptyState>
          ) : (
            <div className="space-y-3 text-sm">
              <p>
                Triage the {batch.length} {batch.length === 1 ? "issue" : "issues"} in this list
                {issues.length > MAX_ISSUES ? ` (the first ${MAX_ISSUES} of ${issues.length})` : ""}? Their title,
                description and latest comments are sent to TypeSafe's Jev through OpenRouter, one request per issue.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={() => void run()} disabled={configured === null || batch.length === 0}>
                  <Icon name="Play" className="size-4" />
                  Run triage
                </Button>
              </div>
            </div>
          )
        ) : phase.kind === "running" ? (
          <EmptyState>
            <span className="inline-flex items-center gap-2">
              <Icon name="Loading" className="size-4 animate-spin" />
              Asking Jev about {batch.length} {batch.length === 1 ? "issue" : "issues"}…
            </span>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <div className="max-h-[60vh] min-w-0 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
              {withChanges.length === 0 ? (
                <EmptyState>Jev found nothing to change. Everything looks triaged.</EmptyState>
              ) : (
                withChanges.map((proposal) => (
                  <section
                    key={proposal.issueId}
                    className={cn(
                      "rounded-lg border bg-card p-3",
                      proposal.changes.some((change) => change.kind === "cancel")
                        ? "border-red-500/40"
                        : proposal.needsInfo
                          ? "border-amber-500/40"
                          : "border-border",
                    )}
                  >
                    <header className="mb-1.5 flex items-start gap-2 text-sm">
                      <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{proposal.identifier}</span>
                      <span className="min-w-0 flex-1 break-words font-medium">{proposal.title}</span>
                      {proposal.needsInfo ? (
                        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          Needs more info
                        </span>
                      ) : null}
                    </header>
                    {proposal.error ? <p className="text-xs text-destructive">Jev failed: {proposal.error}</p> : null}
                    <ul className="space-y-1">
                      {proposal.changes.map((change, index) => {
                        const key = changeKey(proposal.issueId, index);
                        const checked = selected.has(key);
                        const tone = TONES[change.kind];
                        const editable = change.kind === "comment" || change.kind === "cancel";
                        return (
                          <li key={key} className={cn("rounded-md border-l-2 transition-opacity", tone.row, !checked && "opacity-60")}>
                            <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm">
                              <Checkbox
                                className="mt-0.5"
                                checked={checked}
                                onCheckedChange={(on) => toggle(key, on === true)}
                                disabled={phase.kind === "applying"}
                              />
                              <span className={cn("mt-0.5 w-16 shrink-0 text-xs font-semibold uppercase tracking-wide", tone.verb)}>
                                {VERBS[change.kind]}
                              </span>
                              <span className="min-w-0 flex-1 break-words">
                                <ChangeSummary change={change} />
                              </span>
                              <span className="mt-0.5 shrink-0 self-start">
                                <ConfidencePill value={change.confidence} />
                              </span>
                            </label>
                            {editable && checked ? (
                              <textarea
                                value={edited.get(key) ?? (change.kind === "comment" ? change.body : change.comment)}
                                onChange={(event) => setEdited((current) => new Map(current).set(key, event.target.value))}
                                aria-label="Comment posted to Linear"
                                rows={change.kind === "comment" ? 4 : 2}
                                className="mx-2 mb-2 w-[calc(100%-1rem)] resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    {proposal.needsInfo ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          navigate.toCompose({ initialPrompt: enrichPrompt(proposal), focusPrompt: true });
                        }}
                        className="mt-2 inline-flex items-center gap-1.5 text-xs text-sky-600 hover:underline dark:text-sky-400"
                      >
                        <Icon name="Search" className="size-3.5" />
                        Enrich with an agent
                      </button>
                    ) : null}
                  </section>
                ))
              )}
              {untouched > 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {untouched} {untouched === 1 ? "issue" : "issues"} with nothing to change.
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">
                Confident changes are pre-checked; the rest are yours to pick.
              </span>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={phase.kind === "applying"}>
                Discard
              </Button>
              <Button onClick={() => void apply()} disabled={phase.kind === "applying" || updates.length === 0}>
                <Icon name={phase.kind === "applying" ? "Loading" : "Check"} className={phase.kind === "applying" ? "size-4 animate-spin" : "size-4"} />
                Apply {selected.size} {selected.size === 1 ? "change" : "changes"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A thread where an agent reads the code and drafts what the ticket is missing. */
function enrichPrompt(proposal: TriageProposalDto): string {
  const gaps = proposal.changes.flatMap((change) => (change.kind === "comment" ? change.gaps : []));
  return [
    `${proposal.identifier}: enrich the ticket "${proposal.title}"`,
    "",
    `${LINKED_ISSUE_PREFIX}${proposal.identifier}`,
    "",
    `Jev flagged this ticket as not ready to start.${gaps.length ? " Missing:" : ""}`,
    ...gaps.map((gap) => `- ${gap}`),
    "",
    `Run \`bb linear show ${proposal.identifier}\` to read it, then investigate the codebase and draft a clearer description: the problem, expected behaviour, acceptance criteria, the code areas involved, and open questions for the reporter.`,
    "Don't change anything in Linear. Post the draft here so I can review it.",
  ].join("\n");
}
