// bb-plugin-linear: browse your Linear issues and start BB threads from them.
//
// The Linear API key is a secret setting, so every Linear call goes through
// this backend. app.tsx talks to it over the RPC contract below.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./contract.js";
import {
  FILTER_OPTIONS_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  filterOptionsSchema,
  flattenFilterOptions,
  flattenProject,
  flattenProjectDetail,
  issueFilterClauses,
  issueFiltersSchema,
  projectDetailSchema,
  projectSummarySchema,
  type IssueFilters,
} from "./projects.js";
import {
  PROJECT_MILESTONES_QUERY,
  createWriter,
  issueCreateSchema,
  issueUpdateSchema,
  loadWriteOptions,
  projectCreateSchema,
  projectFieldsSchema,
  writeOptionsSchema,
} from "./writes.js";
import {
  PROJECT_UPDATE_CONTEXT_QUERY,
  PROJECT_UPDATE_CREATE_MUTATION,
  buildUpdateContext,
  buildUpdatePrompt,
  parseDraft,
  type RawUpdateContext,
} from "./updates/draft.js";
import { registerLinearWorktree } from "./worktree/provider.js";
import { registerCli } from "./cli.js";
import { triageIssue, type TriageContext, type TriageProposal } from "./triage/engine.js";
import { applyIssueUpdate, loadTriageContext, loadTriageIssues, openRouterJev } from "./triage/linear.js";
import {
  PROJECT_STATUSES_QUERY,
  PROJECT_STATUS_MUTATION,
  PROJECT_TRIAGE_QUERY,
  isTriageable,
  toTriageInput,
  triageProject,
} from "./triage/projects.js";
import { IDENTIFIER_PATTERN, LINKS_CHANGED, linkedIssueFromPrompt, resolveLink, resolveThreadLinks } from "./shared/links";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_UPLOADS_HOST = "uploads.linear.app";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const stateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string(),
  position: z.number(),
});

const labelSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});

const issueSummarySchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priority: z.number(),
  priorityLabel: z.string(),
  updatedAt: z.string(),
  state: stateSchema,
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  assignee: userSchema.nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  milestone: z.object({ id: z.string(), name: z.string() }).nullable(),
  labels: z.array(labelSchema),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  url: z.string(),
  parentId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  quotedText: z.string().nullable(),
  // Integrations (GitHub, Slack, …) post as bots or external users.
  author: z.object({ name: z.string(), kind: z.enum(["user", "bot", "external"]) }),
  user: userSchema.nullable(),
});
export type IssueComment = z.infer<typeof commentSchema>;

const issueDetailSchema = issueSummarySchema.extend({
  description: z.string().nullable(),
  branchName: z.string(),
  createdAt: z.string(),
  estimate: z.number().nullable(),
  dueDate: z.string().nullable(),
  cycle: z.object({ id: z.string(), name: z.string().nullable(), number: z.number() }).nullable(),
  parent: z.object({ id: z.string(), identifier: z.string(), title: z.string() }).nullable(),
  children: z.array(
    z.object({ id: z.string(), identifier: z.string(), title: z.string(), state: stateSchema }),
  ),
  comments: z.array(commentSchema),
});
export type IssueDetail = z.infer<typeof issueDetailSchema>;

const scopeSchema = z.enum(["assigned", "created", "subscribed", "all"]);
export type IssueScope = z.infer<typeof scopeSchema>;

const identifierSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(IDENTIFIER_PATTERN, "Expected an issue identifier like ENG-42"));
const threadIdSchema = z.string().min(1).max(100);

const storedLinkSchema = z.object({
  threadId: z.string(),
  identifier: z.string().nullable(),
  source: z.enum(["spawn", "manual"]),
});
export type StoredLink = z.infer<typeof storedLinkSchema>;

const triageChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("priority"), value: z.number(), label: z.string(), currentLabel: z.string(), confidence: z.number(), preselected: z.boolean() }),
  z.object({ kind: z.literal("label"), labelId: z.string(), label: z.string(), color: z.string().nullable(), group: z.enum(["type", "area"]), confidence: z.number(), preselected: z.boolean() }),
  z.object({ kind: z.literal("project"), projectId: z.string(), label: z.string(), confidence: z.number(), preselected: z.boolean() }),
  z.object({ kind: z.literal("cancel"), stateId: z.string(), daysInactive: z.number(), reason: z.string(), comment: z.string(), confidence: z.number(), preselected: z.literal(false) }),
  z.object({ kind: z.literal("comment"), body: z.string(), gaps: z.array(z.string()), confidence: z.number(), preselected: z.literal(false) }),
]);
const triageProposalSchema = z.object({
  issueId: z.string(),
  identifier: z.string(),
  title: z.string(),
  changes: z.array(triageChangeSchema),
  readiness: z.number().nullable(),
  needsInfo: z.boolean(),
  error: z.string().nullable(),
});
export type TriageProposalDto = z.infer<typeof triageProposalSchema>;
export type TriageChangeDto = z.infer<typeof triageChangeSchema>;

const projectFlagSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update-due"), daysSinceUpdate: z.number().nullable(), everyWeeks: z.number() }),
  z.object({ kind: z.literal("overdue"), daysOverdue: z.number() }),
  z.object({ kind: z.literal("behind"), progress: z.number(), elapsed: z.number() }),
  z.object({ kind: z.literal("no-lead") }),
  z.object({ kind: z.literal("no-target") }),
  z.object({ kind: z.literal("health"), stated: z.string().nullable(), suggested: z.string(), confidence: z.number() }),
  z.object({ kind: z.literal("thin-description"), confidence: z.number() }),
]);
const projectTriageProposalSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  flags: z.array(projectFlagSchema),
  changes: z.array(
    z.object({
      kind: z.literal("status"),
      statusType: z.enum(["completed", "paused", "canceled"]),
      statusId: z.string(),
      statusName: z.string(),
      reason: z.string(),
      confidence: z.number(),
      preselected: z.literal(false),
    }),
  ),
  error: z.string().nullable(),
});
export type ProjectTriageProposalDto = z.infer<typeof projectTriageProposalSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      viewer: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
      error: z.string().nullable(),
    }),
  },
  issues_list: {
    input: z
      .object({
        scope: scopeSchema,
        includeCompleted: z.boolean(),
        query: z.string().trim().max(200),
        filters: issueFiltersSchema.optional(),
      })
      .strict(),
    output: z.object({ issues: z.array(issueSummarySchema) }),
  },
  // ---- writes (issues, comments, projects, updates) and their pickers
  write_options: { input: z.null(), output: writeOptionsSchema },
  project_milestones: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: z.object({ milestones: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  issue_create: { input: issueCreateSchema, output: z.object({ identifier: z.string(), url: z.string().nullable() }) },
  issue_update: { input: issueUpdateSchema, output: z.object({ identifier: z.string() }) },
  issue_archive: { input: z.object({ id: z.string().min(1).max(100) }).strict(), output: z.object({ ok: z.literal(true) }) },
  comment_update: {
    input: z.object({ id: z.string().min(1).max(100), body: z.string().trim().min(1).max(50_000) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  comment_delete: { input: z.object({ id: z.string().min(1).max(100) }).strict(), output: z.object({ ok: z.literal(true) }) },
  project_create: { input: projectCreateSchema, output: z.object({ id: z.string(), url: z.string().nullable() }) },
  project_edit: {
    input: z.object({ id: z.string().min(1).max(100), fields: projectFieldsSchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  project_delete: { input: z.object({ id: z.string().min(1).max(100) }).strict(), output: z.object({ ok: z.literal(true) }) },
  update_edit: {
    input: z
      .object({
        id: z.string().min(1).max(100),
        body: z.string().trim().min(1).max(50_000).optional(),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  update_archive: { input: z.object({ id: z.string().min(1).max(100) }).strict(), output: z.object({ ok: z.literal(true) }) },
  filter_options: {
    input: z.null(),
    output: filterOptionsSchema,
  },
  projects_list: {
    input: z.object({ mine: z.boolean(), includeClosed: z.boolean() }).strict(),
    output: z.object({ projects: z.array(projectSummarySchema) }),
  },
  project_get: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: projectDetailSchema,
  },
  // Spawns a hidden agent thread that drafts the update; returns at once.
  update_draft_start: {
    input: z.object({ projectId: z.string().min(1).max(100), notes: z.string().max(2000) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  update_draft_get: {
    input: z.object({ threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({
      status: z.enum(["running", "ready", "failed"]),
      draft: z.object({ health: z.enum(["onTrack", "atRisk", "offTrack"]).nullable(), body: z.string() }).nullable(),
      error: z.string().nullable(),
    }),
  },
  // Posts to Linear; only called when the user presses Post.
  project_update_create: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        body: z.string().trim().min(1).max(50_000),
        health: z.enum(["onTrack", "atRisk", "offTrack"]),
        draftThreadId: z.string().min(1).max(100).nullable(),
      })
      .strict(),
    output: z.object({ url: z.string().nullable() }),
  },
  issue_get: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: issueDetailSchema,
  },
  // Writes to Linear as the API key's owner; only ever called on an explicit send.
  comment_create: {
    input: z
      .object({
        issueId: z.string().min(1).max(100),
        body: z.string().trim().min(1).max(50_000),
        parentId: z.string().min(1).max(100).nullable(),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  // Read-only: measures each project, asks Jev, and proposes; writes nothing.
  project_triage_run: {
    input: z.object({ projectIds: z.array(z.string().min(1).max(100)).min(1).max(40) }).strict(),
    output: z.object({ proposals: z.array(projectTriageProposalSchema) }),
  },
  project_triage_apply: {
    input: z
      .object({ updates: z.array(z.object({ projectId: z.string().min(1).max(100), statusId: z.string().min(1).max(100) }).strict()).min(1).max(40) })
      .strict(),
    output: z.object({ results: z.array(z.object({ projectId: z.string(), error: z.string().nullable() })) }),
  },
  triage_status: {
    input: z.null(),
    output: z.object({ configured: z.boolean() }),
  },
  // Asks Jev about each issue; read-only, nothing is written to Linear.
  triage_run: {
    input: z
      .object({
        issueIds: z.array(z.string().min(1).max(100)).min(1).max(50),
        // Issues with a BB thread (the UI knows branch links too); never stale.
        linkedIssueIds: z.array(z.string().min(1).max(100)).max(500),
      })
      .strict(),
    output: z.object({ proposals: z.array(triageProposalSchema) }),
  },
  // Applies only the changes the user kept in the review.
  triage_apply: {
    input: z
      .object({
        updates: z
          .array(
            z
              .object({
                issueId: z.string().min(1).max(100),
                priority: z.number().int().min(0).max(4).optional(),
                addedLabelIds: z.array(z.string().min(1).max(100)).max(20).optional(),
                projectId: z.string().min(1).max(100).optional(),
                stateId: z.string().min(1).max(100).optional(),
                // Posted after the update: the missing-info ask or the cancel note.
                comments: z.array(z.string().trim().min(1).max(10_000)).max(2).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    output: z.object({ results: z.array(z.object({ issueId: z.string(), error: z.string().nullable() })) }),
  },
  issues_by_identifiers: {
    input: z.object({ identifiers: z.array(identifierSchema).max(100) }).strict(),
    output: z.object({ issues: z.array(issueSummarySchema) }),
  },
  links_list: {
    input: z.null(),
    output: z.object({ links: z.array(storedLinkSchema), teamKeys: z.array(z.string()) }),
  },
  // identifier null records an explicit unlink, which also hides a branch match.
  link_set: {
    input: z.object({ threadId: threadIdSchema, identifier: identifierSchema.nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Clears the stored row so the branch match (if any) applies again.
  link_reset: {
    input: z.object({ threadId: threadIdSchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  spawn_recorded: {
    input: z
      .object({
        threadId: threadIdSchema,
        identifier: identifierSchema,
        teamKey: z.string().min(1).max(20),
        projectId: z.string().min(1).max(100),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Existing worktrees the Linear worktree picker offers for adoption.
  worktrees_existing: {
    input: z.object({ projectId: z.string().min(1).max(100), hostId: z.string().min(1).max(100) }).strict(),
    output: z.object({
      worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable() })),
    }),
  },
  // Machine holding the project's default checkout, to preselect a Linear worktree there.
  project_default_host: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: z.object({ hostId: z.string().nullable() }),
  },
  team_project_get: {
    input: z.object({ teamKey: z.string().min(1).max(20) }).strict(),
    output: z.object({ projectId: z.string().nullable() }),
  },
});

const USER_FIELDS = `id name displayName avatarUrl`;
const STATE_FIELDS = `id name type color position`;
const ISSUE_SUMMARY_FIELDS = `
  id identifier title url priority priorityLabel updatedAt
  state { ${STATE_FIELDS} }
  team { id key name }
  assignee { ${USER_FIELDS} }
  project { id name }
  milestone: projectMilestone { id name }
  labels(first: 20) { nodes { id name color } }
`;

const VIEWER_QUERY = `query Viewer { viewer { id name email } }`;

// "subscribed" and "all" have no viewer connection, so they go through the
// root `issues` query (subscribed adds a subscriber filter).
function issuesQuery(scope: IssueScope): string {
  if (scope === "subscribed" || scope === "all") {
    return `query Issues($filter: IssueFilter) {
      issues(first: 100, filter: $filter, orderBy: updatedAt) {
        nodes { ${ISSUE_SUMMARY_FIELDS} }
      }
    }`;
  }
  const connection = scope === "assigned" ? "assignedIssues" : "createdIssues";
  return `query Issues($filter: IssueFilter) {
    viewer { issues: ${connection}(first: 100, filter: $filter, orderBy: updatedAt) {
      nodes { ${ISSUE_SUMMARY_FIELDS} }
    } }
  }`;
}

const COMMENT_CREATE_MUTATION = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

const TEAMS_QUERY = `query Teams { teams(first: 250) { nodes { key } } }`;

const ISSUE_DETAIL_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    ${ISSUE_SUMMARY_FIELDS}
    description branchName createdAt estimate dueDate
    cycle { id name number }
    parent { id identifier title }
    children(first: 50) { nodes { id identifier title state { ${STATE_FIELDS} } } }
    comments(first: 100, orderBy: createdAt) {
      nodes {
        id body createdAt editedAt url quotedText resolvedAt
        parent { id }
        resolvingUser { name }
        user { ${USER_FIELDS} }
        botActor { name }
        externalUser { name }
      }
    }
  }
}`;

type Connection<T> = { nodes: T[] };
type RawComment = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  url: string;
  quotedText: string | null;
  resolvedAt: string | null;
  parent: { id: string } | null;
  resolvingUser: { name: string } | null;
  user: IssueComment["user"];
  botActor: { name: string | null } | null;
  externalUser: { name: string } | null;
};

function flattenComment(raw: RawComment): IssueComment {
  const author = raw.user
    ? { name: raw.user.name, kind: "user" as const }
    : raw.botActor?.name
      ? { name: raw.botActor.name, kind: "bot" as const }
      : { name: raw.externalUser?.name ?? "Unknown", kind: "external" as const };
  return {
    id: raw.id,
    body: raw.body,
    createdAt: raw.createdAt,
    editedAt: raw.editedAt,
    url: raw.url,
    parentId: raw.parent?.id ?? null,
    resolvedAt: raw.resolvedAt,
    resolvedBy: raw.resolvingUser?.name ?? null,
    quotedText: raw.quotedText,
    author,
    user: raw.user,
  };
}
type RawSummary = Omit<IssueSummary, "labels"> & {
  labels: Connection<IssueSummary["labels"][number]>;
};
type RawDetail = Omit<IssueDetail, "labels" | "children" | "comments"> & {
  labels: Connection<IssueSummary["labels"][number]>;
  children: Connection<IssueDetail["children"][number]>;
  comments: Connection<RawComment>;
};

function flattenSummary(raw: RawSummary): IssueSummary {
  return { ...raw, labels: raw.labels.nodes };
}

function flattenDetail(raw: RawDetail): IssueDetail {
  return {
    ...raw,
    labels: raw.labels.nodes,
    children: raw.children.nodes,
    comments: raw.comments.nodes.map(flattenComment),
  };
}

function openIssuesFilter(includeCompleted: boolean): Record<string, unknown> {
  return includeCompleted ? {} : { state: { type: { nin: ["completed", "canceled"] } } };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Linear API key",
      description:
        "Personal API key from Linear → Settings → Security & access → Personal API keys.",
      secret: true,
    },
    renameWorktreeBranch: {
      type: "boolean",
      label: "Use Linear's branch name for worktrees",
      description:
        "When a thread started from a ticket gets a new worktree, rename BB's generated branch to the ticket's Linear branch.",
      default: true,
    },
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key (Jev triage)",
      description: "Used to ask TypeSafe's Jev model to triage tickets. Issue text is sent to OpenRouter/TypeSafe, and OpenRouter bills the usage.",
      secret: true,
    },
    staleAfterDays: {
      type: "number",
      label: "Stale after (days)",
      description: "Open tickets with no update or comment for this long become candidates for cancellation in Jev triage.",
      default: 90,
      experimental_schema: z.number().int().min(14).max(730),
    },
    triageGuidelines: {
      type: "string",
      label: "Triage guidelines",
      description: "Optional team conventions Jev should follow when triaging, e.g. what counts as urgent for you. Sent with every triage request.",
      experimental_multiline: true,
      default: "",
      experimental_schema: z.string().max(4000, "Keep guidelines under 4000 characters"),
    },
    worktreesRoot: {
      type: "string",
      label: "Worktrees folder",
      description:
        "Where Linear worktrees are created on each machine, e.g. ~/worktrees (gives ~/worktrees/<repo>/<ticket-branch>). Leave empty to use BB's own folder.",
      default: "",
      experimental_schema: z
        .string()
        .max(1024)
        .refine((value) => value.trim() === "" || /^(~\/|~$|\/)/.test(value.trim()), "Use an absolute path or one starting with ~/"),
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  async function readApiKey(): Promise<string | null> {
    const { apiKey } = await settings.get();
    return typeof apiKey === "string" && apiKey.trim() !== "" ? apiKey.trim() : null;
  }

  /**
   * Reads are retried on network errors and on Linear's 429/5xx. Mutations
   * aren't: a dropped response may still have been applied, and a retry
   * would post the same comment or update twice.
   */
  async function sendToLinear(apiKey: string, query: string, variables: Record<string, unknown>): Promise<Response> {
    const retryable = !/^\s*mutation\b/.test(query);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(LINEAR_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: apiKey },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(20_000),
        });
        if (retryable && attempt < 2 && (response.status === 429 || response.status >= 500)) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (cause) {
        if (!retryable || attempt >= 2) {
          throw new Error(`Couldn't reach Linear (${errorMessage(cause)}). Check your connection and try again.`);
        }
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  async function linear<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const apiKey = await readApiKey();
    if (apiKey === null) {
      throw new Error("Linear API key is not configured. Set it in the plugin settings.");
    }
    const response = await sendToLinear(apiKey, query, variables);
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string }[];
    } | null;
    if (body?.errors?.length) {
      throw new Error(`Linear: ${body.errors.map((error) => error.message).join("; ")}`);
    }
    if (!response.ok || body?.data == null) {
      throw new Error(`Linear request failed with HTTP ${response.status}`);
    }
    return body.data;
  }

  const writer = createWriter(linear);

  async function listIssues(
    scope: IssueScope,
    includeCompleted: boolean,
    query: string,
    filters?: IssueFilters,
  ): Promise<IssueSummary[]> {
    const filter = openIssuesFilter(includeCompleted);
    const clauses = filters ? issueFilterClauses(filters) : [];
    if (clauses.length) filter.and = clauses;
    if (query !== "") {
      filter.or = [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } },
      ];
    }
    if (scope === "subscribed" || scope === "all") {
      if (scope === "subscribed") filter.subscribers = { isMe: { eq: true } };
      const data = await linear<{ issues: Connection<RawSummary> }>(issuesQuery(scope), {
        filter,
      });
      return data.issues.nodes.map(flattenSummary);
    }
    const data = await linear<{ viewer: { issues: Connection<RawSummary> } }>(
      issuesQuery(scope),
      { filter },
    );
    return data.viewer.issues.nodes.map(flattenSummary);
  }

  async function getIssue(id: string): Promise<IssueDetail> {
    const data = await linear<{ issue: RawDetail | null }>(ISSUE_DETAIL_QUERY, { id });
    if (data.issue === null) throw new Error(`Issue ${id} not found`);
    return flattenDetail(data.issue);
  }

  async function issuesByIdentifiers(identifiers: string[]): Promise<IssueSummary[]> {
    if (identifiers.length === 0) return [];
    const filter = {
      or: identifiers.map((identifier) => {
        const [key, number] = identifier.split("-");
        return { team: { key: { eq: key } }, number: { eq: Number(number) } };
      }),
    };
    const data = await linear<{ issues: Connection<RawSummary> }>(issuesQuery("all"), { filter });
    return data.issues.nodes.map(flattenSummary);
  }

  // Team keys only change when someone adds a team, so a short cache is fine.
  let teamKeysCache: { keys: string[]; fetchedAt: number } | null = null;
  async function teamKeys(): Promise<string[]> {
    if (teamKeysCache !== null && Date.now() - teamKeysCache.fetchedAt < 10 * 60_000) {
      return teamKeysCache.keys;
    }
    const data = await linear<{ teams: Connection<{ key: string }> }>(TEAMS_QUERY);
    teamKeysCache = { keys: data.teams.nodes.map((team) => team.key.toUpperCase()), fetchedAt: Date.now() };
    return teamKeysCache.keys;
  }
  settings.onChange(() => {
    teamKeysCache = null;
  });

  // Thread → issue links. Branch matches are derived on read and never
  // stored; a row here overrides them (identifier NULL = explicitly unlinked).
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE thread_links (
      thread_id TEXT PRIMARY KEY,
      issue_identifier TEXT,
      source TEXT NOT NULL CHECK (source IN ('spawn', 'manual')),
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE branch_renames (
      thread_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('renamed', 'skipped', 'failed')),
      detail TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE worktree_reservations (
      path_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      source_path TEXT NOT NULL,
      placement TEXT,
      created_at INTEGER NOT NULL
    )`,
    `ALTER TABLE worktree_reservations ADD COLUMN target_path TEXT`,
  ]);
  const selectLinks = db.prepare(
    `SELECT thread_id AS threadId, issue_identifier AS identifier, source FROM thread_links`,
  );
  const selectLink = db.prepare(
    `SELECT thread_id AS threadId, issue_identifier AS identifier, source FROM thread_links WHERE thread_id = ?`,
  );
  const upsertLink = db.prepare(
    `INSERT INTO thread_links (thread_id, issue_identifier, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET issue_identifier = excluded.issue_identifier,
       source = excluded.source, updated_at = excluded.updated_at`,
  );
  const deleteLink = db.prepare(`DELETE FROM thread_links WHERE thread_id = ?`);

  function storeLink(threadId: string, identifier: string | null, source: "spawn" | "manual") {
    upsertLink.run(threadId, identifier, source, Date.now());
    bb.realtime.publish(LINKS_CHANGED, { threadId });
  }
  function clearLink(threadId: string) {
    deleteLink.run(threadId);
    bb.realtime.publish(LINKS_CHANGED, { threadId });
  }

  const selectRename = db.prepare(`SELECT status FROM branch_renames WHERE thread_id = ?`);
  const upsertRename = db.prepare(
    `INSERT INTO branch_renames (thread_id, status, detail, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET status = excluded.status, detail = excluded.detail,
       updated_at = excluded.updated_at`,
  );
  const renamesInFlight = new Set<string>();

  /**
   * BB names a new worktree branch `<prefix><title-slug>-<threadId>` and plugins
   * can't choose it, so for threads started from a ticket we rename that branch
   * to Linear's `branchName` once the worktree exists. BB re-reads the current
   * branch on its next status poll. Runs at most once per thread.
   */
  async function maybeRenameBranch(thread: { id: string; environmentId: string | null }) {
    if (thread.environmentId === null || renamesInFlight.has(thread.id)) return;
    // A failed attempt (Linear down, host offline) retries on the next event.
    const previous = selectRename.get(thread.id) as { status: string } | undefined;
    if (previous !== undefined && previous.status !== "failed") return;
    const link = selectLink.get(thread.id) as StoredLink | undefined;
    if (link?.source !== "spawn" || link.identifier === null) return;
    if (!(await settings.get()).renameWorktreeBranch) return;

    renamesInFlight.add(thread.id);
    const record = (status: "renamed" | "skipped" | "failed", detail: string) => {
      upsertRename.run(thread.id, status, detail, Date.now());
      bb.log.info(`branch rename for ${thread.id}: ${status} (${detail})`);
    };
    try {
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      const from = environment.branchName;
      if (environment.environmentProviderId !== "git-worktree") return record("skipped", "not a git worktree");
      // Still provisioning: try again on the next event.
      if (from === null || environment.path === null) return;
      // Only BB's own generated names end with the thread id; a branch the
      // user picked or reused is theirs to keep.
      if (!from.endsWith(thread.id)) return record("skipped", `branch ${from} was not generated by BB`);
      const issue = await getIssue(link.identifier);
      if (issue.branchName === "" || issue.branchName === from) return record("skipped", "nothing to rename");
      const result = await host.call(
        "renameBranch",
        { path: environment.path, from, to: issue.branchName },
        { hostId: environment.hostId },
      );
      if (result.status === "renamed") {
        record("renamed", `${from} -> ${result.branch}`);
        // Nudge BB to re-read the branch now instead of on its next poll.
        await bb.sdk.environments.status({ environmentId: environment.id }).catch(() => undefined);
      } else {
        record("skipped", result.reason);
      }
    } catch (cause) {
      record("failed", errorMessage(cause));
    } finally {
      renamesInFlight.delete(thread.id);
    }
  }
  // Active covers the first turn starting; idle is the fallback if the
  // environment wasn't ready yet when the turn began.
  bb.events.on("thread.active", ({ thread }) => void maybeRenameBranch(thread));
  bb.events.on("thread.idle", ({ thread }) => void maybeRenameBranch(thread));

  /** The issue a thread points at, the same way the UI resolves it. */
  async function linkForThread(threadId: string) {
    const stored = selectLink.get(threadId) as StoredLink | undefined;
    if (stored !== undefined) return resolveLink(stored, null, new Set());
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    // Siblings in the same worktree, so a new thread inherits its ticket.
    const siblings = await bb.sdk.threads.list({ environmentId: thread.environmentId, limit: 100 });
    const siblingIds = new Set([threadId, ...siblings.map((sibling) => sibling.id)]);
    const rows = new Map(
      (selectLinks.all() as StoredLink[])
        .filter((row) => siblingIds.has(row.threadId))
        .map((row) => [row.threadId, row] as const),
    );
    const links = resolveThreadLinks(
      [...siblingIds].map((id) => ({ id, environmentId: environment.id, branchName: environment.branchName })),
      rows,
      new Set(await teamKeys()),
    );
    return links.get(threadId) ?? null;
  }

  // The ticket a new thread is for, as early as environment creation: the
  // issue page stores the link after spawn and titles the thread
  // "GIG-12: …"; BB's composer seeds a prompt whose first line is the same,
  // which becomes the title fallback.
  async function linearBranchFor(thread: { id: string; title: string | null; titleFallback: string | null }) {
    const stored = selectLink.get(thread.id) as StoredLink | undefined;
    let identifier = stored?.identifier ?? null;
    if (identifier === null && stored === undefined) {
      const match = /^\s*([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})\b/.exec(thread.title ?? thread.titleFallback ?? "");
      if (match && (await teamKeys()).includes(match[1]!.toUpperCase())) {
        identifier = `${match[1]!.toUpperCase()}-${Number(match[2])}`;
      }
    }
    if (identifier === null) return null;
    const issue = await getIssue(identifier);
    return issue.branchName.trim() || null;
  }

  const linearWorktree = registerLinearWorktree(bb, {
    host,
    db,
    worktreesRoot: async () => (await settings.get()).worktreesRoot,
    linearBranchFor,
  });

  // Links a thread when its first message carries the "Linked Linear issue:"
  // line the plugin seeds, so it works from BB's own composer too. It must
  // never block a send: any failure just proceeds without a link.
  bb.experimental_hooks.on("message.dispatch", (context) => {
    try {
      if (context.attempt !== "start-turn" || selectLink.get(context.thread.id) !== undefined) {
        return { action: "proceed" };
      }
      const identifier = linkedIssueFromPrompt(context.input.text);
      if (identifier === null) return { action: "proceed" };
      storeLink(context.thread.id, identifier, "spawn");
      const teamKey = identifier.split("-")[0]!;
      void bb.storage.kv.set(`teamProject:${teamKey}`, context.project.id).catch(() => undefined);
    } catch (cause) {
      bb.log.warn(`linking on dispatch failed: ${errorMessage(cause)}`);
    }
    return { action: "proceed" };
  });

  bb.rpc.register(rpcContract, {
    status: async () => {
      if ((await readApiKey()) === null) return { configured: false, viewer: null, error: null };
      try {
        const data = await linear<{ viewer: { id: string; name: string; email: string } }>(
          VIEWER_QUERY,
        );
        return { configured: true, viewer: data.viewer, error: null };
      } catch (cause) {
        return { configured: true, viewer: null, error: errorMessage(cause) };
      }
    },
    issues_list: async ({ scope, includeCompleted, query, filters }) => ({
      issues: await listIssues(scope, includeCompleted, query, filters),
    }),
    filter_options: async () => flattenFilterOptions(await linear(FILTER_OPTIONS_QUERY)),
    write_options: () => loadWriteOptions(linear),
    project_milestones: async ({ projectId }) => {
      const data = await linear<{ project: { projectMilestones: { nodes: { id: string; name: string; sortOrder: number }[] } } | null }>(
        PROJECT_MILESTONES_QUERY,
        { id: projectId },
      );
      const nodes = data.project?.projectMilestones.nodes ?? [];
      return { milestones: nodes.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(({ id, name }) => ({ id, name })) };
    },
    issue_create: async (input) => {
      const result = await writer.createIssue(input);
      return { identifier: result.id, url: result.url };
    },
    issue_update: async (input) => ({ identifier: (await writer.updateIssue(input)).id }),
    issue_archive: async ({ id }) => (await writer.archiveIssue(id), { ok: true as const }),
    comment_update: async ({ id, body }) => (await writer.updateComment(id, body), { ok: true as const }),
    comment_delete: async ({ id }) => (await writer.deleteComment(id), { ok: true as const }),
    project_create: async (input) => {
      const result = await writer.createProject(input);
      return { id: result.id, url: result.url };
    },
    project_edit: async ({ id, fields }) => (await writer.updateProject(id, fields), { ok: true as const }),
    project_delete: async ({ id }) => (await writer.deleteProject(id), { ok: true as const }),
    update_edit: async ({ id, ...input }) => (await writer.editUpdate(id, input), { ok: true as const }),
    update_archive: async ({ id }) => (await writer.archiveUpdate(id), { ok: true as const }),
    projects_list: async ({ mine, includeClosed }) => {
      const clauses: Record<string, unknown>[] = [];
      if (mine) clauses.push({ or: [{ lead: { isMe: { eq: true } } }, { members: { some: { isMe: { eq: true } } } }] });
      if (!includeClosed) clauses.push({ status: { type: { nin: ["completed", "canceled"] } } });
      const data = await linear<{ projects: { nodes: Parameters<typeof flattenProject>[0][] } }>(PROJECTS_QUERY, {
        filter: clauses.length ? { and: clauses } : null,
      });
      return { projects: data.projects.nodes.map(flattenProject) };
    },
    update_draft_start: async ({ projectId, notes }) => {
      // Each step names itself in the error, so "fetch failed" never reaches
      // the user without saying what was being fetched.
      const step = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (cause) {
          bb.log.error(`update draft: ${label} failed: ${errorMessage(cause)}`);
          throw new Error(`${label} failed: ${errorMessage(cause)}`);
        }
      };
      const data = await step("Reading the project from Linear", () =>
        linear<{ project: RawUpdateContext | null }>(PROJECT_UPDATE_CONTEXT_QUERY, { id: projectId }),
      );
      if (data.project === null) throw new Error("Project not found");
      const project = data.project;
      const context = buildUpdateContext(project);
      // Drafting needs no code checkout, so it runs outside any project.
      const personal = await step("Finding BB's personal project", async () => {
        const projects = await bb.sdk.projects.list({ includePersonal: true });
        const found = projects.find((candidate) => candidate.kind === "personal");
        if (!found) throw new Error("BB has no personal project to run the drafting agent in");
        return found;
      });
      const thread = await step("Starting the drafting agent", () =>
        bb.sdk.threads.spawn({
          projectId: personal.id,
          environment: { type: "project-default" },
          prompt: buildUpdatePrompt(project.name, context, notes),
          title: `Project update draft: ${project.name}`,
          visibility: "hidden",
          pluginMetadata: { kind: "project-update-draft", projectId },
        }),
      );
      return { threadId: thread.id };
    },
    update_draft_get: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "error") {
        return { status: "failed" as const, draft: null, error: "The drafting agent stopped with an error. Open its thread to see why." };
      }
      if (thread.status !== "idle") return { status: "running" as const, draft: null, error: null };
      const { output } = await bb.sdk.threads.output({ threadId });
      // Idle with no reply yet means the first turn hasn't started.
      if (output === null) return { status: "running" as const, draft: null, error: null };
      // The draft is in; release the agent's runtime. The thread stays, so
      // the user can open it, ask for changes, and pull the new version.
      await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      const draft = parseDraft(output);
      return draft
        ? { status: "ready" as const, draft, error: null }
        : { status: "failed" as const, draft: null, error: "The agent didn't return a draft. Open its thread to see what it said." };
    },
    project_update_create: async ({ projectId, body, health, draftThreadId }) => {
      const data = await linear<{ projectUpdateCreate: { success: boolean; projectUpdate: { url: string } | null } }>(
        PROJECT_UPDATE_CREATE_MUTATION,
        { input: { projectId, body, health } },
      );
      if (!data.projectUpdateCreate.success) throw new Error("Linear didn't accept the update");
      if (draftThreadId) {
        await bb.sdk.threads.archive({ threadId: draftThreadId }).catch(() => undefined);
        await bb.sdk.threads.stop({ threadId: draftThreadId }).catch(() => undefined);
      }
      return { url: data.projectUpdateCreate.projectUpdate?.url ?? null };
    },
    project_get: async ({ id }) => {
      const data = await linear<{ project: Parameters<typeof flattenProjectDetail>[0] | null }>(PROJECT_QUERY, { id });
      if (data.project === null) throw new Error("Project not found");
      return flattenProjectDetail(data.project);
    },
    issue_get: ({ id }) => getIssue(id),
    comment_create: async ({ issueId, body, parentId }) => {
      const data = await linear<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
        COMMENT_CREATE_MUTATION,
        { input: { issueId, body, ...(parentId ? { parentId } : {}) } },
      );
      if (!data.commentCreate.success || data.commentCreate.comment === null) {
        throw new Error("Linear didn't accept the comment");
      }
      return { id: data.commentCreate.comment.id };
    },
    project_triage_run: async ({ projectIds }) => {
      const { openRouterApiKey, staleAfterDays } = await settings.get();
      if (typeof openRouterApiKey !== "string" || openRouterApiKey.trim() === "") {
        throw new Error("Set the OpenRouter API key in the plugin settings to triage with Jev.");
      }
      const jev = openRouterJev(openRouterApiKey.trim());
      const { projectStatuses } = await linear<{ projectStatuses: { nodes: { id: string; name: string; type: string; position: number }[] } }>(
        PROJECT_STATUSES_QUERY,
      );
      const proposals = [];
      // One project per Linear query keeps each under Linear's complexity limit.
      for (let start = 0; start < projectIds.length; start += 4) {
        const batch = projectIds.slice(start, start + 4);
        proposals.push(
          ...(await Promise.all(
            batch.map(async (projectId) => {
              try {
                const data = await linear<{ project: Parameters<typeof toTriageInput>[0] | null }>(PROJECT_TRIAGE_QUERY, { id: projectId });
                if (data.project === null) throw new Error("Project not found");
                const input = toTriageInput(data.project);
                if (!isTriageable(input.statusType)) return null;
                return { ...(await triageProject(jev, input, { statuses: projectStatuses.nodes, staleAfterDays })), error: null };
              } catch (cause) {
                return { projectId, name: projectId, flags: [], changes: [], error: errorMessage(cause) };
              }
            }),
          )),
        );
      }
      return { proposals: proposals.filter((proposal) => proposal !== null) };
    },
    project_triage_apply: async ({ updates }) => {
      const results = [];
      for (const { projectId, statusId } of updates) {
        try {
          const data = await linear<{ projectUpdate: { success: boolean } }>(PROJECT_STATUS_MUTATION, { id: projectId, input: { statusId } });
          if (!data.projectUpdate.success) throw new Error("Linear didn't accept the status change");
          results.push({ projectId, error: null });
        } catch (cause) {
          results.push({ projectId, error: errorMessage(cause) });
        }
      }
      return { results };
    },
    triage_status: async () => {
      const { openRouterApiKey } = await settings.get();
      return { configured: typeof openRouterApiKey === "string" && openRouterApiKey.trim() !== "" };
    },
    triage_run: async ({ issueIds, linkedIssueIds }) => {
      const { openRouterApiKey, triageGuidelines, staleAfterDays } = await settings.get();
      if (typeof openRouterApiKey !== "string" || openRouterApiKey.trim() === "") {
        throw new Error("Set the OpenRouter API key in the plugin settings to triage with Jev.");
      }
      const jev = openRouterJev(openRouterApiKey.trim());
      const loaded = await loadTriageIssues(linear, [...new Set(issueIds)], {
        staleAfterDays,
        linkedIssueIds: new Set(linkedIssueIds),
      });
      const contexts = new Map<string, Promise<TriageContext>>();
      const contextFor = (teamId: string) => {
        if (!contexts.has(teamId)) contexts.set(teamId, loadTriageContext(linear, teamId, triageGuidelines));
        return contexts.get(teamId)!;
      };
      // A few requests at a time; one failing ticket doesn't sink the batch.
      const proposals: (TriageProposal & { error: string | null })[] = [];
      for (let start = 0; start < loaded.length; start += 5) {
        const batch = loaded.slice(start, start + 5);
        proposals.push(
          ...(await Promise.all(
            batch.map(async ({ teamId, issue }) => {
              try {
                return { ...(await triageIssue(jev, issue, await contextFor(teamId))), error: null };
              } catch (cause) {
                return {
                  issueId: issue.id,
                  identifier: issue.identifier,
                  title: issue.title,
                  changes: [],
                  readiness: null,
                  needsInfo: false,
                  error: errorMessage(cause),
                };
              }
            }),
          )),
        );
      }
      const order = new Map(issueIds.map((id, index) => [id, index]));
      proposals.sort((a, b) => (order.get(a.issueId) ?? 0) - (order.get(b.issueId) ?? 0));
      return { proposals };
    },
    triage_apply: async ({ updates }) => {
      const results = [];
      for (const { issueId, comments, ...update } of updates) {
        try {
          if (Object.keys(update).length > 0) await applyIssueUpdate(linear, issueId, update);
          for (const body of comments ?? []) {
            await linear(COMMENT_CREATE_MUTATION, { input: { issueId, body } });
          }
          results.push({ issueId, error: null });
        } catch (cause) {
          results.push({ issueId, error: errorMessage(cause) });
        }
      }
      return { results };
    },
    issues_by_identifiers: async ({ identifiers }) => ({
      issues: await issuesByIdentifiers([...new Set(identifiers)]),
    }),
    // Stored links still show when Linear is unreachable; only branch
    // matching needs the team keys.
    links_list: async () => ({
      links: selectLinks.all() as StoredLink[],
      teamKeys: (await readApiKey()) === null ? [] : await teamKeys().catch(() => []),
    }),
    link_set: ({ threadId, identifier }) => {
      storeLink(threadId, identifier, "manual");
      return { ok: true as const };
    },
    link_reset: ({ threadId }) => {
      clearLink(threadId);
      return { ok: true as const };
    },
    spawn_recorded: async ({ threadId, identifier, teamKey, projectId }) => {
      storeLink(threadId, identifier, "spawn");
      await bb.storage.kv.set(`teamProject:${teamKey}`, projectId);
      return { ok: true as const };
    },
    worktrees_existing: async ({ projectId, hostId }) => {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources.find((candidate) => candidate.hostId === hostId && candidate.type === "local_path");
      if (source === undefined) return { worktrees: [] };
      const { worktrees } = await linearWorktree.listExisting({ sourcePath: source.path, hostId });
      return { worktrees: worktrees.filter((entry) => !entry.prunable).map(({ path, branch }) => ({ path, branch })) };
    },
    project_default_host: async ({ projectId }) => {
      const project = await bb.sdk.projects.get({ projectId }).catch(() => null);
      const sources = project?.sources.filter((source) => source.type === "local_path") ?? [];
      const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
      return { hostId: source?.hostId ?? null };
    },
    team_project_get: async ({ teamKey }) => ({
      projectId: (await bb.storage.kv.get<string>(`teamProject:${teamKey}`)) ?? null,
    }),
  });

  // Linear serves pasted images and attachments from uploads.linear.app only
  // with the API key, so <img> tags in the UI point here and the key stays on
  // the server. Only that host is proxied, so the key can't leak elsewhere.
  bb.http.route(
    "GET",
    "/upload",
    async (c) => {
      let target: URL;
      try {
        target = new URL(c.req.query("url") ?? "");
      } catch {
        return c.text("Invalid url", 400);
      }
      if (target.protocol !== "https:" || target.hostname !== LINEAR_UPLOADS_HOST) {
        return c.text("Only Linear uploads can be proxied", 403);
      }
      const apiKey = await readApiKey();
      if (apiKey === null) return c.text("Linear API key is not configured", 503);
      const upstream = await fetch(target, {
        headers: { Authorization: apiKey },
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (upstream === null || !upstream.ok || upstream.body === null) {
        return c.text("Couldn't fetch the upload from Linear", 502);
      }
      const length = Number(upstream.headers.get("content-length") ?? "0");
      if (length > MAX_UPLOAD_BYTES) return c.text("Upload too large to preview", 413);
      const type = upstream.headers.get("content-type") ?? "application/octet-stream";
      const inline = /^(image|video)\//.test(type);
      return new Response(upstream.body, {
        headers: {
          "Content-Type": inline ? type : "application/octet-stream",
          ...(inline ? {} : { "Content-Disposition": "attachment" }),
          ...(length > 0 ? { "Content-Length": String(length) } : {}),
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          // An uploaded SVG opened directly can't run scripts.
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        },
      });
    },
    { auth: "local" },
  );

  registerCli(bb, {
    linear,
    listIssues: () => listIssues("assigned", false, ""),
    getIssue,
    linkForThread,
    storeLink,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bounded(text: string): string {
  return text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated)` : text;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
