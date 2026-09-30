import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { FilterOptions, IssueFilters } from "../projects";
import type { IssueSummary, rpcContract } from "../server";
import { PriorityIcon } from "./shared";

export const EMPTY_FILTERS: IssueFilters = { labelIds: [], priorities: [], projectIds: [] };

export function activeFilterCount(filters: IssueFilters): number {
  return filters.labelIds.length + filters.priorities.length + filters.projectIds.length;
}

/** Same semantics as the server's filter: OR within a kind, AND across kinds. */
export function matchesFilters(filters: IssueFilters) {
  return (issue: IssueSummary) =>
    (filters.labelIds.length === 0 || issue.labels.some((label) => filters.labelIds.includes(label.id))) &&
    (filters.priorities.length === 0 || filters.priorities.includes(issue.priority)) &&
    (filters.projectIds.length === 0 ||
      (issue.project === null ? filters.projectIds.includes("none") : filters.projectIds.includes(issue.project.id)));
}

const PRIORITIES = [
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Medium" },
  { value: 4, label: "Low" },
  { value: 0, label: "No priority" },
];

// Labels and projects change rarely; one fetch per page load is plenty.
let optionsCache: Promise<FilterOptions> | null = null;

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterBar({ filters, onChange }: { filters: IssueFilters; onChange: (next: IssueFilters) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [options, setOptions] = useState<FilterOptions | null>(null);

  useEffect(() => {
    optionsCache ??= rpc.call("filter_options");
    optionsCache.then(setOptions, () => {
      optionsCache = null;
    });
  }, [rpc]);

  const labelById = useMemo(() => new Map(options?.labels.map((label) => [label.id, label]) ?? []), [options]);
  const projectById = useMemo(() => new Map(options?.projects.map((project) => [project.id, project]) ?? []), [options]);
  const count = activeFilterCount(filters);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <FilterMenu
        label="Labels"
        icon="Layers"
        summary={summarize(filters.labelIds.map((id) => labelById.get(id)?.name ?? "…"))}
        searchable
        items={(options?.labels ?? []).map((label) => ({
          key: label.id,
          label: label.name,
          hint: label.group,
          marker: <span className="size-2.5 shrink-0 rounded-full" style={{ background: label.color }} />,
          checked: filters.labelIds.includes(label.id),
          onToggle: () => onChange({ ...filters, labelIds: toggle(filters.labelIds, label.id) }),
        }))}
      />
      <FilterMenu
        label="Priority"
        icon="ChartColumn"
        summary={summarize(filters.priorities.map((value) => PRIORITIES.find((p) => p.value === value)?.label ?? ""))}
        items={PRIORITIES.map((priority) => ({
          key: String(priority.value),
          label: priority.label,
          marker: <PriorityIcon priority={priority.value} label={priority.label} />,
          checked: filters.priorities.includes(priority.value),
          onToggle: () => onChange({ ...filters, priorities: toggle(filters.priorities, priority.value) }),
        }))}
      />
      <FilterMenu
        label="Project"
        icon="Folder"
        summary={summarize(filters.projectIds.map((id) => (id === "none" ? "No project" : (projectById.get(id)?.name ?? "…"))))}
        searchable
        items={[
          {
            key: "none",
            label: "No project",
            marker: <span className="size-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground" />,
            checked: filters.projectIds.includes("none"),
            onToggle: () => onChange({ ...filters, projectIds: toggle(filters.projectIds, "none") }),
          },
          ...(options?.projects ?? [])
            // Active projects first; closed ones are still filterable.
            .slice()
            .sort((a, b) => Number(isClosed(a.statusType)) - Number(isClosed(b.statusType)))
            .map((project) => ({
              key: project.id,
              label: project.name,
              hint: isClosed(project.statusType) ? "closed" : null,
              marker: <span className="size-2.5 shrink-0 rounded-sm" style={{ background: project.color }} />,
              checked: filters.projectIds.includes(project.id),
              onToggle: () => onChange({ ...filters, projectIds: toggle(filters.projectIds, project.id) }),
            })),
        ]}
      />
      {count > 0 ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="ml-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function isClosed(statusType: string | null): boolean {
  return statusType === "completed" || statusType === "canceled";
}

function summarize(names: string[]): string | null {
  if (names.length === 0) return null;
  return names.length <= 2 ? names.join(", ") : `${names[0]} +${names.length - 1}`;
}

type Item = {
  key: string;
  label: string;
  hint?: string | null;
  marker: ReactNode;
  checked: boolean;
  onToggle: () => void;
};

function FilterMenu({
  label,
  icon,
  summary,
  items,
  searchable = false,
}: {
  label: string;
  icon: string;
  summary: string | null;
  items: Item[];
  searchable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? items.filter((item) => item.label.toLowerCase().includes(needle) || item.hint?.toLowerCase().includes(needle))
    : items;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
            summary
              ? "border-[#5E6AD2]/50 bg-[#5E6AD2]/10 text-foreground"
              : "border-dashed border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={icon} className="size-3.5 shrink-0" />
          <span className="shrink-0">{label}</span>
          {summary ? <span className="min-w-0 truncate font-medium">: {summary}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} mobileTitle={label} className="w-64 p-1">
        {searchable ? (
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`Filter ${label.toLowerCase()}`}
            aria-label={`Filter ${label.toLowerCase()}`}
            className="mb-1 h-8"
          />
        ) : null}
        <div className="max-h-72 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">Nothing matches.</p>
          ) : (
            visible.map((item) => (
              <label
                key={item.key}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox checked={item.checked} onCheckedChange={item.onToggle} />
                {item.marker}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint ? <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span> : null}
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
