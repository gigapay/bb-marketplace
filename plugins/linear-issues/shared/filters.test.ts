import assert from "node:assert/strict";
import { test } from "node:test";
import { issueFilterClauses } from "../projects.ts";

test("filters combine as AND across kinds and OR within one", () => {
  assert.deepEqual(issueFilterClauses({ labelIds: [], priorities: [], projectIds: [] }), []);
  assert.deepEqual(issueFilterClauses({ labelIds: ["a", "b"], priorities: [1, 2], projectIds: ["p"] }), [
    { labels: { some: { id: { in: ["a", "b"] } } } },
    { priority: { in: [1, 2] } },
    { project: { id: { in: ["p"] } } },
  ]);
});

test("'none' selects issues without a project, alone or with others", () => {
  assert.deepEqual(issueFilterClauses({ labelIds: [], priorities: [], projectIds: ["none"] }), [{ project: { null: true } }]);
  assert.deepEqual(issueFilterClauses({ labelIds: [], priorities: [], projectIds: ["p", "none"] }), [
    { or: [{ project: { id: { in: ["p"] } } }, { project: { null: true } }] },
  ]);
});

test("milestone progress (percent) is normalized like project progress (fraction)", async () => {
  const { flattenProjectDetail } = await import("../projects.ts");
  const detail = flattenProjectDetail({
    id: "p", name: "P", description: "", icon: null, color: "#000", url: "u", status: null, health: null,
    progress: 0.35, startDate: null, targetDate: null, updatedAt: "", lead: null, teams: { nodes: [] },
    content: null, members: { nodes: [] }, projectUpdates: { nodes: [] },
    projectMilestones: { nodes: [
      { id: "a", name: "A", targetDate: null, progress: 84.62, sortOrder: 1 },
      { id: "b", name: "B", targetDate: null, progress: 0, sortOrder: 2 },
    ] },
  } as any);
  assert.equal(detail.progress, 0.35);
  assert.deepEqual(detail.milestones.map((m) => m.progress), [0.8462, 0]);
});
