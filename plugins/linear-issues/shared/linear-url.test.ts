import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLinearUrl, readPanelTarget } from "./linear-url.ts";

test("recognizes Linear issue and project links", () => {
  assert.deepEqual(parseLinearUrl("https://linear.app/gigapay/issue/GIG-6561/user-cannot-accept-payout"), { kind: "issue", identifier: "GIG-6561" });
  assert.deepEqual(parseLinearUrl("https://linear.app/gigapay/issue/gig-12"), { kind: "issue", identifier: "GIG-12" });
  assert.deepEqual(parseLinearUrl("https://linear.app/gigapay/project/session-cookie-authentication-v2-8bb10d790123"), { kind: "project", id: "8bb10d790123" });
  assert.deepEqual(parseLinearUrl("https://linear.app/gigapay/project/session-cookie-authentication-v2-8bb10d790123/overview"), { kind: "project", id: "8bb10d790123" });
});

test("ignores everything else", () => {
  assert.equal(parseLinearUrl("https://linear.app/gigapay/view/my-issues"), null);
  assert.equal(parseLinearUrl("https://github.com/gigapay/app/pull/1"), null);
  assert.equal(parseLinearUrl("https://uploads.linear.app/a/b/c"), null);
  assert.equal(parseLinearUrl("not a url"), null);
});

test("panel params are validated", () => {
  assert.deepEqual(readPanelTarget({ kind: "issue", identifier: "GIG-1" }), { kind: "issue", identifier: "GIG-1" });
  assert.equal(readPanelTarget({ kind: "issue" }), null);
  assert.equal(readPanelTarget(null), null);
});
