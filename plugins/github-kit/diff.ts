// A PR's changed files for the Diff tab, over all commits, since your last
// review, or for one commit, plus GitHub's per-file "Viewed" state.
import { z } from "zod";

export const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export const diffRangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("since-review") }).strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().regex(SHA_PATTERN) }).strict(),
]);
export type DiffRange = z.infer<typeof diffRangeSchema>;

export const diffFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  // null for binary files, and for patches GitHub or we cut for size.
  patch: z.string().nullable(),
  viewed: z.enum(["VIEWED", "UNVIEWED", "DISMISSED"]),
});
export type DiffFile = z.infer<typeof diffFileSchema>;

export const diffCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  message: z.string(),
  author: z.string(),
  committedAt: z.string(),
});
export type DiffCommit = z.infer<typeof diffCommitSchema>;

export const prDiffSchema = z.object({
  headSha: z.string(),
  // Commit of your latest review, when it's still in the PR history.
  lastReviewSha: z.string().nullable(),
  commits: z.array(diffCommitSchema),
  files: z.array(diffFileSchema),
  // True when GitHub's file list or our size budget cut something.
  truncated: z.boolean(),
  // Files touched since your latest review (full diff only), for the
  // "updated since review" marker.
  changedSinceReview: z.array(z.string()),
});
export type PrDiff = z.infer<typeof prDiffSchema>;

export const PR_DIFF_META_QUERY = `query DiffMeta($owner: String!, $name: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id headRefOid
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } }
    commits(first: 250) { nodes { commit { oid abbreviatedOid messageHeadline committedDate author { name user { login } } } } }
    reviews(last: 50) { nodes { author { login } commit { oid } } }
  } }
}`;

export type RawDiffMeta = {
  viewer: { login: string };
  repository: {
    pullRequest: {
      id: string;
      headRefOid: string;
      files: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { path: string; viewerViewedState: DiffFile["viewed"] }[] };
      commits: {
        nodes: {
          commit: {
            oid: string;
            abbreviatedOid: string;
            messageHeadline: string;
            committedDate: string;
            author: { name: string | null; user: { login: string } | null } | null;
          };
        }[];
      };
      reviews: { nodes: { author: { login: string } | null; commit: { oid: string } | null }[] };
    } | null;
  } | null;
};

export type RestFile = {
  filename: string;
  previous_filename?: string;
  status: DiffFile["status"];
  additions: number;
  deletions: number;
  patch?: string;
};

// Keeps one RPC answer bounded; a file past the budget shows "too large".
export const PATCH_BUDGET_CHARS = 4_000_000;

export function toDiffFiles(files: RestFile[], viewed: Map<string, DiffFile["viewed"]>): { files: DiffFile[]; cut: boolean } {
  let budget = PATCH_BUDGET_CHARS;
  let cut = false;
  const result = files.map((file): DiffFile => {
    let patch = file.patch ?? null;
    if (patch !== null && patch.length > budget) {
      patch = null;
      cut = true;
    } else if (patch !== null) {
      budget -= patch.length;
    }
    return {
      path: file.filename,
      previousPath: file.previous_filename ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch,
      viewed: viewed.get(file.filename) ?? "UNVIEWED",
    };
  });
  return { files: result, cut };
}

export type FileGroup = "Implementation" | "Tests" | "Documentation";

// Same buckets as Linear's PR review: tests and docs apart from the code.
export function fileGroup(path: string): FileGroup {
  const lower = path.toLowerCase();
  if (/\.(md|mdx|rst|txt|adoc)$/.test(lower) || /(^|\/)docs?\//.test(lower)) return "Documentation";
  if (
    /(^|\/)(__tests__|tests?|spec|e2e|playwright|cypress|__mocks__|fixtures)\//.test(lower) ||
    /\.(test|spec|e2e)\.[a-z0-9]+$/.test(lower)
  ) {
    return "Tests";
  }
  return "Implementation";
}
