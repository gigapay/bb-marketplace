import assert from "node:assert/strict";
import { test } from "node:test";
import { triageIssue, type TriageContext, type TriageIssue } from "./engine.ts";

const context: TriageContext = {
  labels: ["Bug", "Improvement", "Feature", "Backend", "Frontend", "Security"].map((name) => ({ id: `lbl_${name}`, name })),
  projects: [{ id: "prj_1", name: "Rebranding", description: "New brand rollout" }],
  guidelines: "",
  canceledStateId: "st_canceled",
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
  creatorName: "Giang Ngo",
  daysInactive: 3,
  staleCandidate: false,
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
  const asked = Object.keys(requests[0].questions).filter((key) => !key.startsWith("gap_")).sort();
  assert.deepEqual(asked, ["area_Frontend", "area_Security", "priority", "ready"]);
  assert.equal(proposal.changes.length, 0, "same priority is not a change");
  assert.equal(proposal.needsInfo, true);
});

test("only asks about labels that exist in the workspace", async () => {
  const { client, requests } = fakeJev({ ready: { type: "noul", noul: 1 } });
  await triageIssue(client, issue(), { ...context, labels: [{ id: "lbl_Frontend", name: "frontend" }] });
  const asked = Object.keys(requests[0].questions).filter((key) => !key.startsWith("gap_")).sort();
  assert.deepEqual(asked, ["area_Frontend", "priority", "project", "ready"]);
});

test("maps a project choice back to the project", async () => {
  const { client } = fakeJev({ project: { type: "choice", choice: "project_0", confidence: 0.9 } });
  const proposal = await triageIssue(client, issue(), context);
  assert.deepEqual(proposal.changes.map((c) => c.kind === "project" && c.projectId), ["prj_1"]);
});

test("proposes cancelling a stale, optional, uncommitted ticket, never pre-checked", async () => {
  const { client, requests } = fakeJev({
    speculative: { type: "noul", noul: 0.9 },
    commitment: { type: "noul", noul: 0.1 },
    ready: { type: "noul", noul: 0.9 },
  });
  const proposal = await triageIssue(client, issue({ staleCandidate: true, daysInactive: 142 }), context);
  const cancel = proposal.changes.find((c) => c.kind === "cancel");
  assert.ok(cancel && cancel.kind === "cancel");
  assert.equal(cancel.stateId, "st_canceled");
  assert.equal(cancel.preselected, false);
  assert.match(cancel.comment, /142 days/);
  assert.ok("commitment" in requests[0].questions);
});

test("keeps a stale ticket that carries a commitment, and doesn't ask for fresh ones", async () => {
  const committed = fakeJev({ speculative: { type: "noul", noul: 0.9 }, commitment: { type: "noul", noul: 0.8 } });
  const kept = await triageIssue(committed.client, issue({ staleCandidate: true, daysInactive: 200 }), context);
  assert.equal(kept.changes.some((c) => c.kind === "cancel"), false);
  const fresh = fakeJev({});
  await triageIssue(fresh.client, issue(), context);
  assert.equal("commitment" in fresh.requests[0].questions, false);
});

test("asks for exactly the missing information, repro steps only for bugs", async () => {
  const { client } = fakeJev({
    ready: { type: "noul", noul: 0.2 },
    gap_goal: { type: "noul", noul: 0.9 },
    gap_expected: { type: "noul", noul: 0.1 },
    gap_acceptance: { type: "noul", noul: 0.2 },
    gap_repro: { type: "noul", noul: 0.05 },
    gap_design: { type: "noul", noul: 0.05 },
  });
  const notBug = await triageIssue(client, issue(), context);
  const comment = notBug.changes.find((c) => c.kind === "comment");
  assert.ok(comment && comment.kind === "comment");
  assert.deepEqual(comment.gaps, ["The expected behaviour or outcome", "Acceptance criteria (how we know it's done)"]);
  assert.match(comment.body, /^Hi Giang, to be able to pick this up/);
  const bug = await triageIssue(client, issue({ labels: [{ id: "lbl_Bug", name: "Bug" }] }), context);
  const bugComment = bug.changes.find((c) => c.kind === "comment");
  assert.ok(bugComment && bugComment.kind === "comment" && bugComment.gaps.some((g) => g.startsWith("Steps to reproduce")));
});
