import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PI_PROVIDER_STATE_DIR_ENV, readLoadedSkillsManifest } from "../loaded-skills.js";
import { resolvePiNativeRoots } from "../native-roots.js";
import { replyTo, turnStart } from "./fork-test-support.js";
import { type FakePiBridgeHarness, startFakePiBridge } from "./test-support.js";

vi.setConfig({ testTimeout: 30_000 });

let harness: FakePiBridgeHarness | undefined;

afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

function skill(dir: string, name: string): string {
  const file = path.join(dir, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  return file;
}

function commands(file: string, entries: Array<{ name: string; path: string; scope?: string; source?: string }>) {
  writeFileSync(
    file,
    JSON.stringify(
      entries.map((entry) => ({
        name: `skill:${entry.name}`,
        description: entry.name,
        source: "skill",
        sourceInfo: { path: entry.path, scope: entry.scope ?? "user", source: entry.source ?? "local", origin: "package" },
      })),
    ),
  );
}

it("records the skills pi loaded, dynamic ones included, and refreshes the record on /reload", async () => {
  const h = await startFakePiBridge({ prefix: "bb-pi-loaded-skills-", initialize: true });
  harness = h;
  const stateDir = process.env[PI_PROVIDER_STATE_DIR_ENV]!;
  const generated = path.join(h.workspaceDir, "pi-agent/claude-marketplace/generated");
  const marketplace = skill(generated, "dev-workflow-gig-plan");
  const second = skill(generated, "dev-workflow-gig-review");
  const bbOwn = skill(path.join(h.workspaceDir, "bb-skills"), "bb-own");
  const commandsFile = path.join(h.workspaceDir, "commands.json");
  commands(commandsFile, [
    { name: "dev-workflow-gig-plan", path: marketplace, scope: "temporary", source: "extension:index" },
    { name: "dev-workflow-gig-review", path: second, scope: "temporary", source: "extension:index" },
    { name: "bb-own", path: bbOwn, scope: "temporary", source: "local" },
  ]);
  vi.stubEnv("FAKE_PI_COMMANDS_FILE", commandsFile);

  const threadId = "thr_loaded_skills";
  // bb hands pi its own skill roots; those must not be listed twice.
  expect(
    (
      await h.request(9_100, "skills/configure", {
        roots: [
          {
            id: "bb-user",
            path: path.join(h.workspaceDir, "bb-skills"),
            skills: [{ name: "bb-own", description: "bb-own" }],
          },
        ],
      })
    ).result,
  ).toEqual({ ok: true });
  await h.startThread(threadId);
  await h.waitFor(
    () => readLoadedSkillsManifest(stateDir, h.workspaceDir).length === 2,
    "the loaded-skills record",
  );
  const listed = await resolvePiNativeRoots({
    homeDir: path.join(h.workspaceDir, "home"),
    env: {},
    cwd: h.workspaceDir,
    stateDir,
  });
  expect(listed.skills?.map((root) => root.fallbackName)).toEqual([
    "dev-workflow-gig-plan",
    "dev-workflow-gig-review",
  ]);

  // The user disables one marketplace skill, then reloads Pi.
  commands(commandsFile, [{ name: "dev-workflow-gig-plan", path: marketplace }]);
  const since = h.deltasOf(threadId).length;
  expect((await replyTo(h, turnStart(h, threadId, "/reload"))).result).toEqual({ threadId });
  await h.waitForTurnBoundary(threadId, since);
  await h.waitFor(
    () => readLoadedSkillsManifest(stateDir, h.workspaceDir).length === 1,
    "the refreshed record",
  );
  const refreshed = await resolvePiNativeRoots({
    homeDir: path.join(h.workspaceDir, "home"),
    env: {},
    cwd: h.workspaceDir,
    stateDir,
  });
  expect(refreshed.skills?.map((root) => root.fallbackName)).toEqual(["dev-workflow-gig-plan"]);
});

it("keeps the thread working when pi cannot list its commands", async () => {
  const h = await startFakePiBridge({ prefix: "bb-pi-loaded-skills-none-", initialize: true });
  harness = h;
  vi.stubEnv("FAKE_PI_COMMANDS_FILE", path.join(h.workspaceDir, "missing.json"));
  const threadId = "thr_loaded_skills_none";
  await h.startThread(threadId);
  const since = h.deltasOf(threadId).length;
  turnStart(h, threadId, "hello");
  await h.waitForTurnBoundary(threadId, since);
  expect(readLoadedSkillsManifest(process.env[PI_PROVIDER_STATE_DIR_ENV]!, h.workspaceDir)).toEqual([]);
});
