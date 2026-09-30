import assert from "node:assert/strict";
import { test } from "node:test";
import { triageProject, type ProjectTriageInput } from "./projects.ts";

const now = Date.parse("2026-09-30T12:00:00Z");
const statuses = [
  { id: "st_done", name: "Completed", type: "completed", position: 1 },
  { id: "st_pause", name: "Paused", type: "paused", position: 2 },
  { id: "st_cancel", name: "Canceled", type: "canceled", position: 3 },
];
const project = (overrides: Partial<ProjectTriageInput> = {}): ProjectTriageInput => ({
  id: "p", name: "P", description: "Goal, scope, success.", content: null, health: "onTrack", progress: 0.5,
  startDate: "2026-09-01", targetDate: "2026-10-31", statusType: "started", lead: "Yoann", updateEveryWeeks: 1,
  lastUpdate: { createdAt: "2026-09-28T00:00:00Z", body: "fine", health: "onTrack" },
  milestones: [], openIssues: 5, totalIssues: 10, lastIssueActivity: "2026-09-29T00:00:00Z", ...overrides,
});
const jev = (answers: Record<string, unknown> = {}) => {
  const requests: any[] = [];
  return { requests, client: { systemOne: async (r: any) => (requests.push(r), { answers: answers as any }) } };
};

test("a healthy project raises nothing", async () => {
  const { client } = jev({ health: { type: "choice", choice: "onTrack", confidence: 0.9 }, description: { type: "noul", noul: 0.9 } });
  const result = await triageProject(client, project(), { statuses, staleAfterDays: 90, now });
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.changes, []);
});

test("code flags cadence, deadline, ownership; Jev questions health and description", async () => {
  const { client } = jev({ health: { type: "choice", choice: "offTrack", confidence: 0.85 }, description: { type: "noul", noul: 0.1 } });
  const result = await triageProject(
    client,
    project({ lead: null, targetDate: "2026-09-20", lastUpdate: { createdAt: "2026-09-01T00:00:00Z", body: "", health: "onTrack" } }),
    { statuses, staleAfterDays: 90, now },
  );
  assert.deepEqual(result.flags.map((f) => f.kind).sort(), ["health", "no-lead", "overdue", "thin-description", "update-due"]);
});

test("flags a project behind schedule", async () => {
  const { client } = jev();
  const result = await triageProject(client, project({ progress: 0.1, startDate: "2026-08-01", targetDate: "2026-10-31" }), { statuses, staleAfterDays: 90, now });
  assert.ok(result.flags.some((f) => f.kind === "behind"));
});

test("proposes Completed when every issue is done, never pre-checked", async () => {
  const { client } = jev();
  const result = await triageProject(client, project({ openIssues: 0, totalIssues: 7 }), { statuses, staleAfterDays: 90, now });
  assert.deepEqual(result.changes.map((c) => [c.statusId, c.preselected]), [["st_done", false]]);
});

test("inactive projects: pause the committed ones, cancel the optional ones", async () => {
  const quiet = project({ lastIssueActivity: "2026-05-01T00:00:00Z" });
  const committed = jev({ optional: { type: "noul", noul: 0.3 }, commitment: { type: "noul", noul: 0.8 } });
  assert.equal((await triageProject(committed.client, quiet, { statuses, staleAfterDays: 90, now })).changes[0]?.statusId, "st_pause");
  const optional = jev({ optional: { type: "noul", noul: 0.9 }, commitment: { type: "noul", noul: 0.1 } });
  assert.equal((await triageProject(optional.client, quiet, { statuses, staleAfterDays: 90, now })).changes[0]?.statusId, "st_cancel");
  const fresh = jev();
  await triageProject(fresh.client, project(), { statuses, staleAfterDays: 90, now });
  assert.equal("optional" in fresh.requests[0].questions, false, "active projects aren't asked");
});
