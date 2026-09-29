import assert from "node:assert/strict";
import { test } from "node:test";
import { isBotLogin } from "./audience.ts";

test("GitHub apps and [bot] users are bots", () => {
  assert.equal(isBotLogin("claude", "Bot"), true);
  assert.equal(isBotLogin("renovate[bot]", "User"), true);
});

test("review tools posting as users are bots", () => {
  assert.equal(isBotLogin("sonarqubecloud", "User"), true);
  assert.equal(isBotLogin("coderabbitai", "User"), true);
  assert.equal(isBotLogin("gigapay-automation", "User"), true);
});

test("people stay people", () => {
  assert.equal(isBotLogin("yteruel31", "User"), false);
  assert.equal(isBotLogin("abbott", "User"), false);
});
