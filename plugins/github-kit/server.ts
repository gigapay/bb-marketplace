// bb-plugin-github-kit: your GitHub pull requests in BB.
//
// The token is a secret setting (or `gh auth token` on the BB server), so
// every GitHub call goes through this backend. app.tsx talks to it over the
// RPC contract below.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PR_SCOPES, buildPrSearch, type PrScope } from "./shared/search";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const PAGE_SIZE = 50;

const checksStateSchema = z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]);

const pullRequestSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  headRefName: z.string(),
  baseRefName: z.string(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  checks: checksStateSchema.nullable(),
  comments: z.number(),
  repository: z.string(),
  author: z.object({ login: z.string(), avatarUrl: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const scopeSchema = z.enum(PR_SCOPES);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      source: z.enum(["setting", "gh"]).nullable(),
      viewer: z.object({ login: z.string(), name: z.string().nullable() }).nullable(),
      error: z.string().nullable(),
    }),
  },
  prs_list: {
    input: z
      .object({
        scope: scopeSchema,
        includeClosed: z.boolean(),
        query: z.string().trim().max(200),
      })
      .strict(),
    output: z.object({ pullRequests: z.array(pullRequestSchema), total: z.number() }),
  },
});

const VIEWER_QUERY = `query Viewer { viewer { login name } }`;

const SEARCH_QUERY = `query PullRequests($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        id number title url state isDraft createdAt updatedAt
        additions deletions headRefName baseRefName reviewDecision
        author { login avatarUrl }
        repository { nameWithOwner }
        labels(first: 10) { nodes { name color } }
        comments { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

type RawPullRequest = Omit<PullRequest, "checks" | "comments" | "repository" | "labels"> & {
  repository: { nameWithOwner: string };
  labels: { nodes: PullRequest["labels"] };
  comments: { totalCount: number };
  commits: { nodes: { commit: { statusCheckRollup: { state: PullRequest["checks"] } | null } }[] };
};

function flatten(raw: RawPullRequest): PullRequest {
  const { commits, repository, labels, comments, ...rest } = raw;
  return {
    ...rest,
    repository: repository.nameWithOwner,
    labels: labels.nodes,
    comments: comments.totalCount,
    checks: commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
  };
}

const execFileAsync = promisify(execFile);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    token: {
      type: "string",
      label: "GitHub token",
      description:
        "Personal access token with the repo and read:org scopes. Leave empty to use `gh auth token` on the BB server.",
      secret: true,
    },
  });

  // `gh auth token` is cheap but spawns a process, so keep the answer for a
  // few minutes. A failure is cached too, so a missing gh isn't retried on
  // every call.
  let ghTokenCache: { token: string | null; fetchedAt: number } | null = null;
  settings.onChange(() => {
    ghTokenCache = null;
  });

  async function ghToken(): Promise<string | null> {
    if (ghTokenCache !== null && Date.now() - ghTokenCache.fetchedAt < 5 * 60_000) return ghTokenCache.token;
    let token: string | null = null;
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 5_000 });
      token = stdout.trim() || null;
    } catch {
      token = null;
    }
    ghTokenCache = { token, fetchedAt: Date.now() };
    return token;
  }

  async function resolveToken(): Promise<{ token: string; source: "setting" | "gh" } | null> {
    const { token } = await settings.get();
    if (typeof token === "string" && token.trim() !== "") return { token: token.trim(), source: "setting" };
    const fromGh = await ghToken();
    return fromGh === null ? null : { token: fromGh, source: "gh" };
  }

  async function github<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const auth = await resolveToken();
    if (auth === null) {
      throw new Error("No GitHub token. Set one in the plugin settings or run `gh auth login` on the BB server.");
    }
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "User-Agent": "bb-plugin-github-kit",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: { message: string }[];
      message?: string;
    } | null;
    if (body?.errors?.length) {
      throw new Error(`GitHub: ${body.errors.map((error) => error.message).join("; ")}`);
    }
    if (!response.ok || body?.data == null) {
      throw new Error(`GitHub request failed with HTTP ${response.status}${body?.message ? `: ${body.message}` : ""}`);
    }
    return body.data;
  }

  async function listPullRequests(scope: PrScope, includeClosed: boolean, query: string) {
    const data = await github<{ search: { issueCount: number; nodes: (RawPullRequest | Record<string, never>)[] } }>(
      SEARCH_QUERY,
      { q: buildPrSearch(scope, includeClosed, query), first: PAGE_SIZE },
    );
    // Search can return non-PR nodes as empty objects; skip them.
    const pullRequests = data.search.nodes
      .filter((node): node is RawPullRequest => "number" in node)
      .map(flatten);
    return { pullRequests, total: data.search.issueCount };
  }

  bb.rpc.register(rpcContract, {
    status: async () => {
      const auth = await resolveToken();
      if (auth === null) return { configured: false, source: null, viewer: null, error: null };
      try {
        const data = await github<{ viewer: { login: string; name: string | null } }>(VIEWER_QUERY);
        return { configured: true, source: auth.source, viewer: data.viewer, error: null };
      } catch (cause) {
        return { configured: true, source: auth.source, viewer: null, error: errorMessage(cause) };
      }
    },
    prs_list: ({ scope, includeClosed, query }) => listPullRequests(scope, includeClosed, query),
  });

  const usage = [
    "Usage:",
    "  bb github-kit prs [--scope review|authored|assigned|involved] [--closed] [--json] [search...]",
    "",
    "The scope defaults to review. Search accepts GitHub qualifiers, e.g. repo:owner/name.",
  ].join("\n");
  bb.cli.register({
    name: "github-kit",
    summary: "List your GitHub pull requests",
    commands: [
      {
        name: "prs",
        summary: "List pull requests awaiting your review, authored by you, assigned to you, or involving you",
        usage: "bb github-kit prs [--scope review|authored|assigned|involved] [--closed] [--json] [search...]",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      if (command !== "prs") {
        const isHelp = command === undefined || command === "help" || command === "--help";
        return isHelp ? { exitCode: 0, stdout: usage } : { exitCode: 1, stderr: usage };
      }
      let scope: PrScope = "review";
      let includeClosed = false;
      let json = false;
      const terms: string[] = [];
      for (let index = 0; index < rest.length; index++) {
        const arg = rest[index]!;
        if (arg === "--json") json = true;
        else if (arg === "--closed") includeClosed = true;
        else if (arg === "--scope" || arg.startsWith("--scope=")) {
          const value = arg === "--scope" ? rest[++index] : arg.slice("--scope=".length);
          const parsed = scopeSchema.safeParse(value);
          if (!parsed.success) return { exitCode: 1, stderr: usage };
          scope = parsed.data;
        } else terms.push(arg);
      }
      const query = terms.join(" ");
      if (query.length > 200) return { exitCode: 1, stderr: "Search is limited to 200 characters." };
      try {
        const { pullRequests, total } = await listPullRequests(scope, includeClosed, query);
        if (json) return { exitCode: 0, stdout: bounded(JSON.stringify({ pullRequests, total })) };
        if (pullRequests.length === 0) return { exitCode: 0, stdout: "No pull requests." };
        const lines = pullRequests.map((pr) => {
          const flags = [prStateLabel(pr), pr.reviewDecision, pr.checks && `checks ${pr.checks}`].filter(Boolean);
          return `${pr.repository}#${pr.number}  [${flags.join(", ")}]  ${pr.title}\n  ${pr.url}`;
        });
        if (total > pullRequests.length) lines.push(`… ${total - pullRequests.length} more, narrow the search.`);
        return { exitCode: 0, stdout: bounded(lines.join("\n")) };
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
    },
  });
}

function prStateLabel(pr: PullRequest): string {
  if (pr.state === "OPEN" && pr.isDraft) return "draft";
  return pr.state.toLowerCase();
}

function bounded(text: string): string {
  return text.length > 200_000 ? `${text.slice(0, 200_000)}\n… (truncated)` : text;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
