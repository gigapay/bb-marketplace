// Pure helpers shared by server.ts and the frontend, so the CLI and the UI
// agree on how a branch maps to an issue.

/** Realtime channel: a thread link changed, refetch `links_list`. */
export const LINKS_CHANGED = "links-changed";

export const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

export type LinkSource = "spawn" | "manual" | "branch";

/**
 * Finds the first `<team-key>-<number>` in a branch name whose key belongs to
 * one of the workspace's teams, e.g. `yoann/gig-123-fix-login` → `GIG-123`.
 * Requiring a known team key keeps `release-2-1` or `v1-2` from matching.
 */
export function issueIdentifierFromBranch(
  branchName: string | null | undefined,
  teamKeys: ReadonlySet<string>,
): string | null {
  if (!branchName) return null;
  for (const match of branchName.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![0-9])/g)) {
    const key = match[1]!.toUpperCase();
    if (teamKeys.has(key)) return `${key}-${Number(match[2])}`;
  }
  return null;
}

/** A stored row wins over the branch, including a stored "unlinked" (null). */
export function resolveLink(
  stored: { identifier: string | null; source: "spawn" | "manual" } | undefined,
  branchName: string | null | undefined,
  teamKeys: ReadonlySet<string>,
): { identifier: string; source: LinkSource } | null {
  if (stored !== undefined) {
    return stored.identifier === null ? null : { identifier: stored.identifier, source: stored.source };
  }
  const fromBranch = issueIdentifierFromBranch(branchName, teamKeys);
  return fromBranch === null ? null : { identifier: fromBranch, source: "branch" };
}
