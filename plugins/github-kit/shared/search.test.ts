import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrSearch } from "./search.ts";

test("open review requests by default", () => {
  assert.equal(
    buildPrSearch("review", false, ""),
    "is:pr archived:false review-requested:@me is:open sort:updated-desc",
  );
});

test("closed PRs drop the is:open qualifier", () => {
  assert.equal(buildPrSearch("authored", true, ""), "is:pr archived:false author:@me sort:updated-desc");
});

test("free text and qualifiers are appended", () => {
  assert.equal(
    buildPrSearch("involved", false, "  repo:gigapay/gigapay-app fix  "),
    "is:pr archived:false involves:@me is:open repo:gigapay/gigapay-app fix sort:updated-desc",
  );
});
