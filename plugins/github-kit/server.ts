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
import { PR_DETAIL_QUERY, actorSchema, normalizeDetail, prDetailSchema, type PrDetail, type RawPrDetail } from "./detail";
import { parsePrKey, prKey, type PrRef } from "./shared/pr-ref";
import { PR_DIFF_META_QUERY, SHA_PATTERN, diffRangeSchema, prDiffSchema, toDiffFiles, type DiffFile, type PrDiff, type RawDiffMeta, type RestFile } from "./diff";
import { PR_CHECKS_QUERY, normalizeChecks, prChecksSchema, type PrChecks, type RawPrChecks } from "./checks";
import { buildCommentsPrompt } from "./shared/prompt";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = `${GITHUB_API_URL}/graphql`;
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
const prKeySchema = z
  .string()
  .max(250)
  .transform((value, context) => {
    const ref = parsePrKey(value);
    if (ref === null) {
      context.addIssue({ code: "custom", message: "Expected owner/repo#number" });
      return z.NEVER;
    }
    return ref;
  });
const loginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]|\[bot\]){0,60}$/, "Invalid GitHub login");
const threadIdSchema = z.string().min(1).max(100);
// A diff line anchor, GitHub's shape: RIGHT is the new code, LEFT the old.
const lineAnchorSchema = z
  .object({
    path: z.string().min(1).max(1000),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().nullable(),
    side: z.enum(["LEFT", "RIGHT"]),
  })
  .strict()
  .refine((anchor) => anchor.startLine === null || anchor.startLine < anchor.line, "startLine must come before line");
const reviewBodySchema = z.string().trim().min(1).max(20_000);

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
  pr_get: {
    input: z.object({ key: prKeySchema }).strict(),
    output: prDetailSchema,
  },
  // The PR whose head is this branch, for threads where BB's own lookup
  // found nothing (for example a branch that tracks the base branch).
  pr_for_branch: {
    input: z.object({ branch: z.string().min(1).max(250) }).strict(),
    output: z.object({ key: z.string().nullable() }),
  },
  reviewer_candidates: {
    input: z.object({ key: prKeySchema, query: z.string().trim().max(100) }).strict(),
    output: z.object({ users: z.array(actorSchema.extend({ name: z.string().nullable(), suggested: z.boolean() })) }),
  },
  reviewers_update: {
    input: z
      .object({ key: prKeySchema, add: z.array(loginSchema).max(20), remove: z.array(loginSchema).max(20) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Polled by the UI; fast while checks run, slow once they're done.
  pr_checks: {
    input: z.object({ key: prKeySchema }).strict(),
    output: prChecksSchema,
  },
  pr_diff: {
    input: z.object({ key: prKeySchema, range: diffRangeSchema }).strict(),
    output: prDiffSchema,
  },
  // GitHub's per-file "Viewed" checkbox, shown as "Reviewed".
  file_viewed: {
    input: z.object({ key: prKeySchema, path: z.string().min(1).max(1000), viewed: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // One review comment posted right away, outside any review.
  review_comment: {
    input: z.object({ key: prKeySchema, anchor: lineAnchorSchema, body: reviewBodySchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Submits a review with the comments drafted in the diff.
  review_submit: {
    input: z
      .object({
        key: prKeySchema,
        event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
        body: z.string().trim().max(20_000),
        comments: z.array(z.object({ anchor: lineAnchorSchema, body: reviewBodySchema }).strict()).max(100),
      })
      .strict()
      .refine((review) => review.event === "APPROVE" || review.body !== "" || review.comments.length > 0, "Add a summary or a comment first"),
    output: z.object({ ok: z.literal(true), url: z.string().nullable() }),
  },
  // Queues a note about specific lines on a thread, for the agent to act on.
  line_to_agent: {
    input: z.object({ threadId: threadIdSchema, key: prKeySchema, anchor: lineAnchorSchema, body: reviewBodySchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  thread_resolve: {
    input: z.object({ key: prKeySchema, itemId: z.string().min(1).max(200), resolved: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Replies in the review thread, or, for a conversation comment or review
  // summary (GitHub doesn't thread those), posts a quoting PR comment.
  // itemId null posts a new top-level comment.
  comment_post: {
    input: z
      .object({ key: prKeySchema, itemId: z.string().min(1).max(200).nullable(), body: z.string().trim().min(1).max(20_000) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // Queues selected comments as one message on a thread. The server
  // re-reads the PR, so the prompt only ever carries GitHub's own text.
  comments_send: {
    input: z
      .object({
        threadId: threadIdSchema,
        key: prKeySchema,
        itemIds: z.array(z.string().min(1).max(200)).min(1).max(100),
        note: z.string().max(4000),
      })
      .strict(),
    output: z.object({ queued: z.number() }),
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

  async function githubRest(method: "POST" | "DELETE", path: string, body: unknown): Promise<void> {
    const auth = await resolveToken();
    if (auth === null) throw new Error("No GitHub token.");
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        "User-Agent": "bb-plugin-github-kit",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`GitHub ${method} failed with HTTP ${response.status}${detail?.message ? `: ${detail.message}` : ""}`);
    }
  }

  async function githubRestJson<T>(method: "POST", path: string, body: unknown): Promise<T> {
    const auth = await resolveToken();
    if (auth === null) throw new Error("No GitHub token.");
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/json",
        "User-Agent": "bb-plugin-github-kit",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await response.json().catch(() => null)) as (T & { message?: string; errors?: unknown[] }) | null;
    if (!response.ok) {
      const errors = Array.isArray(json?.errors) ? ` (${json!.errors.map((error) => (typeof error === "string" ? error : JSON.stringify(error))).join("; ")})` : "";
      throw new Error(`GitHub ${method} failed with HTTP ${response.status}${json?.message ? `: ${json.message}` : ""}${errors}`);
    }
    return json as T;
  }

  async function githubGet<T>(path: string): Promise<T> {
    const auth = await resolveToken();
    if (auth === null) throw new Error("No GitHub token.");
    const response = await fetch(`${GITHUB_API_URL}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth.token}`,
        "User-Agent": "bb-plugin-github-kit",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`GitHub GET failed with HTTP ${response.status}${detail?.message ? `: ${detail.message}` : ""}`);
    }
    return (await response.json()) as T;
  }

  async function diffMeta(ref: PrRef) {
    // Viewed states page by 100; the rest of the query rides on the first page.
    let after: string | null = null;
    let first: NonNullable<NonNullable<RawDiffMeta["repository"]>["pullRequest"]> | null = null;
    let login = "";
    const viewed = new Map<string, DiffFile["viewed"]>();
    for (let page = 0; page < 30; page++) {
      const data: RawDiffMeta = await github<RawDiffMeta>(PR_DIFF_META_QUERY, { owner: ref.owner, name: ref.name, number: ref.number, after });
      const pr = data.repository?.pullRequest ?? null;
      if (pr === null) throw new Error(`Pull request ${prKey(ref)} not found`);
      first ??= pr;
      login = data.viewer.login;
      for (const node of pr.files.nodes) viewed.set(node.path, node.viewerViewedState);
      if (!pr.files.pageInfo.hasNextPage) break;
      after = pr.files.pageInfo.endCursor;
    }
    const pr = first!;
    const shas = new Set(pr.commits.nodes.map((node) => node.commit.oid));
    const mine = pr.reviews.nodes.filter((review) => review.author?.login === login && review.commit !== null);
    const lastReviewSha = mine.length > 0 ? mine[mine.length - 1]!.commit!.oid : null;
    return {
      id: pr.id,
      headSha: pr.headRefOid,
      viewed,
      lastReviewSha: lastReviewSha !== null && shas.has(lastReviewSha) ? lastReviewSha : null,
      commits: pr.commits.nodes.map(({ commit }) => ({
        sha: commit.oid,
        shortSha: commit.abbreviatedOid,
        message: commit.messageHeadline,
        author: commit.author?.user?.login ?? commit.author?.name ?? "unknown",
        committedAt: commit.committedDate,
      })),
    };
  }

  async function getDiff(ref: PrRef, range: z.infer<typeof diffRangeSchema>): Promise<PrDiff> {
    const meta = await diffMeta(ref);
    const repo = `/repos/${ref.owner}/${ref.name}`;
    let files: RestFile[] = [];
    let truncated = false;
    if (range.kind === "all") {
      // GitHub lists at most 3000 files, 100 per page.
      for (let page = 1; page <= 30; page++) {
        const batch = await githubGet<RestFile[]>(`${repo}/pulls/${ref.number}/files?per_page=100&page=${page}`);
        files.push(...batch);
        if (batch.length < 100) break;
        if (page === 30) truncated = true;
      }
    } else {
      let path: string;
      if (range.kind === "commit") {
        if (!meta.commits.some((commit) => commit.sha.startsWith(range.sha))) throw new Error("That commit isn't part of this pull request.");
        path = `${repo}/commits/${range.sha}`;
      } else {
        if (meta.lastReviewSha === null) throw new Error("You haven't reviewed this pull request yet.");
        path = `${repo}/compare/${meta.lastReviewSha}...${meta.headSha}`;
      }
      // Both endpoints cap at 300 files.
      const result = await githubGet<{ files?: RestFile[] }>(path);
      files = result.files ?? [];
      truncated = files.length >= 300;
      // A base branch merged in since the review would show up in the
      // compare; keep only files that are part of the PR itself.
      if (range.kind === "since-review") files = files.filter((file) => meta.viewed.has(file.filename));
    }
    const { files: diffFiles, cut } = toDiffFiles(files, meta.viewed);
    let changedSinceReview: string[] = [];
    if (range.kind === "all" && meta.lastReviewSha !== null && meta.lastReviewSha !== meta.headSha) {
      // Names only matter here; a failure just hides the marker.
      const compare = await githubGet<{ files?: { filename: string }[] }>(`${repo}/compare/${meta.lastReviewSha}...${meta.headSha}`).catch(() => null);
      changedSinceReview = (compare?.files ?? []).map((file) => file.filename).filter((path) => meta.viewed.has(path));
    }
    return {
      headSha: meta.headSha,
      lastReviewSha: meta.lastReviewSha,
      commits: meta.commits,
      files: diffFiles,
      truncated: truncated || cut,
      changedSinceReview,
    };
  }

  async function getPullRequest(ref: PrRef): Promise<PrDetail> {
    const data = await github<{ viewer: { login: string }; repository: { pullRequest: RawPrDetail | null } | null }>(PR_DETAIL_QUERY, {
      owner: ref.owner,
      name: ref.name,
      number: ref.number,
    });
    const raw = data.repository?.pullRequest ?? null;
    if (raw === null) throw new Error(`Pull request ${prKey(ref)} not found`);
    return normalizeDetail(raw, prKey(ref), data.viewer.login);
  }

  // The tab, the list and several windows can poll the same PR; they share
  // one GitHub call every few seconds.
  const checksCache = new Map<string, { at: number; promise: Promise<PrChecks> }>();
  function getChecks(ref: PrRef): Promise<PrChecks> {
    const key = prKey(ref);
    const cached = checksCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.promise;
    const promise = github<{ repository: { pullRequest: RawPrChecks | null } | null }>(PR_CHECKS_QUERY, {
      owner: ref.owner,
      name: ref.name,
      number: ref.number,
    }).then((data) => {
      const raw = data.repository?.pullRequest ?? null;
      if (raw === null) throw new Error(`Pull request ${key} not found`);
      return normalizeChecks(raw, Date.now());
    });
    checksCache.set(key, { at: Date.now(), promise });
    promise.catch(() => checksCache.delete(key));
    if (checksCache.size > 200) checksCache.delete(checksCache.keys().next().value!);
    return promise;
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
    pr_get: ({ key }) => getPullRequest(key),
    pr_for_branch: async ({ branch }) => {
      // involves:@me keeps a common name like "main" from matching strangers' PRs.
      const q = `is:pr involves:@me head:"${branch.replace(/"/g, "")}" sort:updated-desc`;
      const data = await github<{ search: { nodes: ({ number: number; headRefName: string; repository: { nameWithOwner: string } } | Record<string, never>)[] } }>(
        `query Branch($q: String!) { search(query: $q, type: ISSUE, first: 5) { nodes { ... on PullRequest { number headRefName repository { nameWithOwner } } } } }`,
        { q },
      );
      const match = data.search.nodes.find(
        (node): node is { number: number; headRefName: string; repository: { nameWithOwner: string } } =>
          "number" in node && node.headRefName === branch,
      );
      return { key: match ? `${match.repository.nameWithOwner}#${match.number}` : null };
    },
    reviewer_candidates: async ({ key, query }) => {
      type RawUser = { __typename: string; login: string; avatarUrl: string; name?: string | null };
      const data = await github<{
        repository: {
          assignableUsers: { nodes: RawUser[] };
          pullRequest: { suggestedReviewers: { reviewer: RawUser }[] } | null;
        } | null;
      }>(
        `query Candidates($owner: String!, $name: String!, $number: Int!, $query: String) {
          repository(owner: $owner, name: $name) {
            assignableUsers(first: 30, query: $query) { nodes { __typename login avatarUrl name } }
            pullRequest(number: $number) { suggestedReviewers { reviewer { __typename login avatarUrl name } } }
          }
        }`,
        { owner: key.owner, name: key.name, number: key.number, query: query === "" ? null : query },
      );
      const users = new Map<string, { login: string; avatarUrl: string; isBot: boolean; name: string | null; suggested: boolean }>();
      const needle = query.toLowerCase();
      for (const { reviewer } of data.repository?.pullRequest?.suggestedReviewers ?? []) {
        if (needle !== "" && !`${reviewer.login} ${reviewer.name ?? ""}`.toLowerCase().includes(needle)) continue;
        users.set(reviewer.login, { login: reviewer.login, avatarUrl: reviewer.avatarUrl, isBot: false, name: reviewer.name ?? null, suggested: true });
      }
      for (const user of data.repository?.assignableUsers.nodes ?? []) {
        if (!users.has(user.login)) {
          users.set(user.login, { login: user.login, avatarUrl: user.avatarUrl, isBot: user.__typename === "Bot", name: user.name ?? null, suggested: false });
        }
      }
      return { users: [...users.values()] };
    },
    reviewers_update: async ({ key, add, remove }) => {
      const path = `/repos/${key.owner}/${key.name}/pulls/${key.number}/requested_reviewers`;
      if (add.length > 0) await githubRest("POST", path, { reviewers: add });
      if (remove.length > 0) await githubRest("DELETE", path, { reviewers: remove });
      return { ok: true as const };
    },
    pr_checks: ({ key }) => getChecks(key),
    pr_diff: ({ key, range }) => getDiff(key, range),
    file_viewed: async ({ key, path, viewed }) => {
      const data = await github<{ repository: { pullRequest: { id: string } | null } | null }>(
        `query Id($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } } }`,
        { owner: key.owner, name: key.name, number: key.number },
      );
      const id = data.repository?.pullRequest?.id;
      if (id === undefined) throw new Error(`Pull request ${prKey(key)} not found`);
      const mutation = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
      await github(`mutation Viewed($id: ID!, $path: String!) { ${mutation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id, path });
      return { ok: true as const };
    },
    review_comment: async ({ key, anchor, body }) => {
      const headSha = (await getChecks(key)).headSha;
      await githubRest("POST", `/repos/${key.owner}/${key.name}/pulls/${key.number}/comments`, {
        body,
        commit_id: headSha,
        ...restAnchor(anchor),
      });
      return { ok: true as const };
    },
    review_submit: async ({ key, event, body, comments }) => {
      const detail = await getPullRequest(key);
      if (event !== "COMMENT" && detail.viewerIsAuthor) throw new Error("GitHub doesn't let you approve or request changes on your own pull request.");
      const headSha = (await getChecks(key)).headSha;
      const result = await githubRestJson<{ html_url?: string }>("POST", `/repos/${key.owner}/${key.name}/pulls/${key.number}/reviews`, {
        commit_id: headSha,
        event,
        ...(body !== "" ? { body } : {}),
        comments: comments.map((comment) => ({ body: comment.body, ...restAnchor(comment.anchor) })),
      });
      return { ok: true as const, url: result.html_url ?? null };
    },
    line_to_agent: async ({ threadId, key, anchor, body }) => {
      const detail = await getPullRequest(key);
      const lines = anchor.startLine === null ? `line ${anchor.line}` : `lines ${anchor.startLine}-${anchor.line}`;
      const side = anchor.side === "RIGHT" ? "new code" : "old code (removed by the PR)";
      const text = [
        `About ${anchor.path}, ${lines} (${side}) in ${detail.key} (${detail.title}), ${detail.url}:`,
        "",
        body,
        "",
        `Read the current file before changing it. The line numbers match the PR head (${detail.headRefName}), so unpushed local edits may shift them. Don't push, and don't reply or resolve anything on GitHub.`,
      ].join("\n");
      await bb.sdk.threads.queuedMessages.create({ threadId, input: [{ type: "text", text, mentions: [] }] });
      return { ok: true as const };
    },
    thread_resolve: async ({ key, itemId, resolved }) => {
      // Re-read the PR so only one of its own review threads can be touched.
      const item = (await getPullRequest(key)).feed.find((candidate) => candidate.id === itemId);
      if (item === undefined || item.kind !== "thread") throw new Error("That review thread isn't on this pull request.");
      const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
      await github(`mutation Resolve($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, { id: item.id });
      return { ok: true as const };
    },
    comment_post: async ({ key, itemId, body }) => {
      const detail = await getPullRequest(key);
      const item = itemId === null ? null : detail.feed.find((candidate) => candidate.id === itemId);
      if (item === undefined) throw new Error("That comment isn't on this pull request anymore.");
      if (item?.kind === "thread") {
        await github(
          `mutation Reply($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`,
          { thread: item.id, body },
        );
      } else {
        const text = item === null ? body : `${quoteFor(item.author?.login ?? "ghost", item.body, item.url)}\n\n${body}`;
        await github(`mutation Comment($subject: ID!, $body: String!) { addComment(input: { subjectId: $subject, body: $body }) { clientMutationId } }`, {
          subject: detail.id,
          body: text,
        });
      }
      return { ok: true as const };
    },
    comments_send: async ({ threadId, key, itemIds, note }) => {
      const detail = await getPullRequest(key);
      const wanted = new Set(itemIds);
      const items = detail.feed.filter((item) => wanted.has(item.id));
      if (items.length === 0) throw new Error("None of the selected comments exist anymore.");
      await bb.sdk.threads.queuedMessages.create({
        threadId,
        input: [{ type: "text", text: buildCommentsPrompt(detail, items, note), mentions: [] }],
      });
      return { queued: items.length };
    },
  });

  const usage = [
    "Usage:",
    "  bb github-kit prs [--scope review|reviewed|authored|assigned|involved] [--closed] [--json] [search...]",
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
        usage: "bb github-kit prs [--scope review|reviewed|authored|assigned|involved] [--closed] [--json] [search...]",
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

function restAnchor(anchor: { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT" }) {
  return {
    path: anchor.path,
    line: anchor.line,
    side: anchor.side,
    ...(anchor.startLine !== null ? { start_line: anchor.startLine, start_side: anchor.side } : {}),
  };
}

// GitHub's own "Quote reply" shape, trimmed so long comments don't get pasted whole.
function quoteFor(login: string, body: string, url: string): string {
  const lines = body.trim().split("\n");
  const kept = lines.slice(0, 6).map((line) => `> ${line}`);
  if (lines.length > 6) kept.push("> …");
  return [`> [@${login}](${url}):`, ...kept].join("\n");
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
