import assert from "node:assert/strict";
import { test } from "node:test";
import { fileGroup } from "../diff.ts";
import { toGitPatch } from "./patch.ts";

test("modified files get a/ and b/ headers", () => {
  const patch = toGitPatch({ path: "src/a.ts", previousPath: null, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" });
  assert.equal(patch, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
});

test("added, removed and renamed files", () => {
  assert.match(toGitPatch({ path: "n.ts", previousPath: null, status: "added", patch: "@@ -0,0 +1 @@\n+x" }), /new file mode[\s\S]*--- \/dev\/null\n\+\+\+ b\/n\.ts/);
  assert.match(toGitPatch({ path: "o.ts", previousPath: null, status: "removed", patch: "@@ -1 +0,0 @@\n-x" }), /--- a\/o\.ts\n\+\+\+ \/dev\/null/);
  assert.match(toGitPatch({ path: "new.ts", previousPath: "old.ts", status: "renamed", patch: "@@ -1 +1 @@\n-a\n+b" }), /rename from old\.ts\nrename to new\.ts\n--- a\/old\.ts\n\+\+\+ b\/new\.ts/);
});

test("files land in Linear-style groups", () => {
  assert.equal(fileGroup("src/hooks/useThing.ts"), "Implementation");
  assert.equal(fileGroup("src/hooks/useThing.test.ts"), "Tests");
  assert.equal(fileGroup("tests/components/X.test.tsx"), "Tests");
  assert.equal(fileGroup("docs/debug/prd.md"), "Documentation");
  assert.equal(fileGroup("README.md"), "Documentation");
});
