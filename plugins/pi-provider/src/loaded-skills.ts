import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Skills pi actually loaded, as pi reports them through the `get_commands`
 * RPC. bb only scans the directories a provider declares or resolves, so
 * skills pi receives at runtime (`resources_discover` from extensions such as
 * pi-toolbox's Claude marketplace, packages under pi's git/npm caches) never
 * reach bb's `/` menu on their own. The bridge records them per workspace;
 * the host entry turns the record into resolved `skill-file` roots.
 */

export const PI_PROVIDER_STATE_DIR_ENV = "BB_PI_PROVIDER_STATE_DIR";

const MANIFEST_VERSION = 1;
const MAX_SKILLS = 256;
const MAX_PATH = 4096;
const MAX_NAME = 128;

export function resolvePiProviderStateDir(args: {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}): string {
  const configured = args.env[PI_PROVIDER_STATE_DIR_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(args.homeDir, ".bb", "pi-provider");
}

export interface LoadedPiSkill {
  name: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
  scope: "user" | "project";
}

const getCommandsSkillSchema = z
  .object({
    name: z.string().startsWith("skill:"),
    source: z.literal("skill"),
    sourceInfo: z
      .object({
        path: z.string().min(1).max(MAX_PATH),
        scope: z.string().optional(),
        source: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The skills of a `get_commands` answer that bb does not already own. pi
 * reports bb's own `--skill` roots and extension-supplied skills alike as
 * `temporary` scope (pi 0.87: `local` vs `extension:<name>` source), so bb's
 * skills are told apart by path, never by scope.
 */
export function extractLoadedPiSkills(
  data: unknown,
  options: { excludeRoots?: readonly string[] } = {},
): LoadedPiSkill[] {
  const excludeRoots = (options.excludeRoots ?? []).map((root) => path.resolve(root));
  const commands =
    data && typeof data === "object" && Array.isArray((data as { commands?: unknown }).commands)
      ? ((data as { commands: unknown[] }).commands)
      : [];
  const skills: LoadedPiSkill[] = [];
  const seen = new Set<string>();
  for (const raw of commands) {
    const parsed = getCommandsSkillSchema.safeParse(raw);
    if (!parsed.success) continue;
    const name = parsed.data.name.slice("skill:".length);
    const info = parsed.data.sourceInfo;
    if (
      name.length === 0 ||
      name.length > MAX_NAME ||
      !path.isAbsolute(info.path) ||
      excludeRoots.some(
        (root) => root === path.dirname(info.path) || isInside(root, info.path),
      ) ||
      path.basename(info.path) !== "SKILL.md" ||
      seen.has(name)
    ) {
      continue;
    }
    seen.add(name);
    skills.push({
      name,
      path: path.normalize(info.path),
      scope: info.scope === "project" ? "project" : "user",
    });
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills;
}

const manifestSchema = z.object({
  v: z.literal(MANIFEST_VERSION),
  cwd: z.string(),
  skills: z
    .array(
      z.object({
        name: z.string().min(1).max(MAX_NAME),
        path: z.string().min(1).max(MAX_PATH),
        scope: z.enum(["user", "project"]),
      }),
    )
    .max(MAX_SKILLS),
});

export function loadedSkillsManifestPath(stateDir: string, cwd: string): string {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
  return path.join(stateDir, "loaded-skills", `${key}.json`);
}

/** Atomic replace: a listing never reads a half-written record. */
export function writeLoadedSkillsManifest(args: {
  stateDir: string;
  cwd: string;
  skills: readonly LoadedPiSkill[];
}): void {
  const target = loadedSkillsManifestPath(args.stateDir, args.cwd);
  mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({ v: MANIFEST_VERSION, cwd: path.resolve(args.cwd), skills: args.skills }),
    "utf8",
  );
  renameSync(temp, target);
}

export function readLoadedSkillsManifest(
  stateDir: string,
  cwd: string,
): LoadedPiSkill[] {
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(readFileSync(loadedSkillsManifestPath(stateDir, cwd), "utf8")),
    );
    return parsed.success && parsed.data.cwd === path.resolve(cwd)
      ? parsed.data.skills
      : [];
  } catch {
    return [];
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The recorded skills as bb `skill-file` roots, minus those a scanned root
 * already covers (bb would list them twice) and those whose file is gone.
 */
export function loadedSkillRoots(args: {
  skills: readonly LoadedPiSkill[];
  coveredRoots: readonly string[];
  cwd: string;
}): Array<{
  path: string;
  origin: "user" | "project";
  shape: "skill-file";
  fallbackName: string;
}> {
  const cwd = path.resolve(args.cwd);
  const roots: Array<{
    path: string;
    origin: "user" | "project";
    shape: "skill-file";
    fallbackName: string;
  }> = [];
  const seenPaths = new Set<string>();
  for (const skill of args.skills) {
    if (
      seenPaths.has(skill.path) ||
      args.coveredRoots.some((root) => isInside(root, skill.path)) ||
      !existsSync(skill.path)
    ) {
      continue;
    }
    seenPaths.add(skill.path);
    roots.push({
      path: skill.path,
      // bb scopes a project root to the workspace; an ancestor directory pi
      // walked up to is listed as a user root rather than dropped.
      origin: skill.scope === "project" && isInside(cwd, skill.path) ? "project" : "user",
      shape: "skill-file",
      fallbackName: skill.name,
    });
  }
  return roots;
}
