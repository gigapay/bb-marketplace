import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpdateContext, parseDraft } from "./draft.ts";

test("parses the agent's block, and tolerates drift", () => {
  assert.deepEqual(parseDraft("Sure!\n<project-update>\nhealth: atRisk\n---\nWe shipped **X**.\n</project-update>\nThanks"), {
    health: "atRisk",
    body: "We shipped **X**.",
  });
  assert.deepEqual(parseDraft("health: onTrack\n\nAll good this week."), { health: "onTrack", body: "All good this week." });
  assert.deepEqual(parseDraft("Just prose, no health."), { health: null, body: "Just prose, no health." });
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft("<project-update>\nhealth: onTrack\n---\n</project-update>"), null);
});

test("context splits activity since the last update and flags overdue milestones", () => {
  const now = Date.parse("2026-09-30T12:00:00Z");
  const issue = (id: string, extra: Record<string, unknown>) => ({
    identifier: id, title: id, priorityLabel: "Medium", state: { name: "Todo", type: "unstarted" },
    completedAt: null, startedAt: null, createdAt: "2026-08-01T00:00:00Z", canceledAt: null,
    assignee: null, projectMilestone: null, ...extra,
  });
  const context = buildUpdateContext(
    {
      name: "P", description: "", health: "onTrack", progress: 0.5, startDate: null, targetDate: "2026-10-30", url: "u",
      status: { name: "In Progress" },
      projectMilestones: { nodes: [
        { name: "Late", progress: 40, targetDate: "2026-09-01" },
        { name: "Done", progress: 100, targetDate: "2026-09-01" },
      ] },
      projectUpdates: { nodes: [{ body: "old", health: "onTrack", createdAt: "2026-09-20T00:00:00Z" }] },
      issues: { nodes: [
        issue("A", { state: { name: "Done", type: "completed" }, completedAt: "2026-09-25T00:00:00Z" }),
        issue("B", { state: { name: "Done", type: "completed" }, completedAt: "2026-09-10T00:00:00Z" }),
        issue("C", { state: { name: "Blocked", type: "started" }, startedAt: "2026-09-22T00:00:00Z" }),
        issue("D", { createdAt: "2026-09-28T00:00:00Z" }),
      ] },
    },
    now,
  );
  assert.deepEqual(context.completed_in_period.map((i) => i.id), ["A"]);
  assert.deepEqual(context.started_in_period.map((i) => i.id), ["C"]);
  assert.deepEqual(context.added_in_period.map((i) => i.id), ["D"]);
  assert.deepEqual(context.blocked.map((i) => i.id), ["C"]);
  assert.deepEqual(context.milestones.map((m) => m.overdue), [true, false]);
  assert.equal(context.project.days_to_target, 30);
  assert.equal(context.period.since, "2026-09-20");
});
