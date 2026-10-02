import { useCallback, useEffect, useMemo, useState } from "react";
import { LINEAR_ICON } from "@/lib/plugin-id";
import type { ReactNode } from "react";
import { Markdown, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { LinearMarkdown } from "./LinearMarkdown";
import { cn } from "@/lib/utils";
import type { ProjectDetail, ProjectSummary } from "../projects";
import type { IssueSummary, rpcContract } from "../server";
import { IssueGroups } from "./IssueList";
import { useIssueLinks } from "./links";
import { UpdateComposer } from "./UpdateComposer";
import { useWriteOptions } from "./editing";
import { TriageDialog } from "./Triage";
import { ProjectTriageDialog } from "./ProjectTriage";
import { IssueFormDialog, ProjectFormDialog, type ProjectFormValues } from "./editing";
import { toast } from "sonner";
import { EmptyState, ErrorLine, errorText, relativeTime } from "./shared";

// Linear's own order for project statuses.
const STATUS_ORDER = ["started", "planned", "backlog", "paused", "completed", "canceled"];

const HEALTH = {
  onTrack: { label: "On track", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  atRisk: { label: "At risk", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  offTrack: { label: "Off track", className: "bg-red-500/15 text-red-700 dark:text-red-400" },
} as const;

export function HealthBadge({ health }: { health: ProjectSummary["health"] }) {
  if (health === null) return null;
  const { label, className } = HEALTH[health];
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", className)}>{label}</span>;
}

export function StatusBadge({ status }: { status: ProjectSummary["status"] }) {
  if (status === null) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-2 rounded-full" style={{ background: status.color }} />
      {status.name}
    </span>
  );
}

export function ProgressBar({ value, color }: { value: number; color: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="inline-flex shrink-0 items-center gap-2 text-xs text-muted-foreground" aria-label={`${percent}% done`}>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${percent}%`, background: color }} />
      </span>
      {percent}%
    </span>
  );
}

export function ProjectMark({ project, className }: { project: Pick<ProjectSummary, "color" | "name">; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white", className)}
      style={{ background: project.color }}
    >
      {project.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function formatDate(value: string | null): string | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ProjectList({ onOpen }: { onOpen: (projectId: string, tab?: "updates") => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [mine, setMine] = useState(true);
  const [includeClosed, setIncludeClosed] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    rpc.call("projects_list", { mine, includeClosed }).then(
      (result) => !cancelled && setProjects(result.projects),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, mine, includeClosed, reloadNonce]);

  const groups = useMemo(() => {
    const byType = new Map<string, { status: NonNullable<ProjectSummary["status"]>; projects: ProjectSummary[] }>();
    for (const project of projects ?? []) {
      const status = project.status ?? { id: "none", name: "No status", type: "backlog", color: "#888" };
      const group = byType.get(status.type) ?? { status, projects: [] };
      group.projects.push(project);
      byType.set(status.type, group);
    }
    const rank = (type: string) => (STATUS_ORDER.indexOf(type) + STATUS_ORDER.length + 1) % (STATUS_ORDER.length + 1);
    return [...byType.values()].sort((a, b) => rank(a.status.type) - rank(b.status.type));
  }, [projects]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={mine} onCheckedChange={(checked) => setMine(checked === true)} />
          Only mine (lead or member)
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={includeClosed} onCheckedChange={(checked) => setIncludeClosed(checked === true)} />
          Show completed
        </label>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
          <Icon name="Plus" className="size-4" />
          New project
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTriageOpen(true)}
          disabled={!projects || projects.length === 0}
        >
          <Icon name={LINEAR_ICON} className="size-3.5 text-[#5E6AD2]" />
          Triage with Jev
        </Button>
      </div>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} initial={null} onSaved={(id) => onOpen(id)} />
      <ProjectTriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        projects={projects ?? []}
        onOpenProject={onOpen}
        onApplied={() => setReloadNonce((n) => n + 1)}
      />
      <ErrorLine error={error} />
      <div className="mt-4 space-y-4">
        {projects === null ? (
          error === null ? <EmptyState>Loading projects…</EmptyState> : null
        ) : projects.length === 0 ? (
          <EmptyState>No projects here.</EmptyState>
        ) : (
          groups.map((group) => (
            <section key={group.status.type}>
              <h3 className="flex items-center gap-2 px-1 py-1.5 text-sm font-medium">
                <span aria-hidden className="size-2.5 rounded-full" style={{ background: group.status.color }} />
                {group.status.name}
                <span className="text-muted-foreground">{group.projects.length}</span>
              </h3>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {group.projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(project.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                    >
                      <ProjectMark project={project} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{project.name}</span>
                        {project.description ? (
                          <span className="block truncate text-xs text-muted-foreground">{project.description}</span>
                        ) : null}
                      </span>
                      <HealthBadge health={project.health} />
                      <span className="hidden w-28 shrink-0 md:inline-flex">
                        <ProgressBar value={project.progress} color={project.color} />
                      </span>
                      <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground lg:inline">
                        {formatDate(project.targetDate) ?? ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

export function ProjectDetailView({
  projectId,
  initialTab,
  onBack,
  onOpenIssue,
}: {
  projectId: string;
  initialTab?: "overview" | "updates" | "issues";
  /** Omitted in the thread side panel, which has no list to go back to. */
  onBack?: () => void;
  onOpenIssue: (identifier: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const links = useIssueLinks();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "updates" | "issues">(initialTab ?? "overview");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  // null = every issue; "none" = issues outside any milestone.
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [editingProject, setEditingProject] = useState(false);

  const openMilestone = (id: string) => {
    setMilestoneId(id);
    setTab("issues");
  };

  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    rpc.call("project_get", { id: projectId }).then(
      (result) => !cancelled && setProject(result),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId, reloadNonce]);
  // A different project starts blank; a reload after posting keeps the page.
  useEffect(() => {
    setProject(null);
    setMilestoneId(null);
  }, [projectId]);

  // Links open a project by its URL slugId, which `project(id:)` accepts but
  // the issue filter doesn't: filter on the id Linear resolved it to.
  const resolvedId = project?.id ?? null;
  const loadIssues = useCallback(() => {
    if (resolvedId === null) return;
    let cancelled = false;
    rpc
      .call("issues_list", {
        scope: "all",
        includeCompleted,
        query: "",
        filters: { labelIds: [], priorities: [], projectIds: [resolvedId] },
      })
      .then(
        (result) => !cancelled && setIssues(result.issues),
        (cause) => !cancelled && setError(errorText(cause)),
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, resolvedId, includeCompleted]);
  useEffect(() => loadIssues(), [loadIssues]);

  // What the Issues tab shows, and what its triage button works on.
  const visibleIssues = useMemo(
    () =>
      (issues ?? []).filter((issue) =>
        milestoneId === null ? true : milestoneId === "none" ? issue.milestone === null : issue.milestone?.id === milestoneId,
      ),
    [issues, milestoneId],
  );

  return (
    <div>
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
          <Icon name="ArrowLeft" className="size-4" />
          Projects
        </Button>
      ) : null}
      <ErrorLine error={error} />
      {project === null ? (
        error === null ? (
          <div className="mt-3">
            <EmptyState>Loading project…</EmptyState>
          </div>
        ) : null
      ) : (
        <article className="mt-2">
          <header className="flex flex-wrap items-start gap-3">
            <ProjectMark project={project} className="mt-0.5 size-7 text-sm" />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold leading-tight">{project.name}</h1>
              {project.description ? <p className="mt-1 text-sm text-muted-foreground">{project.description}</p> : null}
            </div>
            <Button variant="outline" size="sm" onClick={() => setTab("updates")}>
              <Icon name="Edit" className="size-4" />
              Write update
            </Button>
            <Button variant="outline" size="sm" onClick={() => setEditingProject(true)}>
              <Icon name="Settings" className="size-4" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${project.name}`}
              onClick={() => {
                if (!window.confirm(`Move "${project.name}" to Linear's trash? It can be restored from Linear.`)) return;
                rpc.call("project_delete", { id: project.id }).then(
                  () => {
                    toast.success("Project moved to the trash");
                    onBack?.();
                  },
                  (cause) => toast.error(errorText(cause)),
                );
              }}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
            <Button variant="outline" size="sm" asChild>
              <UrlLink href={project.url} target="_blank" data-linear-external="">
                <Icon name="ExternalLink" className="size-4" />
                Open in Linear
              </UrlLink>
            </Button>
          </header>

          <ProjectFormDialog
            open={editingProject}
            onOpenChange={setEditingProject}
            initial={toFormValues(project)}
            onSaved={() => setReloadNonce((n) => n + 1)}
          />
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card p-3 text-sm">
            <StatusBadge status={project.status} />
            <HealthBadge health={project.health} />
            <ProgressBar value={project.progress} color={project.color} />
            {project.lead ? (
              <span className="text-xs text-muted-foreground">
                Lead <span className="text-foreground">{project.lead.name}</span>
              </span>
            ) : null}
            {project.startDate || project.targetDate ? (
              <span className="text-xs text-muted-foreground">
                {formatDate(project.startDate) ?? "…"} → {formatDate(project.targetDate) ?? "…"}
              </span>
            ) : null}
            {project.members.length ? (
              <span className="text-xs text-muted-foreground">{project.members.length} members</span>
            ) : null}
          </div>

          <div role="tablist" aria-label="Project sections" className="mt-5 flex gap-1 border-b border-border">
            {(
              [
                ["overview", "Overview"],
                ["updates", `Updates${project.updates.length ? ` ${project.updates.length}` : ""}`],
                ["issues", `Issues${issues ? ` ${issues.length}` : ""}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                  tab === id ? "border-[#5E6AD2] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {tab === "overview" ? (
              <div className="space-y-6">
                {project.milestones.length ? (
                  <Section title="Milestones">
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                      {project.milestones.map((milestone) => (
                        <li key={milestone.id}>
                          <button
                            type="button"
                            onClick={() => openMilestone(milestone.id)}
                            className="group flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                          >
                            <Icon name="Target" className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate group-hover:underline">{milestone.name}</span>
                            {issues ? (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {issues.filter((issue) => issue.milestone?.id === milestone.id).length} issues
                              </span>
                            ) : null}
                            <ProgressBar value={milestone.progress} color={project.color} />
                            <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                              {formatDate(milestone.targetDate) ?? ""}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                <Section title="Description">
                  {project.content?.trim() ? (
                    <LinearMarkdown content={project.content} />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">No description.</p>
                  )}
                </Section>
                {project.updates[0] ? (
                  <Section title="Latest update">
                    <UpdateCard update={project.updates[0]} onChanged={() => setReloadNonce((n) => n + 1)} />
                  </Section>
                ) : null}
              </div>
            ) : tab === "updates" ? (
              <div className="space-y-4">
                <UpdateComposer
                  projectId={project.id}
                  currentHealth={project.health}
                  onPosted={() => setReloadNonce((n) => n + 1)}
                />
                {project.updates.length === 0 ? (
                  <EmptyState>No project updates yet.</EmptyState>
                ) : (
                  <ol className="space-y-3">
                    {project.updates.map((update) => (
                      <li key={update.id}>
                        <UpdateCard update={update} onChanged={() => setReloadNonce((n) => n + 1)} />
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox checked={includeCompleted} onCheckedChange={(checked) => setIncludeCompleted(checked === true)} />
                    Show done
                  </label>
                  <Button size="sm" className="ml-auto" onClick={() => setCreatingIssue(true)}>
                    <Icon name="Plus" className="size-4" />
                    New issue
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTriageOpen(true)}
                    disabled={visibleIssues.length === 0}
                  >
                    <Icon name={LINEAR_ICON} className="size-3.5 text-[#5E6AD2]" />
                    Triage with Jev
                  </Button>
                </div>
                <IssueFormDialog
                  open={creatingIssue}
                  onOpenChange={setCreatingIssue}
                  defaults={{ projectId: project.id }}
                  onCreated={() => loadIssues()}
                />
                <TriageDialog
                  open={triageOpen}
                  onOpenChange={setTriageOpen}
                  issues={visibleIssues}
                  linkedIdentifiers={new Set(links.byIssue.keys())}
                  onApplied={loadIssues}
                />
                {issues !== null && project.milestones.length > 0 ? (
                  <MilestoneChips
                    milestones={project.milestones}
                    issues={issues}
                    selected={milestoneId}
                    color={project.color}
                    onSelect={setMilestoneId}
                  />
                ) : null}
                {issues === null ? (
                  <EmptyState>Loading issues…</EmptyState>
                ) : (
                  <IssueGroups
                    issues={visibleIssues}
                    threadCount={(identifier) => links.byIssue.get(identifier)?.length ?? 0}
                    onOpen={onOpenIssue}
                    emptyLabel={milestoneId === null ? "No issues in this project." : "No issues in this milestone."}
                  />
                )}
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}

function MilestoneChips({
  milestones,
  issues,
  selected,
  color,
  onSelect,
}: {
  milestones: ProjectDetail["milestones"];
  issues: IssueSummary[];
  selected: string | null;
  color: string;
  onSelect: (id: string | null) => void;
}) {
  const count = (id: string | null) =>
    issues.filter((issue) => (id === null ? true : id === "none" ? issue.milestone === null : issue.milestone?.id === id)).length;
  const chips = [
    { id: null, label: "All" },
    ...milestones.map((milestone) => ({ id: milestone.id, label: milestone.name })),
    { id: "none", label: "No milestone" },
  ];
  return (
    <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Milestones">
      {chips.map((chip) => {
        const active = selected === chip.id;
        return (
          <button
            key={chip.id ?? "all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(chip.id)}
            className={cn(
              "inline-flex max-w-64 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              active ? "text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
            style={active ? { borderColor: color, backgroundColor: `${color}1f` } : undefined}
          >
            {chip.id !== null && chip.id !== "none" ? <Icon name="Target" className="size-3 shrink-0" /> : null}
            <span className="truncate">{chip.label}</span>
            <span className="shrink-0 text-muted-foreground">{count(chip.id)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function toFormValues(project: ProjectDetail): ProjectFormValues {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    content: project.content ?? "",
    statusId: project.status?.id ?? null,
    leadId: project.lead?.id ?? null,
    startDate: project.startDate,
    targetDate: project.targetDate,
    teamIds: [],
  };
}

export function UpdateCard({
  update,
  onChanged,
  readOnly = false,
}: {
  update: ProjectDetail["updates"][number];
  onChanged?: () => void;
  /** Initiative updates: shown, not editable here (they have their own mutations). */
  readOnly?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const options = useWriteOptions();
  const mine = !readOnly && options !== null && update.authorId === options.viewer.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(update.body);
  const [busy, setBusy] = useState(false);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      setEditing(false);
      onChanged?.();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  if (editing) {
    return (
      <article className="space-y-2 rounded-lg border border-border bg-card p-3">
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Edit update"
          rows={8}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={() => void act(() => rpc.call("update_edit", { id: update.id, body: draft }))} disabled={busy || !draft.trim()}>
            Save
          </Button>
        </div>
      </article>
    );
  }
  return (
    <article className="rounded-lg border border-border bg-card p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <HealthBadge health={update.health} />
        <span className="font-medium text-foreground">{update.author}</span>
        <span>{relativeTime(update.createdAt)}</span>
        {update.editedAt ? <span>(edited)</span> : null}
        {mine ? (
          <>
            <button type="button" onClick={() => { setDraft(update.body); setEditing(true); }} className="hover:text-foreground" disabled={busy}>
              Edit
            </button>
            <button
              type="button"
              onClick={() => window.confirm("Archive this update?") && void act(() => rpc.call("update_archive", { id: update.id }))}
              className="hover:text-red-600"
              disabled={busy}
            >
              Archive
            </button>
          </>
        ) : null}
        <UrlLink href={update.url} target="_blank" data-linear-external="" aria-label="Open update in Linear" className="ml-auto hover:text-foreground">
          <Icon name="ExternalLink" className="size-3.5" />
        </UrlLink>
      </header>
      <LinearMarkdown content={update.body} />
    </article>
  );
}
