// Check runs and commit statuses on a PR's head commit. GitHub has no push
// channel for API clients (webhooks need a public URL and repo admin), so the
// UI polls this; one call costs a single GraphQL point.
import { z } from "zod";

export const checkSchema = z.object({
  id: z.string(),
  name: z.string(),
  workflow: z.string().nullable(),
  // Collapsed from CheckRun status/conclusion and StatusContext state.
  state: z.enum(["queued", "running", "success", "failure", "skipped", "neutral", "cancelled"]),
  isRequired: z.boolean(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Check = z.infer<typeof checkSchema>;

export const prChecksSchema = z.object({
  headSha: z.string(),
  rollup: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]).nullable(),
  checks: z.array(checkSchema),
  fetchedAt: z.number(),
});
export type PrChecks = z.infer<typeof prChecksSchema>;

export const PR_CHECKS_QUERY = `query Checks($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    headRefOid
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber: $number)
        checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { id context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
    } } } } } }
  } }
}`;

type RawContext =
  | {
      __typename: "CheckRun";
      id: string;
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      startedAt: string | null;
      completedAt: string | null;
      isRequired: boolean;
      checkSuite: { workflowRun: { workflow: { name: string } } | null } | null;
    }
  | {
      __typename: "StatusContext";
      id: string;
      context: string;
      state: string;
      targetUrl: string | null;
      createdAt: string;
      isRequired: boolean;
    };

export type RawPrChecks = {
  headRefOid: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: PrChecks["rollup"]; contexts: { nodes: RawContext[] } } | null } }[] };
};

function checkRunState(status: string, conclusion: string | null): Check["state"] {
  if (status !== "COMPLETED") return status === "IN_PROGRESS" ? "running" : "queued";
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "SKIPPED":
      return "skipped";
    case "NEUTRAL":
      return "neutral";
    case "CANCELLED":
    case "STALE":
      return "cancelled";
    default:
      return "failure";
  }
}

function statusState(state: string): Check["state"] {
  if (state === "SUCCESS") return "success";
  if (state === "PENDING" || state === "EXPECTED") return "running";
  return "failure";
}

export function normalizeChecks(raw: RawPrChecks, fetchedAt: number): PrChecks {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const checks = (rollup?.contexts.nodes ?? []).map((node): Check =>
    node.__typename === "CheckRun"
      ? {
          id: node.id,
          name: node.name,
          workflow: node.checkSuite?.workflowRun?.workflow.name ?? null,
          state: checkRunState(node.status, node.conclusion),
          isRequired: node.isRequired,
          url: node.detailsUrl,
          startedAt: node.startedAt,
          completedAt: node.completedAt,
        }
      : {
          id: node.id,
          name: node.context,
          workflow: null,
          state: statusState(node.state),
          isRequired: node.isRequired,
          url: node.targetUrl,
          startedAt: node.createdAt,
          completedAt: null,
        },
  );
  return { headSha: raw.headRefOid, rollup: rollup?.state ?? null, checks, fetchedAt };
}
