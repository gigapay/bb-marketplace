import assert from "node:assert/strict";
import { test } from "node:test";
import { groupCommentThreads } from "./comments.ts";

const c = (id: string, createdAt: string, parentId: string | null = null, resolvedAt: string | null = null) => ({
  id,
  createdAt,
  parentId,
  resolvedAt,
});

test("groups replies under their root, oldest first", () => {
  const threads = groupCommentThreads([
    c("r2", "2026-01-03"),
    c("a2", "2026-01-04", "r1"),
    c("r1", "2026-01-01"),
    c("a1", "2026-01-02", "r1"),
  ]);
  assert.deepEqual(
    threads.map((t) => [t.root.id, t.replies.map((r) => r.id)]),
    [
      ["r1", ["a1", "a2"]],
      ["r2", []],
    ],
  );
});

test("marks resolved discussions and keeps orphan replies visible", () => {
  const threads = groupCommentThreads([c("r1", "2026-01-01", null, "2026-01-05"), c("x", "2026-01-02", "gone")]);
  assert.equal(threads[0]!.resolved, true);
  assert.equal(threads[1]!.root.id, "x");
});
