import { useEffect, useMemo, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { InitiativeDetail, InitiativeSummary } from "../initiatives";
import type { ProjectSummary } from "../projects";
import type { rpcContract } from "../server";
import { useWriteOptions } from "./editing";
import { LinearMarkdown } from "./LinearMarkdown";
import { HealthBadge, ProgressBar, ProjectMark, Section, UpdateCard, formatDate } from "./Projects";
import { EmptyState, ErrorLine, PriorityIcon, errorText, relativeTime } from "./shared";

type Status = InitiativeSummary["status"];

// Linear's order, and a colour per status like its own glyphs.
const STATUS_ORDER: Status[] = ["Active", "Planned", "Proposed", "Completed", "Canceled"];
const STATUS_COLOR: Record<Status, string> = {
  Active: "#e2b93b",
  Planned: "#5e6ad2",
  Proposed: "#8a8f98",
  Completed: "#4cb782",
  Canceled: "#8a8f98",
};
const CLOSED = new Set<Status>(["Completed", "Canceled"]);
const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

function InitiativeStatusBadge({ status }: { status: Status }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-2 rounded-full" style={{ background: STATUS_COLOR[status] }} />
      {status}
    </span>
  );
}

function InitiativeMark({ initiative, className }: { initiative: Pick<InitiativeSummary, "color" | "name">; className?: string }) {
  return <ProjectMark project={{ name: initiative.name, color: initiative.color ?? "#5e6ad2" }} className={cn("rounded-full", className)} />;
}

export function InitiativeList({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const options = useWriteOptions();
  const [initiatives, setInitiatives] = useState<InitiativeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rpc.call("initiatives_list").then(
      (result) => !cancelled && setInitiatives(result.initiatives),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const groups = useMemo(() => {
    const viewer = options?.viewer.id ?? null;
    const visible = (initiatives ?? []).filter(
      (initiative) => (includeClosed || !CLOSED.has(initiative.status)) && (!mine || initiative.owner?.id === viewer),
    );
    return STATUS_ORDER.map((status) => ({ status, items: visible.filter((i) => i.status === status) })).filter((g) => g.items.length);
  }, [initiatives, options, mine, includeClosed]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={mine} onCheckedChange={(checked) => setMine(checked === true)} />
          Only mine (owner)
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={includeClosed} onCheckedChange={(checked) => setIncludeClosed(checked === true)} />
          Show completed
        </label>
      </div>
      <ErrorLine error={error} />
      <div className="mt-4 space-y-4">
        {initiatives === null ? (
          error === null ? <EmptyState>Loading initiatives…</EmptyState> : null
        ) : groups.length === 0 ? (
          <EmptyState>No initiatives here.</EmptyState>
        ) : (
          groups.map((group) => (
            <section key={group.status}>
              <h3 className="flex items-center gap-2 px-1 py-1.5 text-sm font-medium">
                <span aria-hidden className="size-2.5 rounded-full" style={{ background: STATUS_COLOR[group.status] }} />
                {group.status}
                <span className="text-muted-foreground">{group.items.length}</span>
              </h3>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {group.items.map((initiative) => (
                  <li key={initiative.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(initiative.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                    >
                      <InitiativeMark initiative={initiative} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{initiative.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {initiative.parent ? `${initiative.parent.name} · ` : ""}
                          {initiative.projectCount} {initiative.projectCount === 1 ? "project" : "projects"}
                          {initiative.description ? ` · ${initiative.description}` : ""}
                        </span>
                      </span>
                      <HealthBadge health={initiative.health} />
                      {initiative.progress !== null ? (
                        <span className="hidden w-28 shrink-0 md:inline-flex">
                          <ProgressBar value={initiative.progress} color={initiative.color ?? "#5e6ad2"} />
                        </span>
                      ) : null}
                      <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground lg:inline">
                        {initiative.owner?.name ?? ""}
                      </span>
                      <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground lg:inline">
                        {formatDate(initiative.targetDate) ?? ""}
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

// Project status types, in the order Linear groups them.
const PROJECT_STATUS_ORDER = ["started", "paused", "planned", "backlog", "completed", "canceled"];
const HEALTH_ROWS: { key: ProjectSummary["health"]; label: string; color: string }[] = [
  { key: null, label: "No update expected", color: "#8a8f98" },
  { key: "offTrack", label: "Off track", color: "#eb5757" },
  { key: "atRisk", label: "At risk", color: "#e2b93b" },
  { key: "onTrack", label: "On track", color: "#4cb782" },
];

export function InitiativeDetailView({
  initiativeId,
  onBack,
  onOpenProject,
  onOpenInitiative,
}: {
  initiativeId: string;
  onBack?: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenInitiative: (initiativeId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [initiative, setInitiative] = useState<InitiativeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "updates" | "projects">("overview");

  useEffect(() => {
    let cancelled = false;
    setInitiative(null);
    setError(null);
    rpc.call("initiative_get", { id: initiativeId }).then(
      (result) => !cancelled && setInitiative(result),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, initiativeId]);

  return (
    <div>
      {onBack ? (
        <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
          <Icon name="ArrowLeft" className="size-4" />
          Initiatives
        </Button>
      ) : null}
      <ErrorLine error={error} />
      {initiative === null ? (
        error === null ? (
          <div className="mt-3">
            <EmptyState>Loading initiative…</EmptyState>
          </div>
        ) : null
      ) : (
        <article className="mt-2">
          <header className="flex flex-wrap items-start gap-3">
            <InitiativeMark initiative={initiative} className="mt-0.5 size-7 text-sm" />
            <div className="min-w-0 flex-1">
              {initiative.parent ? (
                <button
                  type="button"
                  onClick={() => onOpenInitiative(initiative.parent!.id)}
                  className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                  {initiative.parent.name}
                </button>
              ) : null}
              <h1 className="text-xl font-semibold leading-tight">{initiative.name}</h1>
              {initiative.description ? <p className="mt-1 text-sm text-muted-foreground">{initiative.description}</p> : null}
            </div>
            <Button variant="outline" size="sm" asChild>
              <UrlLink href={initiative.url} target="_blank" data-linear-external="">
                <Icon name="ExternalLink" className="size-4" />
                Open in Linear
              </UrlLink>
            </Button>
          </header>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card p-3 text-sm">
            <InitiativeStatusBadge status={initiative.status} />
            <HealthBadge health={initiative.health} />
            {initiative.progress !== null ? <ProgressBar value={initiative.progress} color={initiative.color ?? "#5e6ad2"} /> : null}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <PriorityIcon priority={initiative.priority} label={PRIORITY_LABELS[initiative.priority] ?? ""} />
              {PRIORITY_LABELS[initiative.priority] ?? ""}
            </span>
            {initiative.owner ? (
              <span className="text-xs text-muted-foreground">
                Owner <span className="text-foreground">{initiative.owner.name}</span>
              </span>
            ) : null}
            {initiative.targetDate ? (
              <span className="text-xs text-muted-foreground">Target {formatDate(initiative.targetDate)}</span>
            ) : null}
          </div>

          {initiative.links.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs text-muted-foreground">Resources</span>
              {initiative.links.map((link) => (
                <UrlLink
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent/50"
                >
                  <Icon name="FileText" className="size-3.5" />
                  {link.label || link.url}
                  <Icon name="ArrowUpRight" className="size-3" />
                </UrlLink>
              ))}
            </div>
          ) : null}

          <div role="tablist" aria-label="Initiative sections" className="mt-5 flex gap-1 border-b border-border">
            {(
              [
                ["overview", "Overview"],
                ["updates", `Updates${initiative.updates.length ? ` ${initiative.updates.length}` : ""}`],
                ["projects", `Projects ${initiative.projects.length}`],
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
                {initiative.updates[0] ? (
                  <Section title="Latest update">
                    <UpdateCard update={initiative.updates[0]} readOnly />
                  </Section>
                ) : null}
                <Section title="Description">
                  {initiative.content?.trim() ? (
                    <LinearMarkdown content={initiative.content} />
                  ) : (
                    <p className="text-sm italic text-muted-foreground">No description.</p>
                  )}
                </Section>
                {initiative.projects.length ? (
                  <Section title="Project health">
                    <HealthBreakdown projects={initiative.projects} />
                  </Section>
                ) : null}
                {initiative.subInitiatives.length ? (
                  <Section title="Sub-initiatives">
                    <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                      {initiative.subInitiatives.map((sub) => (
                        <li key={sub.id}>
                          <button
                            type="button"
                            onClick={() => onOpenInitiative(sub.id)}
                            className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                          >
                            <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                            <HealthBadge health={sub.health} />
                            <InitiativeStatusBadge status={sub.status} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            ) : tab === "updates" ? (
              initiative.updates.length === 0 ? (
                <EmptyState>No initiative updates yet.</EmptyState>
              ) : (
                <ol className="space-y-3">
                  {initiative.updates.map((update) => (
                    <li key={update.id}>
                      <UpdateCard update={update} readOnly />
                    </li>
                  ))}
                </ol>
              )
            ) : (
              <ProjectTable projects={initiative.projects} onOpen={onOpenProject} />
            )}
          </div>
        </article>
      )}
    </div>
  );
}

/** Like Linear's health panel: how many projects sit in each health. */
function HealthBreakdown({ projects }: { projects: ProjectSummary[] }) {
  const total = projects.length;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        {HEALTH_ROWS.map((row) => {
          const count = projects.filter((project) => project.health === row.key).length;
          return count ? <span key={row.label} style={{ width: `${(count / total) * 100}%`, background: row.color }} /> : null;
        })}
      </div>
      <ul className="space-y-1.5 text-sm">
        {HEALTH_ROWS.map((row) => {
          const count = projects.filter((project) => project.health === row.key).length;
          if (!count) return null;
          return (
            <li key={row.label} className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 rounded-full" style={{ background: row.color }} />
              <span className="flex-1">{row.label}</span>
              <span className="text-muted-foreground">{count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The initiative's projects, grouped by status like Linear's table. */
function ProjectTable({ projects, onOpen }: { projects: ProjectSummary[]; onOpen: (projectId: string) => void }) {
  if (projects.length === 0) return <EmptyState>No projects in this initiative.</EmptyState>;
  const groups = PROJECT_STATUS_ORDER.map((type) => ({
    type,
    items: projects
      .filter((project) => (project.status?.type ?? "backlog") === type)
      .sort((a, b) => (a.priority || 5) - (b.priority || 5)),
  })).filter((group) => group.items.length);
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.type}>
          <h3 className="px-1 py-1.5 text-xs font-medium text-muted-foreground">{group.items[0]!.status?.name ?? "No status"}</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {group.items.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => onOpen(project.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                >
                  <ProjectMark project={project} />
                  <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
                  <HealthBadge health={project.health} />
                  <PriorityIcon priority={project.priority} label={project.priorityLabel} />
                  <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground md:inline">
                    {project.lead?.name ?? ""}
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground lg:inline">
                    {formatDate(project.targetDate) ?? ""}
                  </span>
                  <span className="w-24 shrink-0">
                    <ProgressBar value={project.progress} color={project.status?.color ?? project.color} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="px-1 text-xs text-muted-foreground">Updated {relativeTime(projects.map((p) => p.updatedAt).sort().at(-1)!)}</p>
    </div>
  );
}

