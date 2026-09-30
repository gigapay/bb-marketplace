// bb-plugin-linear: browse your Linear issues and start BB threads from them.
//
// The Linear API key is a secret setting, so every Linear call goes through
// this backend. app.tsx talks to it over the RPC contract below.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./contract.js";
import { groupCommentThreads } from "./shared/comments.js";
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
import { registerLinearWorktree } from "./worktree/provider.js";
import { triageIssue, type TriageContext, type TriageProposal } from "./triage/engine.js";
import { applyIssueUpdate, loadTriageContext, loadTriageIssues, openRouterJev } from "./triage/linear.js";
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

  async function linear<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const apiKey = await readApiKey();
    if (apiKey === null) {
      throw new Error("Linear API key is not configured. Set it in the plugin settings.");
    }
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
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
    projects_list: async ({ mine, includeClosed }) => {
      const clauses: Record<string, unknown>[] = [];
      if (mine) clauses.push({ or: [{ lead: { isMe: { eq: true } } }, { members: { some: { isMe: { eq: true } } } }] });
      if (!includeClosed) clauses.push({ status: { type: { nin: ["completed", "canceled"] } } });
      const data = await linear<{ projects: { nodes: Parameters<typeof flattenProject>[0][] } }>(PROJECTS_QUERY, {
        filter: clauses.length ? { and: clauses } : null,
      });
      return { projects: data.projects.nodes.map(flattenProject) };
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

  // Lets agents in a thread started from a ticket re-read it on demand.
  const usage = [
    "Usage:",
    "  bb linear-issues list [--json]",
    "  bb linear-issues show <identifier> [--json]",
    "  bb linear-issues current [--json]     (issue linked to this thread)",
    "  bb linear-issues link <identifier>    (link this thread to an issue)",
    "  bb linear-issues unlink",
  ].join("\n");
  bb.cli.register({
    name: "linear-issues",
    summary: "Read your Linear issues",
    commands: [
      { name: "list", summary: "List your open assigned issues", usage: "bb linear-issues list [--json]" },
      {
        name: "show",
        summary: "Show one issue with its description and comments",
        usage: "bb linear-issues show <identifier> [--json]",
      },
      {
        name: "current",
        summary: "Show the issue linked to the current thread",
        usage: "bb linear-issues current [--json]",
      },
      {
        name: "link",
        summary: "Link the current thread to an issue",
        usage: "bb linear-issues link <identifier>",
      },
      { name: "unlink", summary: "Unlink the current thread", usage: "bb linear-issues unlink" },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      try {
        if (command === "list") {
          const issues = await listIssues("assigned", false, "");
          const text = issues.length
            ? issues
                .map((issue) => `${issue.identifier}  [${issue.state.name}]  ${issue.title}`)
                .join("\n")
            : "No open assigned issues.";
          return { exitCode: 0, stdout: bounded(json ? JSON.stringify(issues) : text) };
        }
        if (command === "current" || command === "link" || command === "unlink") {
          const threadId = context?.threadId;
          if (threadId === undefined) {
            return { exitCode: 1, stderr: `\`${command}\` only works from inside a BB thread.` };
          }
          if (command === "link") {
            const parsed = identifierSchema.safeParse(args[0] ?? "");
            if (!parsed.success || args.length !== 1) return { exitCode: 1, stderr: usage };
            storeLink(threadId, parsed.data, "manual");
            return { exitCode: 0, stdout: `Linked this thread to ${parsed.data}.` };
          }
          if (command === "unlink") {
            storeLink(threadId, null, "manual");
            return { exitCode: 0, stdout: "Unlinked this thread." };
          }
          const link = await linkForThread(threadId);
          if (link === null) return { exitCode: 1, stderr: "This thread is not linked to a Linear issue." };
          if (json) {
            return { exitCode: 0, stdout: bounded(JSON.stringify({ ...link, issue: await getIssue(link.identifier) })) };
          }
          const issue = await getIssue(link.identifier);
          return { exitCode: 0, stdout: bounded(`Linked via ${link.source}.\n\n${formatIssueText(issue)}`) };
        }
        if (command === "show" && args[0] !== undefined && args.length === 1) {
          const issue = await getIssue(args[0]);
          return {
            exitCode: 0,
            stdout: bounded(json ? JSON.stringify(issue) : formatIssueText(issue)),
          };
        }
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
      const isHelp = command === undefined || command === "help" || command === "--help";
      return isHelp ? { exitCode: 0, stdout: usage } : { exitCode: 1, stderr: usage };
    },
  });
}

function formatIssueText(issue: IssueDetail): string {
  const lines = [
    `${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state.name} · Priority: ${issue.priorityLabel} · Team: ${issue.team.name}`,
    `Branch: ${issue.branchName}`,
  ];
  if (issue.project) lines.push(`Project: ${issue.project.name}`);
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.map((l) => l.name).join(", ")}`);
  lines.push("", issue.description?.trim() || "(no description)");
  for (const thread of groupCommentThreads(issue.comments)) {
    const status = thread.resolved ? " [resolved]" : "";
    lines.push("", `--- ${thread.root.author.name} (${thread.root.createdAt})${status}`, thread.root.body);
    for (const reply of thread.replies) {
      lines.push(`    ↳ ${reply.author.name} (${reply.createdAt})`, ...reply.body.split("\n").map((line) => `      ${line}`));
    }
  }
  return lines.join("\n");
}

function bounded(text: string): string {
  return text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated)` : text;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
