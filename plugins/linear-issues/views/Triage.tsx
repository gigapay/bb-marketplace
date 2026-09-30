import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { IssueSummary, TriageChangeDto, TriageProposalDto, rpcContract } from "../server";
import { EmptyState, ErrorLine, errorText } from "./shared";

const MAX_ISSUES = 50;

type Phase =
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "review"; proposals: TriageProposalDto[] }
  | { kind: "applying"; proposals: TriageProposalDto[] };

const changeKey = (issueId: string, index: number) => `${issueId}:${index}`;

function describe(change: TriageChangeDto): { verb: string; detail: string } {
  if (change.kind === "priority") return { verb: "Priority", detail: `${change.currentLabel} → ${change.label}` };
  if (change.kind === "project") return { verb: "Project", detail: `→ ${change.label}` };
  return { verb: change.group === "type" ? "Type label" : "Area label", detail: `+ ${change.label}` };
}

function ConfidencePill({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px]",
        value >= 0.85 ? "bg-primary/15 text-primary" : value >= 0.7 ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground",
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
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issues: IssueSummary[];
  onApplied: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
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
      const { proposals } = await rpc.call("triage_run", { issueIds: batch.map((issue) => issue.id) });
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
        const kept = proposal.changes.filter((_, index) => selected.has(changeKey(proposal.issueId, index)));
        if (kept.length === 0) return [];
        const priority = kept.find((change) => change.kind === "priority");
        const project = kept.find((change) => change.kind === "project");
        const labels = kept.flatMap((change) => (change.kind === "label" ? [change.labelId] : []));
        return [
          {
            issueId: proposal.issueId,
            ...(priority?.kind === "priority" ? { priority: priority.value } : {}),
            ...(project?.kind === "project" ? { projectId: project.projectId } : {}),
            ...(labels.length ? { addedLabelIds: labels } : {}),
          },
        ];
      }),
    [proposals, selected],
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
            <Icon name="linear-issues/linear" className="size-4 text-[#5E6AD2]" />
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
            <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
              {withChanges.length === 0 ? (
                <EmptyState>Jev found nothing to change. Everything looks triaged.</EmptyState>
              ) : (
                withChanges.map((proposal) => (
                  <section key={proposal.issueId} className="rounded-lg border border-border bg-card p-3">
                    <header className="mb-1.5 flex items-center gap-2 text-sm">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{proposal.identifier}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{proposal.title}</span>
                      {proposal.needsInfo ? (
                        <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                          Needs more info
                        </span>
                      ) : null}
                    </header>
                    {proposal.error ? <p className="text-xs text-destructive">Jev failed: {proposal.error}</p> : null}
                    <ul className="space-y-1">
                      {proposal.changes.map((change, index) => {
                        const key = changeKey(proposal.issueId, index);
                        const { verb, detail } = describe(change);
                        return (
                          <li key={key}>
                            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/40">
                              <Checkbox
                                checked={selected.has(key)}
                                onCheckedChange={(checked) => toggle(key, checked === true)}
                                disabled={phase.kind === "applying"}
                              />
                              <span className="w-24 shrink-0 text-muted-foreground">{verb}</span>
                              <span className="min-w-0 flex-1 truncate">{detail}</span>
                              <ConfidencePill value={change.confidence} />
                            </label>
                          </li>
                        );
                      })}
                    </ul>
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
