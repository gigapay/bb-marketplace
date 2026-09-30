import assert from "node:assert/strict";
import { test } from "node:test";
import { triageIssue, type TriageContext, type TriageIssue } from "./engine.ts";

const context: TriageContext = {
  labels: ["Bug", "Improvement", "Feature", "Backend", "Frontend", "Security"].map((name) => ({ id: `lbl_${name}`, name })),
  projects: [{ id: "prj_1", name: "Rebranding", description: "New brand rollout" }],
  guidelines: "",
};

const issue = (overrides: Partial<TriageIssue> = {}): TriageIssue => ({
  id: "iss_1",
  identifier: "GIG-1",
  title: "Payouts fail",
  description: "Since this morning payouts fail with 500.",
  priority: 0,
  priorityLabel: "No priority",
  state: "Backlog",
  labels: [],
  project: null,
  comments: [],
  ...overrides,
});

function fakeJev(answers: Record<string, unknown>) {
  const requests: any[] = [];
  return {
    requests,
    client: { systemOne: async (request: any) => (requests.push(request), { answers: answers as any }) },
  };
}

test("proposes confident changes and pre-checks only the very confident ones", async () => {
  const { client } = fakeJev({
    priority: { type: "choice", choice: "urgent", confidence: 0.92 },
    type: { type: "choice", choice: "Bug", confidence: 0.7 },
    area_Backend: { type: "noul", noul: 0.95 },
    area_Frontend: { type: "noul", noul: 0.2 },
    area_Security: { type: "noul", noul: 0.75 },
    project: { type: "choice", choice: "none", confidence: 0.9 },
    ready: { type: "noul", noul: 0.8 },
  });
  const proposal = await triageIssue(client, issue(), context);
  const summary = proposal.changes.map((c) => [c.kind, c.label, c.preselected]);
  assert.deepEqual(summary, [
    ["priority", "Urgent", true],
    ["label", "Bug", false],
    ["label", "Backend", true],
    ["label", "Security", false],
  ]);
  assert.equal(proposal.needsInfo, false);
});

test("skips questions whose answer is already on the issue", async () => {
  const { client, requests } = fakeJev({ priority: { type: "choice", choice: "high", confidence: 0.9 }, ready: { type: "noul", noul: 0.2 } });
  const proposal = await triageIssue(
    client,
    issue({ priority: 2, priorityLabel: "High", labels: [{ id: "lbl_Bug", name: "Bug" }, { id: "lbl_Backend", name: "Backend" }], project: { id: "p", name: "X" } }),
    context,
  );
  const asked = Object.keys(requests[0].questions).sort();
  assert.deepEqual(asked, ["area_Frontend", "area_Security", "priority", "ready"]);
  assert.equal(proposal.changes.length, 0, "same priority is not a change");
  assert.equal(proposal.needsInfo, true);
});

test("only asks about labels that exist in the workspace", async () => {
  const { client, requests } = fakeJev({ ready: { type: "noul", noul: 1 } });
  await triageIssue(client, issue(), { ...context, labels: [{ id: "lbl_Frontend", name: "frontend" }] });
  const asked = Object.keys(requests[0].questions).sort();
  assert.deepEqual(asked, ["area_Frontend", "priority", "project", "ready"]);
});

test("maps a project choice back to the project", async () => {
  const { client } = fakeJev({ project: { type: "choice", choice: "project_0", confidence: 0.9 } });
  const proposal = await triageIssue(client, issue(), context);
  assert.deepEqual(proposal.changes.map((c) => c.kind === "project" && c.projectId), ["prj_1"]);
});
