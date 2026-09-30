// Builds the GitHub search string for each pull request scope. Pure so it's
// covered by `npm test` without a token.

export const PR_SCOPES = ["review", "reviewed", "authored", "assigned", "involved"] as const;
export type PrScope = (typeof PR_SCOPES)[number];

const SCOPE_QUALIFIER: Record<PrScope, string> = {
  review: "review-requested:@me",
  // Your own PRs count your self-reviews, so leave them out.
  reviewed: "reviewed-by:@me -author:@me",
  authored: "author:@me",
  assigned: "assignee:@me",
  involved: "involves:@me",
};

export function buildPrSearch(scope: PrScope, includeClosed: boolean, query: string): string {
  const parts = ["is:pr", "archived:false", SCOPE_QUALIFIER[scope]];
  if (!includeClosed) parts.push("is:open");
  // Free text goes through as is, so qualifiers like repo:owner/name or
  // label:bug work from the search box.
  const extra = query.trim();
  if (extra !== "") parts.push(extra);
  parts.push("sort:updated-desc");
  return parts.join(" ");
}
