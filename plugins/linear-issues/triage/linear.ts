// Linear reads and writes for triage. Kept apart from server.ts so the
// triage feature can be read (and removed) as one unit.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { JEV_MODEL } from "./criteria.js";
import type { JevClient, TriageContext, TriageIssue } from "./engine.js";

type Linear = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

const OPENROUTER_BASE = "https://openrouter.ai";
const OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";

/**
 * TypeSafe's SDK against OpenRouter: same System One body and answers, only
 * the path differs, so a small fetch shim maps `/v1/systemone` onto it.
 */
export function openRouterJev(apiKey: string): JevClient {
  return new TypeSafeClient({
    apiKey,
    baseURL: OPENROUTER_BASE,
    defaultModel: JEV_MODEL,
    timeout: 20_000,
    fetch: (input, init) => {
      const url = input.endsWith("/v1/systemone") ? OPENROUTER_DECISIONS : input;
      const headers = new Headers(init?.headers);
      headers.set("HTTP-Referer", "https://github.com/yteruel31/bb-marketplace");
      headers.set("X-OpenRouter-Title", "BB Linear Issues triage");
      return fetch(url, { ...init, headers });
    },
  });
}

const TRIAGE_ISSUES_QUERY = `query TriageIssues($ids: [ID!]) {
  issues(first: 50, filter: { id: { in: $ids } }) {
    nodes {
      id identifier title description priority priorityLabel createdAt updatedAt
      team { id } state { name type } project { id name }
      cycle { isActive }
      creator { name }
      labels(first: 50) { nodes { id name } }
      attachments(first: 20) { nodes { sourceType } }
      comments(first: 20, orderBy: createdAt) { nodes { body createdAt } }
    }
  }
}`;

const TRIAGE_CONTEXT_QUERY = `query TriageContext($teamId: String!) {
  team(id: $teamId) {
    labels(first: 250) { nodes { id name color retiredAt isGroup } }
    states(first: 50) { nodes { id type position } }
    projects(first: 100) { nodes { id name description status { type } } }
  }
  issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name color retiredAt isGroup } }
}`;

const ISSUE_UPDATE_MUTATION = `mutation TriageUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

type RawIssue = Pick<TriageIssue, "id" | "identifier" | "title" | "description" | "priority" | "priorityLabel" | "project"> & {
  createdAt: string;
  updatedAt: string;
  team: { id: string };
  state: { name: string; type: string };
  cycle: { isActive: boolean } | null;
  creator: { name: string } | null;
  labels: { nodes: { id: string; name: string }[] };
  attachments: { nodes: { sourceType: string | null }[] };
  comments: { nodes: { body: string; createdAt: string }[] };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATE_TYPES = new Set(["backlog", "unstarted", "triage"]);

/**
 * The deterministic half of stale detection: open, quiet for long enough,
 * not planned into an active cycle, nobody working on it in BB, no PR.
 * Jev only weighs in on issues that pass this.
 */
export function isStaleCandidate(raw: RawIssue, daysInactive: number, options: { staleAfterDays: number; linked: boolean }): boolean {
  return (
    OPEN_STATE_TYPES.has(raw.state.type) &&
    daysInactive >= options.staleAfterDays &&
    raw.priority !== 1 &&
    raw.cycle?.isActive !== true &&
    !options.linked &&
    !raw.attachments.nodes.some((attachment) => /github|gitlab/i.test(attachment.sourceType ?? ""))
  );
}

type RawLabel = { id: string; name: string; color: string; retiredAt: string | null; isGroup: boolean };

export async function loadTriageIssues(
  linear: Linear,
  ids: string[],
  options: { staleAfterDays: number; linkedIssueIds: ReadonlySet<string>; now?: number },
) {
  const data = await linear<{ issues: { nodes: RawIssue[] } }>(TRIAGE_ISSUES_QUERY, { ids });
  const now = options.now ?? Date.now();
  return data.issues.nodes.map((raw) => {
    const lastActivity = Math.max(
      Date.parse(raw.updatedAt),
      ...raw.comments.nodes.map((comment) => Date.parse(comment.createdAt)),
    );
    const daysInactive = Math.floor((now - lastActivity) / DAY_MS);
    return {
    teamId: raw.team.id,
    issue: {
      id: raw.id,
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description,
      priority: raw.priority,
      priorityLabel: raw.priorityLabel,
      state: raw.state.name,
      project: raw.project,
      labels: raw.labels.nodes,
      comments: raw.comments.nodes.map((comment) => comment.body),
      creatorName: raw.creator?.name ?? null,
      daysInactive,
      staleCandidate: isStaleCandidate(raw, daysInactive, {
        staleAfterDays: options.staleAfterDays,
        linked: options.linkedIssueIds.has(raw.id),
      }),
    } satisfies TriageIssue,
    };
  });
}

export async function loadTriageContext(linear: Linear, teamId: string, guidelines: string): Promise<TriageContext> {
  const data = await linear<{
    team: { labels: { nodes: RawLabel[] }; states: { nodes: { id: string; type: string; position: number }[] }; projects: { nodes: { id: string; name: string; description: string | null; status: { type: string } | null }[] } } | null;
    issueLabels: { nodes: RawLabel[] };
  }>(TRIAGE_CONTEXT_QUERY, { teamId });
  // Labels a ticket can actually carry: not group headers, not retired.
  const usable = (label: RawLabel) => !label.isGroup && label.retiredAt === null;
  return {
    labels: [...(data.team?.labels.nodes ?? []), ...data.issueLabels.nodes].filter(usable),
    projects: (data.team?.projects.nodes ?? [])
      .filter((project) => !["completed", "canceled"].includes(project.status?.type ?? ""))
      .map(({ id, name, description }) => ({ id, name, description })),
    guidelines,
    canceledStateId:
      (data.team?.states.nodes ?? []).filter((state) => state.type === "canceled").sort((a, b) => a.position - b.position)[0]?.id ?? null,
  };
}

export async function applyIssueUpdate(
  linear: Linear,
  issueId: string,
  update: { priority?: number; addedLabelIds?: string[]; projectId?: string; stateId?: string },
): Promise<void> {
  const data = await linear<{ issueUpdate: { success: boolean } }>(ISSUE_UPDATE_MUTATION, { id: issueId, input: update });
  if (!data.issueUpdate.success) throw new Error("Linear didn't accept the update");
}
