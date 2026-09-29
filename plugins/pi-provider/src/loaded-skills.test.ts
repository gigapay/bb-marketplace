import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractLoadedPiSkills,
  loadedSkillRoots,
  readLoadedSkillsManifest,
  writeLoadedSkillsManifest,
} from "./loaded-skills.js";
import { resolvePiNativeRoots } from "./native-roots.js";
import { isStandaloneReloadCommand } from "./reload-command.js";

let root: string;
let home: string;
let workspace: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "bb-pi-loaded-skills-"));
  home = path.join(root, "home");
  workspace = path.join(root, "workspace");
  stateDir = path.join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skillFile(dir: string, name: string): string {
  const file = path.join(dir, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
  return file;
}

function command(name: string, file: string, scope = "user", source = "local") {
  return {
    name: `skill:${name}`,
    description: `${name} skill`,
    source: "skill",
    sourceInfo: { path: file, scope, source, origin: "package" },
  };
}

describe("skills pi reports through get_commands", () => {
  it("keeps pi's own skills and drops bb's --skill paths, prompts, extension commands, and duplicates", () => {
    const marketplace = skillFile(path.join(home, ".pi/agent/claude-marketplace/generated"), "dev-workflow-gig-plan");
    const bbSkill = skillFile(path.join(root, "bb-skills"), "bb-own");
    const skills = extractLoadedPiSkills({
      commands: [
        // pi 0.87 reports extension-supplied skills as temporary/extension:<name>.
        command("dev-workflow-gig-plan", marketplace, "temporary", "extension:index"),
        command("dev-workflow-gig-plan", marketplace),
        // ...and bb's own --skill roots as temporary/local.
        command("bb-own", bbSkill, "temporary", "local"),
        { name: "fix-tests", source: "prompt", sourceInfo: { path: "/x/fix-tests.md", scope: "user" } },
        { name: "subagents", source: "extension", sourceInfo: { path: "/x/index.ts", scope: "user" } },
        command("not-a-skill-file", "/x/README.md"),
        command("relative", "skills/rel/SKILL.md"),
      ],
    }, { excludeRoots: [path.join(root, "bb-skills")] });
    expect(skills).toEqual([
      { name: "dev-workflow-gig-plan", path: marketplace, scope: "user" },
    ]);
    expect(extractLoadedPiSkills(null)).toEqual([]);
    expect(extractLoadedPiSkills({ commands: "nope" })).toEqual([]);
  });

  it("round-trips the per-workspace record and ignores another workspace's", () => {
    const file = skillFile(path.join(root, "pkg"), "alpha");
    writeLoadedSkillsManifest({
      stateDir,
      cwd: workspace,
      skills: [{ name: "alpha", path: file, scope: "user" }],
    });
    expect(readLoadedSkillsManifest(stateDir, workspace)).toEqual([
      { name: "alpha", path: file, scope: "user" },
    ]);
    expect(readLoadedSkillsManifest(stateDir, path.join(root, "elsewhere"))).toEqual([]);
  });

  it("lists only what bb's scanned roots miss, and forgets skills whose file is gone", () => {
    const declared = skillFile(path.join(home, ".pi/agent/skills"), "declared");
    const packaged = skillFile(path.join(home, ".pi/agent/git/github.com/acme/pkg/skills"), "packaged");
    const removed = skillFile(path.join(root, "gone"), "removed");
    rmSync(removed);
    const project = skillFile(path.join(workspace, "nested/.agents/skills"), "local");
    const roots = loadedSkillRoots({
      cwd: workspace,
      coveredRoots: [path.join(home, ".pi/agent/skills")],
      skills: [
        { name: "declared", path: declared, scope: "user" },
        { name: "packaged", path: packaged, scope: "user" },
        { name: "removed", path: removed, scope: "user" },
        { name: "local", path: project, scope: "project" },
      ],
    });
    expect(roots).toEqual([
      { path: packaged, origin: "user", shape: "skill-file", fallbackName: "packaged" },
      { path: project, origin: "project", shape: "skill-file", fallbackName: "local" },
    ]);
  });
});

describe("the host entry's resolved roots", () => {
  it("adds recorded skills beside the upstream settings roots and offers /reload", async () => {
    const packaged = skillFile(path.join(home, ".pi/agent/git/github.com/acme/pkg/skills"), "packaged");
    const declared = skillFile(path.join(workspace, ".pi/skills"), "project-declared");
    writeLoadedSkillsManifest({
      stateDir,
      cwd: workspace,
      skills: [
        { name: "packaged", path: packaged, scope: "user" },
        { name: "project-declared", path: declared, scope: "project" },
      ],
    });
    const answer = await resolvePiNativeRoots({
      homeDir: home,
      env: {},
      cwd: workspace,
      stateDir,
    });
    expect(answer.skills).toEqual([
      { path: packaged, origin: "user", shape: "skill-file", fallbackName: "packaged" },
    ]);
    expect(answer.commands).toEqual([
      {
        path: path.join(stateDir, "commands", "reload.md"),
        origin: "user",
        shape: "command-file",
      },
    ]);
  });

  it("still answers with the skill roots when the state dir cannot be written", async () => {
    const blocked = path.join(root, "not-a-dir");
    writeFileSync(blocked, "file");
    const answer = await resolvePiNativeRoots({
      homeDir: home,
      env: {},
      cwd: workspace,
      stateDir: blocked,
    });
    expect(answer).toEqual({ skills: [] });
  });

  it("answers exactly like upstream when it has no state dir", async () => {
    const answer = await resolvePiNativeRoots({ homeDir: home, env: {} });
    expect(answer).toEqual({ skills: [] });
  });
});

describe("the /reload command", () => {
  const text = (value: string, mentions: unknown[] = []) =>
    [{ type: "text", text: value, mentions }] as Parameters<typeof isStandaloneReloadCommand>[0];
  it("matches only a standalone /reload", () => {
    expect(isStandaloneReloadCommand(text("/reload"))).toBe(true);
    expect(isStandaloneReloadCommand(text("  /reload \n"))).toBe(true);
    expect(isStandaloneReloadCommand(text("/reload now"))).toBe(false);
    expect(isStandaloneReloadCommand(text("/reloads"))).toBe(false);
    expect(isStandaloneReloadCommand(text("please /reload"))).toBe(false);
    const skillMention = {
      start: 0,
      end: 7,
      resource: { kind: "command", label: "reload", name: "reload", origin: "user", source: "skill", trigger: "/", argumentHint: null },
    };
    expect(isStandaloneReloadCommand(text("/reload", [skillMention]))).toBe(false);
    expect(isStandaloneReloadCommand([])).toBe(false);
  });
});
