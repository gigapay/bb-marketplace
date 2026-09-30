import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ProjectSummary } from "../projects";
import type { ProjectTriageProposalDto, rpcContract } from "../server";
import { ConfidencePill } from "./Triage";
import { EmptyState, ErrorLine, errorText } from "./shared";

type Flag = ProjectTriageProposalDto["flags"][number];
type Tone = "red" | "amber" | "grey";

const TONE_ROW: Record<Tone, string> = {
  red: "border-red-500 bg-red-500/5",
  amber: "border-amber-500 bg-amber-500/5",
  grey: "border-border bg-transparent",
};
const TONE_TEXT: Record<Tone, string> = {
  red: "text-red-600 dark:text-red-400",
  amber: "text-amber-600 dark:text-amber-400",
  grey: "text-muted-foreground",
};
const HEALTH_LABEL: Record<string, string> = { onTrack: "On track", atRisk: "At risk", offTrack: "Off track" };

function describeFlag(flag: Flag): { tone: Tone; title: string; detail: string; action: "update" | "open" | null } {
  switch (flag.kind) {
    case "update-due":
      return {
        tone: "amber",
        title: "Update due",
        detail:
          flag.daysSinceUpdate === null
            ? `No project update yet (expected every ${flag.everyWeeks} weeks)`
            : `Last update ${flag.daysSinceUpdate} days ago (expected every ${flag.everyWeeks} weeks)`,
        action: "update",
      };
    case "overdue":
      return { tone: "red", title: "Overdue", detail: `Target date passed ${flag.daysOverdue} days ago`, action: "open" };
    case "behind":
      return {
        tone: "amber",
        title: "Behind",
        detail: `${Math.round(flag.progress * 100)}% done with ${Math.round(flag.elapsed * 100)}% of the time elapsed`,
        action: "open",
      };
    case "no-lead":
      return { tone: "grey", title: "No lead", detail: "Nobody owns this project", action: "open" };
    case "no-target":
      return { tone: "grey", title: "No target", detail: "No target date set", action: "open" };
    case "health":
      return {
        tone: flag.suggested === "offTrack" ? "red" : "amber",
        title: "Health",
        detail: `Says ${HEALTH_LABEL[flag.stated ?? ""] ?? "nothing"}, looks ${HEALTH_LABEL[flag.suggested] ?? flag.suggested} (${Math.round(flag.confidence * 100)}%)`,
        action: "update",
      };
    case "thin-description":
      return { tone: "grey", title: "Description", detail: "Doesn't explain the goal, scope or success criteria", action: "open" };
  }
}

const STATUS_TONE: Record<string, Tone | "green"> = { completed: "green", paused: "amber", canceled: "red" };

/** Jev reviews your projects; only the status changes you check reach Linear. */
export function ProjectTriageDialog({
  open,
  onOpenChange,
  projects,
  onOpenProject,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectSummary[];
  onOpenProject: (projectId: string, tab?: "updates") => void;
  onApplied: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [phase, setPhase] = useState<"confirm" | "running" | "review" | "applying">("confirm");
  const [proposals, setProposals] = useState<ProjectTriageProposalDto[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const active = projects.filter((project) => !["completed", "canceled"].includes(project.status?.type ?? "")).slice(0, 40);
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));

  useEffect(() => {
    if (open) {
      setPhase("confirm");
      setError(null);
    }
  }, [open]);

  const run = async () => {
    setPhase("running");
    setError(null);
    try {
      const result = await rpc.call("project_triage_run", { projectIds: active.map((project) => project.id) });
      setProposals(result.proposals);
      setSelected(new Set());
      setPhase("review");
    } catch (cause) {
      setError(errorText(cause));
      setPhase("confirm");
    }
  };

  const apply = async () => {
    const updates = proposals.flatMap((proposal) =>
      proposal.changes.filter((_, index) => selected.has(`${proposal.projectId}:${index}`)).slice(0, 1).map((change) => ({ projectId: proposal.projectId, statusId: change.statusId })),
    );
    if (updates.length === 0) return;
    setPhase("applying");
    try {
      const { results } = await rpc.call("project_triage_apply", { updates });
      const failed = results.filter((result) => result.error !== null);
      if (failed.length) toast.error(`${failed.length} of ${results.length} status changes failed: ${failed[0]!.error}`);
      else toast.success(`Updated ${results.length} ${results.length === 1 ? "project" : "projects"} in Linear`);
      onApplied();
      if (!failed.length) onOpenChange(false);
      else setPhase("review");
    } catch (cause) {
      toast.error(errorText(cause));
      setPhase("review");
    }
  };

  const withFindings = proposals.filter((proposal) => proposal.flags.length || proposal.changes.length || proposal.error);
  const healthy = proposals.length - withFindings.length;
  const go = (projectId: string, tab?: "updates") => {
    onOpenChange(false);
    onOpenProject(projectId, tab);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => phase !== "applying" && onOpenChange(next)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="linear-issues/linear" className="size-4 text-[#5E6AD2]" />
            Triage projects with Jev
          </DialogTitle>
          <DialogDescription>
            Checks update cadence, deadlines, pace and ownership, and asks Jev about health and descriptions. Only status
            changes you check are applied.
          </DialogDescription>
        </DialogHeader>
        <ErrorLine error={error} />

        {phase === "confirm" ? (
          <div className="space-y-3 text-sm">
            <p>
              Review the {active.length} active {active.length === 1 ? "project" : "projects"} in this list? Their
              description, latest update and progress are sent to TypeSafe's Jev through OpenRouter.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void run()} disabled={active.length === 0}>
                <Icon name="Play" className="size-4" />
                Run triage
              </Button>
            </div>
          </div>
        ) : phase === "running" ? (
          <EmptyState>
            <span className="inline-flex items-center gap-2">
              <Icon name="Loading" className="size-4 animate-spin" />
              Reviewing {active.length} projects…
            </span>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <div className="max-h-[60vh] min-w-0 space-y-2 overflow-y-auto overflow-x-hidden pr-1">
              {withFindings.length === 0 ? (
                <EmptyState>Every project looks in good shape.</EmptyState>
              ) : (
                withFindings.map((proposal) => {
                  const worst = proposal.flags.some((flag) => describeFlag(flag).tone === "red") ? "red" : proposal.flags.length ? "amber" : "grey";
                  return (
                    <section
                      key={proposal.projectId}
                      className={cn(
                        "rounded-lg border bg-card p-3",
                        worst === "red" ? "border-red-500/40" : worst === "amber" ? "border-amber-500/40" : "border-border",
                      )}
                    >
                      <header className="mb-1.5 flex items-start gap-2 text-sm">
                        <button
                          type="button"
                          onClick={() => go(proposal.projectId)}
                          className="min-w-0 flex-1 break-words text-left font-medium hover:underline"
                        >
                          {nameOf.get(proposal.projectId) ?? proposal.name}
                        </button>
                      </header>
                      {proposal.error ? <p className="text-xs text-destructive">Couldn't review: {proposal.error}</p> : null}
                      <ul className="space-y-1">
                        {proposal.flags.map((flag, index) => {
                          const { tone, title, detail, action } = describeFlag(flag);
                          return (
                            <li key={`flag-${index}`} className={cn("flex items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-sm", TONE_ROW[tone])}>
                              <span className={cn("mt-0.5 w-20 shrink-0 text-xs font-semibold uppercase tracking-wide", TONE_TEXT[tone])}>{title}</span>
                              <span className="min-w-0 flex-1 break-words">{detail}</span>
                              {action ? (
                                <button
                                  type="button"
                                  onClick={() => go(proposal.projectId, action === "update" ? "updates" : undefined)}
                                  className="shrink-0 self-start text-xs text-sky-600 hover:underline dark:text-sky-400"
                                >
                                  {action === "update" ? "Draft update" : "Open"}
                                </button>
                              ) : null}
                            </li>
                          );
                        })}
                        {proposal.changes.map((change, index) => {
                          const key = `${proposal.projectId}:${index}`;
                          const tone = STATUS_TONE[change.statusType] ?? "grey";
                          const row =
                            tone === "green" ? "border-emerald-500 bg-emerald-500/5" : TONE_ROW[tone as Tone];
                          const text =
                            tone === "green" ? "text-emerald-600 dark:text-emerald-400" : TONE_TEXT[tone as Tone];
                          const checked = selected.has(key);
                          return (
                            <li key={key} className={cn("rounded-md border-l-2 transition-opacity", row, !checked && "opacity-70")}>
                              <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm">
                                <Checkbox
                                  className="mt-0.5"
                                  checked={checked}
                                  disabled={phase === "applying"}
                                  onCheckedChange={(on) =>
                                    setSelected((current) => {
                                      // One status per project: checking one unchecks its siblings.
                                      const next = new Set([...current].filter((k) => !k.startsWith(`${proposal.projectId}:`)));
                                      if (on === true) next.add(key);
                                      return next;
                                    })
                                  }
                                />
                                <span className={cn("mt-0.5 w-20 shrink-0 text-xs font-semibold uppercase tracking-wide", text)}>
                                  → {change.statusName}
                                </span>
                                <span className="min-w-0 flex-1 break-words">{change.reason}</span>
                                <span className="mt-0.5 shrink-0 self-start">
                                  <ConfidencePill value={change.confidence} />
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })
              )}
              {healthy > 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {healthy} {healthy === 1 ? "project" : "projects"} with nothing to flag.
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="mr-auto text-xs text-muted-foreground">Status changes are never pre-checked.</span>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={phase === "applying"}>
                Close
              </Button>
              <Button onClick={() => void apply()} disabled={phase === "applying" || selected.size === 0}>
                <Icon name={phase === "applying" ? "Loading" : "Check"} className={phase === "applying" ? "size-4 animate-spin" : "size-4"} />
                Apply {selected.size} {selected.size === 1 ? "change" : "changes"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
