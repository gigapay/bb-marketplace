// Pure helpers shared by server.ts and the frontend, so the CLI and the UI
// agree on how a branch maps to an issue.

/** Realtime channel: a thread link changed, refetch `links_list`. */
export const LINKS_CHANGED = "links-changed";

export const IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

/**
 * Line the seeded prompt carries so the server's dispatch hook can link the
 * new thread, whichever composer sent it. Same wording Orca uses.
 */
export const LINKED_ISSUE_PREFIX = "Linked Linear issue: ";

export function linkedIssueFromPrompt(text: string): string | null {
  const match = /^Linked Linear issue: ([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})\s*$/m.exec(text);
  return match ? match[1]!.toUpperCase() : null;
}

export type LinkSource = "spawn" | "manual" | "branch" | "environment";

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

type StoredRow = { identifier: string | null; source: "spawn" | "manual" };

/**
 * Resolves every thread at once so threads sharing a worktree can inherit its
 * ticket: a thread with no link of its own takes the environment's issue when
 * all linked threads there agree on one. An explicit unlink still wins.
 */
export function resolveThreadLinks(
  threads: readonly { id: string; environmentId: string | null; branchName: string | null | undefined }[],
  rows: ReadonlyMap<string, StoredRow>,
  teamKeys: ReadonlySet<string>,
): Map<string, { identifier: string; source: LinkSource }> {
  const links = new Map<string, { identifier: string; source: LinkSource }>();
  const byEnvironment = new Map<string, Set<string>>();
  for (const thread of threads) {
    const link = resolveLink(rows.get(thread.id), thread.branchName, teamKeys);
    if (link === null) continue;
    links.set(thread.id, link);
    if (thread.environmentId !== null) {
      const identifiers = byEnvironment.get(thread.environmentId) ?? new Set<string>();
      identifiers.add(link.identifier);
      byEnvironment.set(thread.environmentId, identifiers);
    }
  }
  for (const thread of threads) {
    if (links.has(thread.id) || rows.has(thread.id) || thread.environmentId === null) continue;
    const identifiers = byEnvironment.get(thread.environmentId);
    if (identifiers?.size === 1) {
      links.set(thread.id, { identifier: [...identifiers][0]!, source: "environment" });
    }
  }
  return links;
}
