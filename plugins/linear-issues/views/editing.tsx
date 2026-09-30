import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { WriteOptions } from "../writes";
import type { rpcContract } from "../server";
import { PriorityIcon, errorText } from "./shared";

// Teams, states, people, labels and projects: one fetch per page load.
let optionsCache: Promise<WriteOptions> | null = null;

export function useWriteOptions(): WriteOptions | null {
  const rpc = useRpc<typeof rpcContract>();
  const [options, setOptions] = useState<WriteOptions | null>(null);
  useEffect(() => {
    optionsCache ??= rpc.call("write_options");
    optionsCache.then(setOptions, () => {
      optionsCache = null;
    });
  }, [rpc]);
  return options;
}

export const PRIORITY_CHOICES = [
  { value: 0, label: "No priority" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
];

export type Choice = { key: string; label: string; hint?: string | null; marker?: ReactNode };

/** A searchable single- or multi-select in a popover, used by every picker. */
export function ChoiceMenu({
  trigger,
  choices,
  selected,
  onSelect,
  multiple = false,
  searchable = choices.length > 8,
  label,
  disabled = false,
}: {
  trigger: ReactNode;
  choices: Choice[];
  selected: readonly string[];
  onSelect: (keys: string[]) => void;
  multiple?: boolean;
  searchable?: boolean;
  label: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visible = needle ? choices.filter((c) => c.label.toLowerCase().includes(needle) || c.hint?.toLowerCase().includes(needle)) : choices;
  const toggle = (key: string) => {
    if (!multiple) {
      onSelect([key]);
      setOpen(false);
      return;
    }
    onSelect(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  };
  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-accent/60 disabled:opacity-60"
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} mobileTitle={label} className="w-64 p-1">
        {searchable ? (
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Find ${label.toLowerCase()}`} aria-label={`Find ${label.toLowerCase()}`} className="mb-1 h-8" />
        ) : null}
        <div className="max-h-72 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Nothing matches.</p>
          ) : (
            visible.map((choice) => (
              <button
                key={choice.key}
                type="button"
                onClick={() => toggle(choice.key)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                {multiple ? <Checkbox checked={selected.includes(choice.key)} tabIndex={-1} aria-hidden /> : null}
                {choice.marker}
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {choice.hint ? <span className="shrink-0 text-xs text-muted-foreground">{choice.hint}</span> : null}
                {!multiple && selected.includes(choice.key) ? <Icon name="Check" className="size-3.5 shrink-0" /> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const dot = (color: string, square = false) => (
  <span aria-hidden className={cn("size-2.5 shrink-0", square ? "rounded-sm" : "rounded-full")} style={{ background: color }} />
);

export function stateChoices(team: WriteOptions["teams"][number] | undefined): Choice[] {
  return (team?.states ?? []).map((state) => ({ key: state.id, label: state.name, marker: dot(state.color) }));
}
export function memberChoices(team: WriteOptions["teams"][number] | undefined, includeNone = true): Choice[] {
  return [
    ...(includeNone ? [{ key: "none", label: "Unassigned" }] : []),
    ...(team?.members ?? []).map((member) => ({ key: member.id, label: member.displayName || member.name, hint: member.name !== member.displayName ? member.name : null })),
  ];
}
export function labelChoices(options: WriteOptions, teamId: string | null): Choice[] {
  return options.labels
    .filter((label) => label.teamId === null || label.teamId === teamId)
    .map((label) => ({ key: label.id, label: label.name, hint: label.group, marker: dot(label.color) }));
}
export function projectChoices(options: WriteOptions, teamId: string | null, includeNone = true): Choice[] {
  return [
    ...(includeNone ? [{ key: "none", label: "No project" }] : []),
    ...options.projects
      .filter((project) => !project.closed && (teamId === null || project.teamIds.includes(teamId)))
      .map((project) => ({ key: project.id, label: project.name, marker: dot(project.color, true) })),
  ];
}
export const priorityChoices: Choice[] = PRIORITY_CHOICES.map((p) => ({ key: String(p.value), label: p.label, marker: <PriorityIcon priority={p.value} label={p.label} /> }));

export function useMilestones(projectId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [milestones, setMilestones] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!projectId) return setMilestones([]);
    let cancelled = false;
    rpc.call("project_milestones", { projectId }).then((result) => !cancelled && setMilestones(result.milestones), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);
  return milestones;
}

const FIELD = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

const shown = (choices: Choice[], keys: readonly string[], placeholder: string) => {
  const picked = choices.filter((c) => keys.includes(c.key));
  if (picked.length === 0) return <span className="text-muted-foreground">{placeholder}</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {picked[0]!.marker}
      <span className="truncate">{picked.map((c) => c.label).join(", ")}</span>
    </span>
  );
};

/** Create an issue from the Linear page. */
export function IssueFormDialog({
  open,
  onOpenChange,
  defaults,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults?: { projectId?: string };
  onCreated: (identifier: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const options = useWriteOptions();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("0");
  const [stateId, setStateId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState("none");
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [projectId, setProjectId] = useState(defaults?.projectId ?? "none");
  const [milestoneId, setMilestoneId] = useState("none");
  const [saving, setSaving] = useState(false);
  const team = options?.teams.find((candidate) => candidate.id === teamId) ?? options?.teams[0];
  const milestones = useMilestones(projectId === "none" ? null : projectId);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setPriority("0");
    setStateId(null);
    setAssigneeId("none");
    setLabelIds([]);
    setProjectId(defaults?.projectId ?? "none");
    setMilestoneId("none");
  }, [open, defaults?.projectId]);

  const create = async () => {
    if (!team || !title.trim() || saving) return;
    setSaving(true);
    try {
      const result = await rpc.call("issue_create", {
        teamId: team.id,
        title: title.trim(),
        ...(description.trim() ? { description } : {}),
        ...(priority !== "0" ? { priority: Number(priority) } : {}),
        ...(stateId ? { stateId } : {}),
        ...(assigneeId !== "none" ? { assigneeId } : {}),
        ...(labelIds.length ? { labelIds } : {}),
        ...(projectId !== "none" ? { projectId } : {}),
        ...(projectId !== "none" && milestoneId !== "none" ? { projectMilestoneId: milestoneId } : {}),
      });
      toast.success(`Created ${result.identifier}`);
      onOpenChange(false);
      onCreated(result.identifier);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const states = stateChoices(team);
  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogDescription>Created in Linear right away, under your name.</DialogDescription>
        </DialogHeader>
        {options === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Issue title" aria-label="Title" />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (Markdown)" aria-label="Description" rows={6} className={cn(FIELD, "resize-y")} />
            <div className="grid gap-1 sm:grid-cols-2">
              {options.teams.length > 1 ? (
                <Field label="Team">
                  <ChoiceMenu label="Team" choices={options.teams.map((t) => ({ key: t.id, label: `${t.key} · ${t.name}` }))} selected={team ? [team.id] : []} onSelect={([key]) => { setTeamId(key!); setStateId(null); }} trigger={shown(options.teams.map((t) => ({ key: t.id, label: t.key })), team ? [team.id] : [], "Team")} />
                </Field>
              ) : null}
              <Field label="Status">
                <ChoiceMenu label="Status" choices={states} selected={stateId ? [stateId] : []} onSelect={([key]) => setStateId(key!)} trigger={shown(states, stateId ? [stateId] : [], "Team default")} />
              </Field>
              <Field label="Priority">
                <ChoiceMenu label="Priority" choices={priorityChoices} selected={[priority]} onSelect={([key]) => setPriority(key!)} trigger={shown(priorityChoices, [priority], "No priority")} />
              </Field>
              <Field label="Assignee">
                <ChoiceMenu label="Assignee" choices={memberChoices(team)} selected={[assigneeId]} onSelect={([key]) => setAssigneeId(key!)} trigger={shown(memberChoices(team), [assigneeId], "Unassigned")} />
              </Field>
              <Field label="Labels">
                <ChoiceMenu label="Labels" multiple choices={labelChoices(options, team?.id ?? null)} selected={labelIds} onSelect={setLabelIds} trigger={shown(labelChoices(options, team?.id ?? null), labelIds, "No labels")} />
              </Field>
              <Field label="Project">
                <ChoiceMenu label="Project" choices={projectChoices(options, team?.id ?? null)} selected={[projectId]} onSelect={([key]) => { setProjectId(key!); setMilestoneId("none"); }} trigger={shown(projectChoices(options, null), [projectId], "No project")} />
              </Field>
              {projectId !== "none" && milestones.length ? (
                <Field label="Milestone">
                  <ChoiceMenu label="Milestone" choices={[{ key: "none", label: "No milestone" }, ...milestones.map((m) => ({ key: m.id, label: m.name }))]} selected={[milestoneId]} onSelect={([key]) => setMilestoneId(key!)} trigger={shown(milestones.map((m) => ({ key: m.id, label: m.name })), [milestoneId], "No milestone")} />
                </Field>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void create()} disabled={saving || !title.trim()}>
                <Icon name={saving ? "Loading" : "Plus"} className={saving ? "size-4 animate-spin" : "size-4"} />
                Create issue
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export type ProjectFormValues = {
  id?: string;
  name: string;
  description: string;
  content: string;
  statusId: string | null;
  leadId: string | null;
  startDate: string | null;
  targetDate: string | null;
  teamIds: string[];
};

/** Create or edit a project. */
export function ProjectFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: ProjectFormValues | null;
  onSaved: (projectId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const options = useWriteOptions();
  const [values, setValues] = useState<ProjectFormValues>(emptyProject());
  const [saving, setSaving] = useState(false);
  const editing = Boolean(initial?.id);

  useEffect(() => {
    if (open) setValues(initial ?? { ...emptyProject(), teamIds: options?.teams.length === 1 ? [options.teams[0]!.id] : [] });
  }, [open, initial, options]);

  const set = <K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const people = useMemo(() => {
    const seen = new Map<string, Choice>();
    for (const team of options?.teams ?? []) for (const choice of memberChoices(team, false)) seen.set(choice.key, choice);
    return [{ key: "none", label: "No lead" }, ...seen.values()];
  }, [options]);
  const statuses: Choice[] = (options?.projectStatuses ?? []).map((status) => ({ key: status.id, label: status.name, marker: dot(status.color) }));

  const save = async () => {
    if (!values.name.trim() || saving) return;
    setSaving(true);
    const fields = {
      name: values.name.trim(),
      description: values.description,
      content: values.content,
      ...(values.statusId ? { statusId: values.statusId } : {}),
      leadId: values.leadId,
      startDate: values.startDate || null,
      targetDate: values.targetDate || null,
    };
    try {
      if (editing) {
        await rpc.call("project_edit", { id: initial!.id!, fields });
        toast.success("Project updated");
        onOpenChange(false);
        onSaved(initial!.id!);
      } else {
        if (values.teamIds.length === 0) throw new Error("Pick at least one team");
        const result = await rpc.call("project_create", {
          ...fields,
          ...(fields.leadId === null ? { leadId: undefined } : {}),
          startDate: fields.startDate ?? undefined,
          targetDate: fields.targetDate ?? undefined,
          teamIds: values.teamIds,
        });
        toast.success("Project created");
        onOpenChange(false);
        onSaved(result.id);
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>{editing ? "Changes are saved to Linear right away." : "Created in Linear right away, under your name."}</DialogDescription>
        </DialogHeader>
        {options === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <Input autoFocus value={values.name} onChange={(e) => set("name", e.target.value)} placeholder="Project name" aria-label="Name" />
            <Input value={values.description} onChange={(e) => set("description", e.target.value.slice(0, 255))} placeholder="One-line summary" aria-label="Summary" />
            <textarea value={values.content} onChange={(e) => set("content", e.target.value)} placeholder="Description (Markdown): goal, scope, how success is measured" aria-label="Description" rows={7} className={cn(FIELD, "resize-y")} />
            <div className="grid gap-1 sm:grid-cols-2">
              {!editing ? (
                <Field label="Teams">
                  <ChoiceMenu label="Teams" multiple choices={options.teams.map((t) => ({ key: t.id, label: `${t.key} · ${t.name}` }))} selected={values.teamIds} onSelect={(keys) => set("teamIds", keys)} trigger={shown(options.teams.map((t) => ({ key: t.id, label: t.key })), values.teamIds, "Pick teams")} />
                </Field>
              ) : null}
              <Field label="Status">
                <ChoiceMenu label="Status" choices={statuses} selected={values.statusId ? [values.statusId] : []} onSelect={([key]) => set("statusId", key!)} trigger={shown(statuses, values.statusId ? [values.statusId] : [], "Default")} />
              </Field>
              <Field label="Lead">
                <ChoiceMenu label="Lead" choices={people} selected={[values.leadId ?? "none"]} onSelect={([key]) => set("leadId", key === "none" ? null : key!)} trigger={shown(people, [values.leadId ?? "none"], "No lead")} />
              </Field>
              <Field label="Start">
                <input type="date" value={values.startDate ?? ""} onChange={(e) => set("startDate", e.target.value || null)} aria-label="Start date" className={cn(FIELD, "h-8 py-1")} />
              </Field>
              <Field label="Target">
                <input type="date" value={values.targetDate ?? ""} onChange={(e) => set("targetDate", e.target.value || null)} aria-label="Target date" className={cn(FIELD, "h-8 py-1")} />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={() => void save()} disabled={saving || !values.name.trim()}>
                <Icon name={saving ? "Loading" : "Check"} className={saving ? "size-4 animate-spin" : "size-4"} />
                {editing ? "Save" : "Create project"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function emptyProject(): ProjectFormValues {
  return { name: "", description: "", content: "", statusId: null, leadId: null, startDate: null, targetDate: null, teamIds: [] };
}
