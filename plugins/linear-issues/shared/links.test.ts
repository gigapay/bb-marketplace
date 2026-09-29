import assert from "node:assert/strict";
import { test } from "node:test";
import { issueIdentifierFromBranch, resolveLink } from "./links.ts";

const teams = new Set(["GIG", "ENG"]);

test("finds the identifier in common branch shapes", () => {
  assert.equal(issueIdentifierFromBranch("gig-123-fix-login", teams), "GIG-123");
  assert.equal(issueIdentifierFromBranch("yoann/gig-123-fix-login", teams), "GIG-123");
  assert.equal(issueIdentifierFromBranch("feature/ENG-7", teams), "ENG-7");
  assert.equal(issueIdentifierFromBranch("fix_gig-42_crash", teams), "GIG-42");
  assert.equal(issueIdentifierFromBranch("feature-gig-9-thing", teams), "GIG-9");
});

test("ignores unknown team keys and version-like segments", () => {
  assert.equal(issueIdentifierFromBranch("release-2-1", teams), null);
  assert.equal(issueIdentifierFromBranch("abc-123-thing", teams), null);
  assert.equal(issueIdentifierFromBranch("main", teams), null);
  assert.equal(issueIdentifierFromBranch(null, teams), null);
});

test("does not match a key glued to other letters", () => {
  assert.equal(issueIdentifierFromBranch("biggig-12", teams), null);
});

test("normalizes leading zeros", () => {
  assert.equal(issueIdentifierFromBranch("gig-0042", teams), "GIG-42");
});

test("a stored row overrides the branch, including an explicit unlink", () => {
  assert.deepEqual(resolveLink(undefined, "gig-1-x", teams), { identifier: "GIG-1", source: "branch" });
  assert.equal(resolveLink({ identifier: null, source: "manual" }, "gig-1-x", teams), null);
  assert.deepEqual(resolveLink({ identifier: "ENG-5", source: "manual" }, "gig-1-x", teams), {
    identifier: "ENG-5",
    source: "manual",
  });
});
