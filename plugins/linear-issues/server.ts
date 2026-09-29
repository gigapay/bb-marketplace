// bb-plugin-linear: browse your Linear issues and start BB threads from them.
//
// The Linear API key is a secret setting, so every Linear call goes through
// this backend. app.tsx talks to it over the RPC contract below.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const LINEAR_API_URL = "https://api.linear.app/graphql";

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
  user: userSchema.nullable(),
});

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

const scopeSchema = z.enum(["assigned", "created", "subscribed"]);
export type IssueScope = z.infer<typeof scopeSchema>;

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
      })
      .strict(),
    output: z.object({ issues: z.array(issueSummarySchema) }),
  },
  issue_get: {
    input: z.object({ id: z.string().min(1).max(100) }).strict(),
    output: issueDetailSchema,
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

// "subscribed" has no viewer connection, so it goes through the root
// `issues` query with a subscriber filter instead.
function issuesQuery(scope: IssueScope): string {
  if (scope === "subscribed") {
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

const ISSUE_DETAIL_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    ${ISSUE_SUMMARY_FIELDS}
    description branchName createdAt estimate dueDate
    cycle { id name number }
    parent { id identifier title }
    children(first: 50) { nodes { id identifier title state { ${STATE_FIELDS} } } }
    comments(first: 50, orderBy: createdAt) {
      nodes { id body createdAt user { ${USER_FIELDS} } }
    }
  }
}`;

type Connection<T> = { nodes: T[] };
type RawSummary = Omit<IssueSummary, "labels"> & {
  labels: Connection<IssueSummary["labels"][number]>;
};
type RawDetail = Omit<IssueDetail, "labels" | "children" | "comments"> & {
  labels: Connection<IssueSummary["labels"][number]>;
  children: Connection<IssueDetail["children"][number]>;
  comments: Connection<IssueDetail["comments"][number]>;
};

function flattenSummary(raw: RawSummary): IssueSummary {
  return { ...raw, labels: raw.labels.nodes };
}

function flattenDetail(raw: RawDetail): IssueDetail {
  return {
    ...raw,
    labels: raw.labels.nodes,
    children: raw.children.nodes,
    comments: raw.comments.nodes,
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
  });

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
  ): Promise<IssueSummary[]> {
    const filter = openIssuesFilter(includeCompleted);
    if (query !== "") {
      filter.or = [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } },
      ];
    }
    if (scope === "subscribed") {
      filter.subscribers = { isMe: { eq: true } };
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
    issues_list: async ({ scope, includeCompleted, query }) => ({
      issues: await listIssues(scope, includeCompleted, query),
    }),
    issue_get: ({ id }) => getIssue(id),
  });

  // Lets agents in a thread started from a ticket re-read it on demand.
  const usage = "Usage:\n  bb linear-issues list [--json]\n  bb linear-issues show <identifier> [--json]";
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
    ],
    async run(argv) {
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
  for (const comment of issue.comments) {
    lines.push("", `--- ${comment.user?.name ?? "Unknown"} (${comment.createdAt})`, comment.body);
  }
  return lines.join("\n");
}

function bounded(text: string): string {
  return text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated)` : text;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
