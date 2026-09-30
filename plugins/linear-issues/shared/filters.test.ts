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
