// Linear projects: list, detail (description, updates, milestones, issues)
// and the options behind the issue list's filters.
import { z } from "zod";

export const projectHealthSchema = z.enum(["onTrack", "atRisk", "offTrack"]).nullable();

const projectStatusSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }).nullable();

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  url: z.string(),
  status: projectStatusSchema,
  health: projectHealthSchema,
  progress: z.number(),
  priority: z.number(),
  priorityLabel: z.string(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  updatedAt: z.string(),
  lead: z.object({ id: z.string(), name: z.string() }).nullable(),
  teams: z.array(z.string()),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectUpdateSchema = z.object({
  id: z.string(),
  body: z.string(),
  health: projectHealthSchema,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  url: z.string(),
  author: z.string(),
  authorId: z.string().nullable(),
});

export const projectDetailSchema = projectSummarySchema.extend({
  content: z.string().nullable(),
  members: z.array(z.string()),
  milestones: z.array(
    z.object({ id: z.string(), name: z.string(), targetDate: z.string().nullable(), progress: z.number() }),
  ),
  updates: z.array(projectUpdateSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const filterOptionsSchema = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string(), group: z.string().nullable() })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), color: z.string(), statusType: z.string().nullable() })),
});
export type FilterOptions = z.infer<typeof filterOptionsSchema>;

export const PROJECT_SUMMARY_FIELDS = `
  id name description icon color url health progress priority priorityLabel startDate targetDate updatedAt
  status { id name type color }
  lead { id name }
  teams(first: 10) { nodes { key } }
`;

export const PROJECTS_QUERY = `query Projects($filter: ProjectFilter) {
  projects(first: 150, filter: $filter, orderBy: updatedAt) { nodes { ${PROJECT_SUMMARY_FIELDS} } }
}`;

export const PROJECT_QUERY = `query Project($id: String!) {
  project(id: $id) {
    ${PROJECT_SUMMARY_FIELDS}
    content
    members(first: 50) { nodes { name } }
    projectMilestones(first: 50) { nodes { id name targetDate progress sortOrder } }
    projectUpdates(first: 30) { nodes { id body health createdAt editedAt url user { id name } } }
  }
}`;

export const FILTER_OPTIONS_QUERY = `query FilterOptions {
  issueLabels(first: 250) { nodes { id name color isGroup retiredAt parent { name } } }
  projects(first: 250, orderBy: updatedAt) { nodes { id name color status { type } } }
}`;

type RawProject = Omit<ProjectSummary, "teams"> & { teams: { nodes: { key: string }[] } };
type RawProjectDetail = RawProject & {
  content: string | null;
  members: { nodes: { name: string }[] };
  projectMilestones: { nodes: { id: string; name: string; targetDate: string | null; progress: number; sortOrder: number }[] };
  projectUpdates: {
    nodes: { id: string; body: string; health: ProjectDetail["health"]; createdAt: string; editedAt: string | null; url: string; user: { id: string; name: string } | null }[];
  };
};

function clampFraction(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function flattenProject(raw: RawProject): ProjectSummary {
  return { ...raw, progress: clampFraction(raw.progress), teams: raw.teams.nodes.map((team) => team.key) };
}

export function flattenProjectDetail(raw: RawProjectDetail): ProjectDetail {
  return {
    ...flattenProject(raw),
    content: raw.content,
    members: raw.members.nodes.map((member) => member.name),
    milestones: raw.projectMilestones.nodes
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      // Linear reports milestone progress in percent but project progress as
      // a 0–1 fraction; normalize to the fraction.
      .map(({ id, name, targetDate, progress }) => ({ id, name, targetDate, progress: clampFraction(progress / 100) })),
    updates: raw.projectUpdates.nodes
      .map((update) => ({
        id: update.id,
        body: update.body,
        health: update.health,
        createdAt: update.createdAt,
        editedAt: update.editedAt,
        url: update.url,
        author: update.user?.name ?? "Unknown",
        authorId: update.user?.id ?? null,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

type RawOptions = {
  issueLabels: { nodes: { id: string; name: string; color: string; isGroup: boolean; retiredAt: string | null; parent: { name: string } | null }[] };
  projects: { nodes: { id: string; name: string; color: string; status: { type: string } | null }[] };
};

export function flattenFilterOptions(raw: RawOptions): FilterOptions {
  return {
    labels: raw.issueLabels.nodes
      .filter((label) => !label.isGroup && label.retiredAt === null)
      .map((label) => ({ id: label.id, name: label.name, color: label.color, group: label.parent?.name ?? null }))
      .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name)),
    projects: raw.projects.nodes.map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      statusType: project.status?.type ?? null,
    })),
  };
}

/** Issue-list filters, combined with AND across kinds and OR within one kind. */
export const issueFiltersSchema = z
  .object({
    labelIds: z.array(z.string().min(1).max(100)).max(50).default([]),
    priorities: z.array(z.number().int().min(0).max(4)).max(5).default([]),
    // "none" selects issues without a project.
    projectIds: z.array(z.string().min(1).max(100)).max(50).default([]),
  })
  .strict();
export type IssueFilters = z.infer<typeof issueFiltersSchema>;

export function issueFilterClauses(filters: IssueFilters): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];
  if (filters.labelIds.length) clauses.push({ labels: { some: { id: { in: filters.labelIds } } } });
  if (filters.priorities.length) clauses.push({ priority: { in: filters.priorities } });
  if (filters.projectIds.length) {
    const ids = filters.projectIds.filter((id) => id !== "none");
    const or: Record<string, unknown>[] = [];
    if (ids.length) or.push({ project: { id: { in: ids } } });
    if (filters.projectIds.includes("none")) or.push({ project: { null: true } });
    clauses.push(or.length === 1 ? or[0]! : { or });
  }
  return clauses;
}
