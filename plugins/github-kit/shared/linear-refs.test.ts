import assert from "node:assert/strict";
import { test } from "node:test";
import { linearIdentifiers } from "./linear-refs.ts";

test("title, branch and body, deduplicated and in that order", () => {
  assert.deepEqual(
    linearIdentifiers({
      title: "GIG-6553: Fix recipient contact changes",
      headRefName: "yoann/gig-6553-fix-recipient-contact",
      body: "Resolves GIG-6553 and relates to GIG-12.",
    }),
    ["GIG-6553", "GIG-12"],
  );
});

test("code, URLs and look-alike tokens are not tickets", () => {
  assert.deepEqual(
    linearIdentifiers({
      title: "Switch to UTF-8 and SHA-256",
      headRefName: "main",
      body: "See `ENG-1` and https://example.com/ABC-2 in ```\nXYZ-3\n``` but fix OPS-4",
    }),
    ["OPS-4"],
  );
});

test("lowercase only counts in the branch name", () => {
  assert.deepEqual(linearIdentifiers({ title: "fix gig-5 later", headRefName: "feature", body: "" }), []);
});
