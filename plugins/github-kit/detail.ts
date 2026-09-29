// One pull request with its description, reviewers and every kind of
// comment, normalized into a single feed. Server-side only; views import the
// types.
import { z } from "zod";
import { isBotLogin } from "./shared/audience";

export const actorSchema = z.object({ login: z.string(), avatarUrl: z.string(), isBot: z.boolean() });
export type Actor = z.infer<typeof actorSchema>;

const replySchema = z.object({
  id: z.string(),
  author: actorSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});

// "comment" is a conversation comment, "review" a review summary with a
// body, "thread" an inline review thread (first comment + replies).
export const feedItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["comment", "review", "thread"]),
  author: actorSchema.nullable(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
  reviewState: z.string().nullable(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  // Which side of the diff the line is on; null outside review threads.
  side: z.enum(["LEFT", "RIGHT"]).nullable(),
  diffHunk: z.string().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  replies: z.array(replySchema),
});
export type FeedItem = z.infer<typeof feedItemSchema>;

export const reviewerSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().nullable(),
  isTeam: z.boolean(),
  state: z.enum(["REQUESTED", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
});
export type Reviewer = z.infer<typeof reviewerSchema>;

export const prDetailSchema = z.object({
  id: z.string(),
  key: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  headRefName: z.string(),
  baseRefName: z.string(),
  repository: z.string(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  checks: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]).nullable(),
  author: actorSchema.nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  reviewers: z.array(reviewerSchema),
  feed: z.array(feedItemSchema),
});
export type PrDetail = z.infer<typeof prDetailSchema>;

const ACTOR = `author { __typename login avatarUrl }`;

export const PR_DETAIL_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title url state isDraft body createdAt updatedAt
      additions deletions changedFiles headRefName baseRefName reviewDecision
      repository { nameWithOwner }
      ${ACTOR}
      labels(first: 20) { nodes { name color } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviewRequests(first: 30) { nodes { requestedReviewer {
        __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Team { slug avatarUrl }
      } } }
      latestOpinionatedReviews(first: 30) { nodes { state ${ACTOR} } }
      comments(last: 100) { nodes { id body createdAt url ${ACTOR} } }
      reviews(last: 100) { nodes { id body state createdAt url ${ACTOR} } }
      reviewThreads(last: 100) { nodes {
        id isResolved isOutdated path line originalLine diffSide
        comments(first: 50) { nodes { id body createdAt url diffHunk ${ACTOR} } }
      } }
    }
  }
}`;

type RawActor = { __typename: string; login: string; avatarUrl: string } | null;
type Nodes<T> = { nodes: T[] };
type RawComment = { id: string; body: string; createdAt: string; url: string; author: RawActor };

export type RawPrDetail = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: PrDetail["state"];
  isDraft: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  reviewDecision: PrDetail["reviewDecision"];
  repository: { nameWithOwner: string };
  author: RawActor;
  labels: Nodes<{ name: string; color: string }>;
  commits: Nodes<{ commit: { statusCheckRollup: { state: PrDetail["checks"] } | null } }>;
  reviewRequests: Nodes<{
    requestedReviewer:
      | { __typename: "User" | "Bot"; login: string; avatarUrl: string }
      | { __typename: "Team"; slug: string; avatarUrl: string | null }
      | { __typename: "Mannequin" }
      | null;
  }>;
  latestOpinionatedReviews: Nodes<{ state: string; author: RawActor }>;
  comments: Nodes<RawComment>;
  reviews: Nodes<RawComment & { state: string }>;
  reviewThreads: Nodes<{
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    line: number | null;
    originalLine: number | null;
    diffSide: "LEFT" | "RIGHT";
    comments: Nodes<RawComment & { diffHunk: string }>;
  }>;
};

export function toActor(raw: RawActor): Actor | null {
  if (raw === null) return null;
  return { login: raw.login, avatarUrl: raw.avatarUrl, isBot: isBotLogin(raw.login, raw.__typename) };
}

const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

export function normalizeDetail(raw: RawPrDetail, key: string): PrDetail {
  const reviewers = new Map<string, PrDetail["reviewers"][number]>();
  for (const review of raw.latestOpinionatedReviews.nodes) {
    const actor = toActor(review.author);
    if (actor === null || !REVIEW_STATES.has(review.state)) continue;
    reviewers.set(actor.login, {
      login: actor.login,
      avatarUrl: actor.avatarUrl,
      isTeam: false,
      state: review.state as PrDetail["reviewers"][number]["state"],
    });
  }
  // A pending request wins: it means a re-review was asked after the review.
  for (const { requestedReviewer: reviewer } of raw.reviewRequests.nodes) {
    if (reviewer === null || reviewer.__typename === "Mannequin") continue;
    if (reviewer.__typename === "Team") {
      reviewers.set(`team:${reviewer.slug}`, { login: reviewer.slug, avatarUrl: reviewer.avatarUrl, isTeam: true, state: "REQUESTED" });
    } else {
      reviewers.set(reviewer.login, { login: reviewer.login, avatarUrl: reviewer.avatarUrl, isTeam: false, state: "REQUESTED" });
    }
  }

  const feed: FeedItem[] = [];
  const base = { reviewState: null, path: null, line: null, side: null, diffHunk: null, isResolved: false, isOutdated: false, replies: [] };
  for (const comment of raw.comments.nodes) {
    feed.push({ ...base, id: comment.id, kind: "comment", author: toActor(comment.author), body: comment.body, createdAt: comment.createdAt, url: comment.url });
  }
  // Review summaries without a body only repeat what the threads say.
  for (const review of raw.reviews.nodes) {
    if (review.body.trim() === "") continue;
    feed.push({ ...base, id: review.id, kind: "review", author: toActor(review.author), body: review.body, createdAt: review.createdAt, url: review.url, reviewState: review.state });
  }
  for (const thread of raw.reviewThreads.nodes) {
    const [first, ...replies] = thread.comments.nodes;
    if (first === undefined) continue;
    feed.push({
      ...base,
      id: thread.id,
      kind: "thread",
      author: toActor(first.author),
      body: first.body,
      createdAt: first.createdAt,
      url: first.url,
      path: thread.path,
      line: thread.line ?? thread.originalLine,
      side: thread.diffSide,
      diffHunk: first.diffHunk,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      replies: replies.map((reply) => ({ id: reply.id, author: toActor(reply.author), body: reply.body, createdAt: reply.createdAt, url: reply.url })),
    });
  }
  feed.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    id: raw.id,
    key,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    body: raw.body,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    repository: raw.repository.nameWithOwner,
    reviewDecision: raw.reviewDecision,
    checks: raw.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    author: toActor(raw.author),
    labels: raw.labels.nodes,
    reviewers: [...reviewers.values()],
    feed,
  };
}
