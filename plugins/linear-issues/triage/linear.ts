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
      id identifier title description priority priorityLabel
      team { id } state { name } project { id name }
      labels(first: 50) { nodes { id name } }
      comments(first: 5, orderBy: createdAt) { nodes { body } }
    }
  }
}`;

const TRIAGE_CONTEXT_QUERY = `query TriageContext($teamId: String!) {
  team(id: $teamId) {
    labels(first: 250) { nodes { id name retiredAt isGroup } }
    projects(first: 100) { nodes { id name description status { type } } }
  }
  issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name retiredAt isGroup } }
}`;

const ISSUE_UPDATE_MUTATION = `mutation TriageUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

type RawIssue = Omit<TriageIssue, "labels" | "comments" | "state"> & {
  team: { id: string };
  state: { name: string };
  labels: { nodes: { id: string; name: string }[] };
  comments: { nodes: { body: string }[] };
};

type RawLabel = { id: string; name: string; retiredAt: string | null; isGroup: boolean };

export async function loadTriageIssues(linear: Linear, ids: string[]) {
  const data = await linear<{ issues: { nodes: RawIssue[] } }>(TRIAGE_ISSUES_QUERY, { ids });
  return data.issues.nodes.map((raw) => ({
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
    } satisfies TriageIssue,
  }));
}

export async function loadTriageContext(linear: Linear, teamId: string, guidelines: string): Promise<TriageContext> {
  const data = await linear<{
    team: { labels: { nodes: RawLabel[] }; projects: { nodes: { id: string; name: string; description: string | null; status: { type: string } | null }[] } } | null;
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
  };
}

export async function applyIssueUpdate(
  linear: Linear,
  issueId: string,
  update: { priority?: number; addedLabelIds?: string[]; projectId?: string },
): Promise<void> {
  const data = await linear<{ issueUpdate: { success: boolean } }>(ISSUE_UPDATE_MUTATION, { id: issueId, input: update });
  if (!data.issueUpdate.success) throw new Error("Linear didn't accept the update");
}
