import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaleCandidate } from "./linear.ts";

const raw = (overrides: Record<string, unknown> = {}) =>
  ({ priority: 3, state: { name: "Backlog", type: "backlog" }, cycle: null, attachments: { nodes: [] }, ...overrides }) as any;
const options = { staleAfterDays: 90, linked: false };

test("stale candidates are old, open, unplanned, unlinked and without a PR", () => {
  assert.equal(isStaleCandidate(raw(), 120, options), true);
  assert.equal(isStaleCandidate(raw(), 30, options), false, "too recent");
  assert.equal(isStaleCandidate(raw({ state: { name: "In Progress", type: "started" } }), 400, options), false, "being worked on");
  assert.equal(isStaleCandidate(raw({ cycle: { isActive: true } }), 400, options), false, "planned in the current cycle");
  assert.equal(isStaleCandidate(raw(), 400, { ...options, linked: true }), false, "has a BB thread");
  assert.equal(isStaleCandidate(raw({ attachments: { nodes: [{ sourceType: "github" }] } }), 400, options), false, "has a PR");
  assert.equal(isStaleCandidate(raw({ priority: 1 }), 400, options), false, "urgent is never auto-proposed");
});
