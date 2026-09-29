import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeChecks } from "../checks.ts";

const run = (status: string, conclusion: string | null) => ({
  __typename: "CheckRun" as const,
  id: `${status}-${conclusion}`,
  name: "job",
  status,
  conclusion,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  isRequired: false,
  checkSuite: { workflowRun: { workflow: { name: "CI" } } },
});

test("check runs and statuses collapse into one state", () => {
  const result = normalizeChecks(
    {
      headRefOid: "abc",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "PENDING",
                contexts: {
                  nodes: [
                    run("IN_PROGRESS", null),
                    run("QUEUED", null),
                    run("COMPLETED", "SUCCESS"),
                    run("COMPLETED", "TIMED_OUT"),
                    run("COMPLETED", "SKIPPED"),
                    { __typename: "StatusContext", id: "s", context: "ci/legacy", state: "PENDING", targetUrl: null, createdAt: "", isRequired: true },
                  ],
                },
              },
            },
          },
        ],
      },
    },
    0,
  );
  assert.deepEqual(
    result.checks.map((check) => check.state),
    ["running", "queued", "success", "failure", "skipped", "running"],
  );
  assert.equal(result.checks[0]!.workflow, "CI");
  assert.equal(result.rollup, "PENDING");
});

test("a commit without checks has an empty list", () => {
  const result = normalizeChecks({ headRefOid: "abc", commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }, 0);
  assert.deepEqual(result.checks, []);
  assert.equal(result.rollup, null);
});
