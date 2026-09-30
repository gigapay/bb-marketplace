import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../cli.ts";

test("parses repeatable flags, switches, inline values and positionals", () => {
  const parsed = parseArgs(["update", "GIG-1", "--add-label", "Bug", "--add-label=Backend", "--state", "In Progress", "--json"]);
  assert.deepEqual(parsed.positionals, ["update", "GIG-1"]);
  assert.deepEqual(parsed.flags.get("add-label"), ["Bug", "Backend"]);
  assert.deepEqual(parsed.flags.get("state"), ["In Progress"]);
  assert.ok(parsed.switches.has("json"));
});

test("comment bodies stay positional and a missing flag value is an error", () => {
  assert.deepEqual(parseArgs(["comment", "GIG-2", "Looks good", "--reply-to", "c1"]).positionals, ["comment", "GIG-2", "Looks good"]);
  assert.throws(() => parseArgs(["create", "--title"]), /--title needs a value/);
});
