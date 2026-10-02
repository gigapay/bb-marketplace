// Everything the plugin writes to Linear on request: issues, comments,
// projects and project updates. Shared by the UI's RPCs and the agent CLI,
// which pass names ("In Progress", "me", "Bug"); this module resolves them.
import { z } from "zod";

type Linear = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

// ------------------------------------------------------------------ options

// Split in four: as one query (teams × members, labels, projects × teams)
// Linear rejected it as "Query too complex". Each part stays well under the
// limit, and they run in parallel.
const OPTIONS_TEAMS_QUERY = `query WriteOptionsTeams {
  viewer { id name }
  teams(first: 50) { nodes { id key name states(first: 50) { nodes { id name type color position } } } }
}`;
const OPTIONS_USERS_QUERY = `query WriteOptionsUsers {
  users(first: 250, filter: { active: { eq: true } }) { nodes { id name displayName email } }
}`;
const OPTIONS_LABELS_QUERY = `query WriteOptionsLabels {
  projectStatuses(first: 50) { nodes { id name type color position } }
  issueLabels(first: 250) { nodes { id name color isGroup retiredAt parent { name } team { id } } }
}`;
const OPTIONS_PROJECTS_QUERY = `query WriteOptionsProjects {
  projects(first: 250, orderBy: updatedAt) { nodes { id name color status { type } teams(first: 5) { nodes { id } } } }
}`;
export const WRITE_OPTIONS_QUERIES = [OPTIONS_TEAMS_QUERY, OPTIONS_USERS_QUERY, OPTIONS_LABELS_QUERY, OPTIONS_PROJECTS_QUERY];

export const writeOptionsSchema = z.object({
  viewer: z.object({ id: z.string(), name: z.string() }),
  teams: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      states: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string(), position: z.number() })),
      members: z.array(z.object({ id: z.string(), name: z.string(), displayName: z.string(), email: z.string() })),
    }),
  ),
  projectStatuses: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string(), position: z.number() })),
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string(), group: z.string().nullable(), teamId: z.string().nullable() })),
  projects: z.array(z.object({ id: z.string(), name: z.string(), color: z.string(), closed: z.boolean(), teamIds: z.array(z.string()) })),
});
export type WriteOptions = z.infer<typeof writeOptionsSchema>;

type Member = WriteOptions["teams"][number]["members"][number];
type RawTeams = {
  viewer: { id: string; name: string };
  teams: { nodes: { id: string; key: string; name: string; states: { nodes: WriteOptions["teams"][number]["states"] } }[] };
};
type RawLabels = {
  projectStatuses: { nodes: WriteOptions["projectStatuses"] };
  issueLabels: { nodes: { id: string; name: string; color: string; isGroup: boolean; retiredAt: string | null; parent: { name: string } | null; team: { id: string } | null }[] };
};
type RawProjects = {
  projects: { nodes: { id: string; name: string; color: string; status: { type: string } | null; teams: { nodes: { id: string }[] } }[] };
};

export async function loadWriteOptions(linear: Linear): Promise<WriteOptions> {
  const [teams, users, labels, projects] = await Promise.all([
    linear<RawTeams>(OPTIONS_TEAMS_QUERY),
    linear<{ users: { nodes: Member[] } }>(OPTIONS_USERS_QUERY),
    linear<RawLabels>(OPTIONS_LABELS_QUERY),
    linear<RawProjects>(OPTIONS_PROJECTS_QUERY),
  ]);
  // Assignees come from the workspace's active users; per-team membership
  // was what made the single query too complex.
  const members = users.users.nodes;
  return {
    viewer: teams.viewer,
    teams: teams.teams.nodes.map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      states: team.states.nodes.slice().sort((a, b) => a.position - b.position),
      members,
    })),
    projectStatuses: labels.projectStatuses.nodes.slice().sort((a, b) => a.position - b.position),
    labels: labels.issueLabels.nodes
      .filter((label) => !label.isGroup && label.retiredAt === null)
      .map((label) => ({ id: label.id, name: label.name, color: label.color, group: label.parent?.name ?? null, teamId: label.team?.id ?? null })),
    projects: projects.projects.nodes.map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      closed: ["completed", "canceled"].includes(project.status?.type ?? ""),
      teamIds: project.teams.nodes.map((team) => team.id),
    })),
  };
}

export const PROJECT_MILESTONES_QUERY = `query ProjectMilestones($id: String!) {
  project(id: $id) { projectMilestones(first: 100) { nodes { id name sortOrder } } }
}`;

// ---------------------------------------------------------------- mutations

const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`;
const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }`;
const ISSUE_ARCHIVE = `mutation IssueArchive($id: String!) { issueArchive(id: $id) { success } }`;
const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`;
const COMMENT_UPDATE = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`;
const COMMENT_DELETE = `mutation CommentDelete($id: String!) { commentDelete(id: $id) { success } }`;
const PROJECT_CREATE = `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name url } } }`;
const PROJECT_UPDATE = `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name url } } }`;
const PROJECT_DELETE = `mutation ProjectDelete($id: String!) { projectDelete(id: $id) { success } }`;
const UPDATE_CREATE = `mutation ProjectUpdateCreate($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { id url } } }`;
const UPDATE_EDIT = `mutation ProjectUpdateEdit($id: String!, $input: ProjectUpdateUpdateInput!) { projectUpdateUpdate(id: $id, input: $input) { success projectUpdate { id url } } }`;
const UPDATE_ARCHIVE = `mutation ProjectUpdateArchive($id: String!) { projectUpdateArchive(id: $id) { success } }`;

export const ALL_WRITE_DOCUMENTS = [
  ...WRITE_OPTIONS_QUERIES, PROJECT_MILESTONES_QUERY, ISSUE_CREATE, ISSUE_UPDATE, ISSUE_ARCHIVE, COMMENT_CREATE, COMMENT_UPDATE,
  COMMENT_DELETE, PROJECT_CREATE, PROJECT_UPDATE, PROJECT_DELETE, UPDATE_CREATE, UPDATE_EDIT, UPDATE_ARCHIVE,
];

// Id-based inputs: what the UI sends, and what the CLI resolves names into.
const id = z.string().min(1).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const issueCreateSchema = z
  .object({
    teamId: id,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    stateId: id.optional(),
    assigneeId: id.optional(),
    labelIds: z.array(id).max(30).optional(),
    projectId: id.optional(),
    projectMilestoneId: id.optional(),
    parentId: id.optional(),
  })
  .strict();

export const issueUpdateSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    stateId: id.optional(),
    assigneeId: id.nullable().optional(),
    addedLabelIds: z.array(id).max(30).optional(),
    removedLabelIds: z.array(id).max(30).optional(),
    labelIds: z.array(id).max(30).optional(),
    projectId: id.nullable().optional(),
    projectMilestoneId: id.nullable().optional(),
  })
  .strict();

export const projectFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(255).optional(),
    content: z.string().max(200_000).optional(),
    statusId: id.optional(),
    leadId: id.nullable().optional(),
    startDate: date.nullable().optional(),
    targetDate: date.nullable().optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict();
export const projectCreateSchema = projectFieldsSchema.extend({ name: z.string().trim().min(1).max(200), teamIds: z.array(id).min(1).max(10) });

type Result = { id: string; url: string | null; label: string };

async function ok<T extends { success: boolean }>(promise: Promise<Record<string, T>>, what: string): Promise<T> {
  const data = await promise;
  const payload = Object.values(data)[0]!;
  if (!payload.success) throw new Error(`Linear didn't accept the ${what}`);
  return payload;
}

export function createWriter(linear: Linear) {
  return {
    async createIssue(input: z.infer<typeof issueCreateSchema>): Promise<Result> {
      const { issue } = await ok(linear<Record<string, { success: boolean; issue: { id: string; identifier: string; url: string } }>>(ISSUE_CREATE, { input }), "new issue");
      return { id: issue.identifier, url: issue.url, label: issue.identifier };
    },
    async updateIssue({ id: issueId, ...input }: z.infer<typeof issueUpdateSchema>): Promise<Result> {
      const { issue } = await ok(linear<Record<string, { success: boolean; issue: { id: string; identifier: string; url: string } }>>(ISSUE_UPDATE, { id: issueId, input }), "issue update");
      return { id: issue.identifier, url: issue.url, label: issue.identifier };
    },
    async archiveIssue(issueId: string): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(ISSUE_ARCHIVE, { id: issueId }), "archive");
    },
    async createComment(issueId: string, body: string, parentId: string | null): Promise<Result> {
      const { comment } = await ok(
        linear<Record<string, { success: boolean; comment: { id: string; url: string } }>>(COMMENT_CREATE, { input: { issueId, body, ...(parentId ? { parentId } : {}) } }),
        "comment",
      );
      return { id: comment.id, url: comment.url, label: "comment" };
    },
    async updateComment(commentId: string, body: string): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(COMMENT_UPDATE, { id: commentId, input: { body } }), "comment edit");
    },
    async deleteComment(commentId: string): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(COMMENT_DELETE, { id: commentId }), "comment deletion");
    },
    async createProject(input: z.infer<typeof projectCreateSchema>): Promise<Result> {
      const { project } = await ok(linear<Record<string, { success: boolean; project: { id: string; name: string; url: string } }>>(PROJECT_CREATE, { input }), "new project");
      return { id: project.id, url: project.url, label: project.name };
    },
    async updateProject(projectId: string, input: z.infer<typeof projectFieldsSchema>): Promise<Result> {
      const { project } = await ok(linear<Record<string, { success: boolean; project: { id: string; name: string; url: string } }>>(PROJECT_UPDATE, { id: projectId, input }), "project update");
      return { id: project.id, url: project.url, label: project.name };
    },
    async deleteProject(projectId: string): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(PROJECT_DELETE, { id: projectId }), "project deletion");
    },
    async postUpdate(projectId: string, body: string, health: string): Promise<Result> {
      const { projectUpdate } = await ok(
        linear<Record<string, { success: boolean; projectUpdate: { id: string; url: string } }>>(UPDATE_CREATE, { input: { projectId, body, health } }),
        "project update",
      );
      return { id: projectUpdate.id, url: projectUpdate.url, label: "project update" };
    },
    async editUpdate(updateId: string, input: { body?: string; health?: string }): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(UPDATE_EDIT, { id: updateId, input }), "project update edit");
    },
    async archiveUpdate(updateId: string): Promise<void> {
      await ok(linear<Record<string, { success: boolean }>>(UPDATE_ARCHIVE, { id: updateId }), "project update archive");
    },
  };
}

// ----------------------------------------------------------------- resolvers
// For the CLI: turn human names into ids, with errors that list the choices.

const norm = (value: string) => value.trim().toLowerCase();

function pick<T>(items: readonly T[], value: string, keys: ((item: T) => string | null)[], what: string, show: (item: T) => string): T {
  const wanted = norm(value);
  for (const key of keys) {
    const exact = items.filter((item) => (key(item) ?? "").toLowerCase() === wanted);
    if (exact.length === 1) return exact[0]!;
  }
  const partial = items.filter((item) => keys.some((key) => (key(item) ?? "").toLowerCase().includes(wanted)));
  if (partial.length === 1) return partial[0]!;
  const choices = (partial.length > 1 ? partial : items).slice(0, 15).map(show).join(", ");
  throw new Error(`${partial.length > 1 ? "Ambiguous" : "Unknown"} ${what} "${value}". Choose one of: ${choices}`);
}

const PRIORITY_WORDS: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4, "0": 0, "1": 1, "2": 2, "3": 3, "4": 4 };
// Friendly words for workflow states when the exact name differs.
const STATE_TYPE_WORDS: Record<string, string> = { backlog: "backlog", todo: "unstarted", "to do": "unstarted", started: "started", "in progress": "started", done: "completed", completed: "completed", canceled: "canceled", cancelled: "canceled", triage: "triage" };

export function resolver(options: WriteOptions) {
  return {
    team(value: string | undefined) {
      if (value === undefined) {
        if (options.teams.length === 1) return options.teams[0]!;
        throw new Error(`Pass --team. Teams: ${options.teams.map((team) => team.key).join(", ")}`);
      }
      return pick(options.teams, value, [(t) => t.key, (t) => t.name], "team", (t) => t.key);
    },
    priority(value: string): number {
      const priority = PRIORITY_WORDS[norm(value)];
      if (priority === undefined) throw new Error(`Unknown priority "${value}". Use urgent, high, medium, low or none.`);
      return priority;
    },
    state(team: WriteOptions["teams"][number], value: string) {
      const byName = team.states.find((state) => norm(state.name) === norm(value));
      if (byName) return byName;
      const type = STATE_TYPE_WORDS[norm(value)];
      const byType = type ? team.states.find((state) => state.type === type) : undefined;
      if (byType) return byType;
      return pick(team.states, value, [(s) => s.name], "state", (s) => s.name);
    },
    user(team: WriteOptions["teams"][number] | null, value: string): string | null {
      if (norm(value) === "me") return options.viewer.id;
      if (norm(value) === "none") return null;
      const members = team?.members ?? options.teams[0]?.members ?? [];
      return pick(members, value, [(m) => m.email, (m) => m.displayName, (m) => m.name], "user", (m) => m.displayName).id;
    },
    labels(team: WriteOptions["teams"][number] | null, values: string[]): string[] {
      const usable = options.labels.filter((label) => label.teamId === null || label.teamId === team?.id);
      return values.map((value) => pick(usable, value, [(l) => l.name], "label", (l) => l.name).id);
    },
    project(value: string): string | null {
      if (norm(value) === "none") return null;
      return pick(options.projects.filter((p) => !p.closed || norm(p.name) === norm(value)), value, [(p) => p.id, (p) => p.name], "project", (p) => p.name).id;
    },
    projectStatus(value: string) {
      const byName = options.projectStatuses.find((status) => norm(status.name) === norm(value));
      return byName ?? pick(options.projectStatuses, value, [(s) => s.type, (s) => s.name], "project status", (s) => s.name);
    },
  };
}
