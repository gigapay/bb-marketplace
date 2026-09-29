import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { loadedSkillRoots, readLoadedSkillsManifest } from "./loaded-skills.js";
import {
  PI_RELOAD_COMMAND_NAME,
  reloadCommandFileContent,
} from "./reload-command.js";

export const PI_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".pi/agent/skills", ".agents/skills"],
    project: [".pi/skills", ".agents/skills"],
  },
  experimental_resolvesNativeRoots: true,
};

const piSettingsSchema = z
  .object({ skills: z.array(z.string()).optional() })
  .passthrough();

const DEFAULT_AGENT_DIR_SEGMENTS = [".pi", "agent"] as const;

export interface ResolvePiNativeRootsArgs {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Fork addition: the workspace bb is listing for, when it has one. */
  cwd?: string | null;
  /** Fork addition: where the bridge records loaded skills and commands. */
  stateDir?: string;
}

function resolvePiAgentDir(args: ResolvePiNativeRootsArgs): string {
  const configured = args.env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolveStoredPath(args.homeDir, configured, args.homeDir)
    : path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS);
}

function resolveStoredPath(
  homeDir: string,
  value: string,
  baseDir: string,
): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isPlainSkillSource(value: string): boolean {
  return !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value);
}

export async function resolvePiNativeRoots(
  args: ResolvePiNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const agentDir = resolvePiAgentDir(args);
  const roots = new Set<string>();
  if (agentDir !== path.join(args.homeDir, ...DEFAULT_AGENT_DIR_SEGMENTS)) {
    roots.add(path.resolve(agentDir, "skills"));
  }
  let settings: z.infer<typeof piSettingsSchema> | null = null;
  try {
    settings = piSettingsSchema.parse(
      JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")),
    );
  } catch {
    settings = null;
  }
  for (const raw of settings?.skills ?? []) {
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.startsWith("!") ||
      !isPlainSkillSource(value)
    ) {
      continue;
    }
    if (path.extname(value).toLowerCase() === ".md") {
      continue;
    }
    roots.add(path.resolve(resolveStoredPath(args.homeDir, value, agentDir)));
  }
  const settingsRoots = [...roots].sort().map((rootPath) => ({
    path: rootPath,
    origin: "user" as const,
    shape: "skills" as const,
  }));
  // Fork addition: skills pi loaded at runtime that no scanned root covers.
  const loaded =
    args.stateDir !== undefined && args.cwd
      ? loadedSkillRoots({
          skills: readLoadedSkillsManifest(args.stateDir, args.cwd),
          coveredRoots: [
            ...declaredSkillRoots(args.homeDir, args.cwd),
            ...settingsRoots.map((root) => root.path),
          ],
          cwd: args.cwd,
        })
      : [];
  const commands = args.stateDir === undefined ? [] : reloadCommandRoots(args.stateDir);
  const filtered = experimental_filterResolvedNativeRoots(
    { skills: [...settingsRoots, ...loaded], commands },
    { warn: console.warn },
  ).answer;
  return {
    skills: filtered.skills,
    ...(commands.length > 0 ? { commands: filtered.commands } : {}),
  };
}

function declaredSkillRoots(homeDir: string, cwd: string): string[] {
  const declared = PI_NATIVE_ROOTS_DECLARATION.experimental_nativeSkillRoots;
  const rootPath = (root: string | { path: string }) =>
    typeof root === "string" ? root : root.path;
  return [
    ...(declared?.user ?? []).map((root) => path.resolve(homeDir, rootPath(root))),
    ...(declared?.project ?? []).map((root) => path.resolve(cwd, rootPath(root))),
  ];
}

/**
 * `/reload` in bb's composer, as a command file the plugin owns. An unwritable
 * state dir costs only this entry, never the upstream skill roots.
 */
function reloadCommandRoots(stateDir: string): Array<{
  path: string;
  origin: "user";
  shape: "command-file";
}> {
  const file = path.join(stateDir, "commands", `${PI_RELOAD_COMMAND_NAME}.md`);
  const content = reloadCommandFileContent();
  try {
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current !== content) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, "utf8");
    }
  } catch (error) {
    console.warn(
      `pi-provider: cannot write the /reload command file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
  return [{ path: file, origin: "user", shape: "command-file" }];
}
