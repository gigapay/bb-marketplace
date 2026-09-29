import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePrKey, parsePrUrl, prKey } from "./pr-ref.ts";

test("parses PR URLs, including sub-pages", () => {
  assert.deepEqual(parsePrUrl("https://github.com/gigapay/gigapay-app/pull/1735"), {
    owner: "gigapay",
    name: "gigapay-app",
    number: 1735,
  });
  assert.equal(parsePrUrl("https://github.com/a/b/pull/12/files")?.number, 12);
  assert.equal(parsePrUrl("https://github.com/a/b/issues/12"), null);
  assert.equal(parsePrUrl("https://evil.example/a/b/pull/12"), null);
});

test("round-trips keys", () => {
  const ref = parsePrKey("gigapay/gigapay-app#1735");
  assert.ok(ref);
  assert.equal(prKey(ref), "gigapay/gigapay-app#1735");
  assert.equal(parsePrKey("a/b#0"), null);
  assert.equal(parsePrKey("a/b/c#1"), null);
});
