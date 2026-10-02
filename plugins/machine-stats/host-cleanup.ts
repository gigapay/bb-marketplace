// Tells which staging slugs are finished: their Linear ticket is done and
// every pull request for it is merged. Runs on the slug's machine, where `gh`
// is logged in and the `bb linear` command (Linear Issues plugin) is reachable.
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { CleanupStatus, PullRequest } from "./contract.js";
import { listStacks } from "./host-stacks.js";

const run = promisify(execFile);
const CALL_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
// gig-5697 -> GIG-5697. Slugs like email-edit-debug carry no ticket.
const TICKET_SLUG = /^([a-z]+)-(\d+)$/;

type LinearIssue = {
  identifier: string;
  url: string;
  branchName?: string | null;
  state: { name: string; type: string };
};

function errorMessage(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim().split("\n")[0] ?? "";
  return cause instanceof Error ? cause.message : String(cause);
}

async function linearIssue(identifier: string, signal: AbortSignal): Promise<LinearIssue> {
  // The host daemon's bb binary; a bare `bb` re-execs to it anyway.
  const bb = process.env.BB_CLI ?? "bb";
  const { stdout } = await run(bb, ["linear", "show", identifier, "--json"], {
    timeout: CALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return JSON.parse(stdout) as LinearIssue;
}

async function pullRequests(
  repo: string,
  slug: string,
  issue: LinearIssue,
  signal: AbortSignal,
): Promise<PullRequest[]> {
  const { stdout } = await run(
    "gh",
    [
      "pr", "list",
      "--repo", repo,
      "--state", "all",
      "--search", slug,
      "--json", "number,state,headRefName,title,url",
      "--limit", "20",
    ],
    { timeout: CALL_TIMEOUT_MS, signal },
  );
  const rows = JSON.parse(stdout) as Array<{
    number: number;
    state: PullRequest["state"];
    headRefName: string;
    title: string;
    url: string;
  }>;
  // Search is fuzzy (bodies mentioning the ticket match too), so keep only
  // PRs whose branch or title names the ticket.
  const branch = issue.branchName?.toLowerCase() ?? null;
  return rows
    .filter(
      (pr) =>
        pr.headRefName.toLowerCase().includes(slug) ||
        pr.headRefName.toLowerCase() === branch ||
        pr.title.toUpperCase().includes(issue.identifier),
    )
    .map((pr) => ({ repo, number: pr.number, state: pr.state, url: pr.url }));
}

async function statusOf(
  slug: string,
  repos: string[],
  workingDir: string | null,
  signal: AbortSignal,
): Promise<CleanupStatus> {
  const worktreeMissing =
    workingDir !== null && (await access(workingDir).then(() => false, () => true));
  const base = { slug, issue: null, pullRequests: [], worktreeMissing };
  const match = TICKET_SLUG.exec(slug);
  if (match === null) return { ...base, verdict: "unknown", reason: "No Linear ticket in the slug." };
  const identifier = `${match[1]?.toUpperCase()}-${match[2]}`;

  let issue: LinearIssue;
  try {
    issue = await linearIssue(identifier, signal);
  } catch (cause) {
    if (signal.aborted) throw cause;
    return { ...base, verdict: "unknown", reason: `Linear lookup failed: ${errorMessage(cause)}` };
  }
  const issueSummary = {
    identifier: issue.identifier,
    state: issue.state.name,
    stateType: issue.state.type,
    url: issue.url,
  };

  let prs: PullRequest[];
  try {
    prs = (await Promise.all(repos.map((repo) => pullRequests(repo, slug, issue, signal)))).flat();
  } catch (cause) {
    if (signal.aborted) throw cause;
    return {
      ...base,
      issue: issueSummary,
      verdict: "unknown",
      reason: `GitHub lookup failed: ${errorMessage(cause)}`,
    };
  }

  const finished = issue.state.type === "completed" || issue.state.type === "canceled";
  const open = prs.filter((pr) => pr.state === "OPEN");
  const merged = prs.filter((pr) => pr.state === "MERGED");
  const prLabel = (pr: PullRequest) => `${pr.repo.split("/").at(-1)}#${pr.number}`;
  let verdict: CleanupStatus["verdict"] = "active";
  let reason: string;
  if (!finished) {
    reason = `${issue.identifier} is ${issue.state.name}.`;
  } else if (open.length > 0) {
    reason = `${issue.identifier} is ${issue.state.name} but ${open.map(prLabel).join(", ")} is still open.`;
  } else if (issue.state.type === "completed" && merged.length === 0) {
    reason = `${issue.identifier} is ${issue.state.name} but no merged PR was found.`;
  } else {
    verdict = "ready";
    reason = [
      `${issue.identifier} is ${issue.state.name}`,
      merged.length > 0 ? `${merged.map(prLabel).join(", ")} merged` : null,
    ]
      .filter(Boolean)
      .join(", ") + ".";
  }
  return { ...base, issue: issueSummary, pullRequests: prs, verdict, reason };
}

export async function cleanupStatus(
  slugs: string[],
  repos: string[],
  signal: AbortSignal,
): Promise<CleanupStatus[]> {
  const listing = await listStacks(signal);
  const workingDirs = new Map(
    listing.stacks.filter((s) => s.kind === "staging").map((s) => [s.id, s.workingDir]),
  );
  const results: CleanupStatus[] = [];
  const queue = [...slugs];
  // A handful at a time: each slug costs one bb and one gh call per repo.
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
        results.push(await statusOf(slug, repos, workingDirs.get(slug) ?? null, signal));
      }
    }),
  );
  return results.sort((a, b) => a.slug.localeCompare(b.slug));
}
