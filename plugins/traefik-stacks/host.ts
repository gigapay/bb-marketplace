// Runs inside the BB daemon of whichever machine the server targets, so the
// docker CLI here talks to that machine's engine.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, SLUG_PATTERN, type Stack, type StackListing } from "./contract.js";

const run = promisify(execFile);
const LIST_TIMEOUT_MS = 15_000;
const DOWN_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const STAGING_PREFIX = "staging-";

type Inspected = {
  Name: string;
  Created: string;
  State: { Status: string; Health?: { Status: string } };
  Config: { Labels: Record<string, string> | null };
};

function errorMessage(cause: unknown): string {
  const stderr = (cause as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return cause instanceof Error ? cause.message : String(cause);
}

async function inspectAll(signal: AbortSignal): Promise<Inspected[]> {
  const { stdout: ids } = await run("docker", ["ps", "-aq", "--no-trunc"], {
    timeout: LIST_TIMEOUT_MS,
    signal,
  });
  const list = ids.split("\n").filter(Boolean);
  if (list.length === 0) return [];
  // Full inspect rather than `ps --format`: that one joins labels with commas,
  // which breaks on router rules that contain commas.
  const { stdout } = await run("docker", ["inspect", ...list], {
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    signal,
  });
  return JSON.parse(stdout) as Inspected[];
}

function routerHosts(labels: Record<string, string>): string[] {
  const hosts: string[] = [];
  for (const [key, value] of Object.entries(labels)) {
    if (!/^traefik\.http\.routers\.[^.]+\.rule$/.test(key)) continue;
    for (const match of value.matchAll(/Host\(\s*`([^`]+)`\s*\)/g)) {
      if (match[1] !== undefined) hosts.push(match[1]);
    }
  }
  return hosts;
}

/**
 * Every `staging-*` compose project is a slug stack (the backend project plus
 * its `-app` frontend sibling). Other compose projects only show up when one of
 * their containers is exposed through Traefik, and they're never destroyable.
 */
function groupStacks(containers: Inspected[]): Stack[] {
  const byProject = new Map<string, Inspected[]>();
  for (const container of containers) {
    const labels = container.Config.Labels ?? {};
    const project =
      labels["com.docker.compose.project"] ??
      // A bare `docker run` container exposed through Traefik.
      (labels["traefik.enable"] === "true" ? container.Name.replace(/^\//, "") : null);
    if (project === null) continue;
    byProject.set(project, [...(byProject.get(project) ?? []), container]);
  }

  const stacks = new Map<string, Stack>();
  for (const [project, members] of byProject) {
    let id: string;
    let kind: Stack["kind"];
    if (project.startsWith(STAGING_PREFIX)) {
      const base = project.slice(STAGING_PREFIX.length);
      const parent = base.endsWith("-app") ? base.slice(0, -"-app".length) : null;
      id = parent !== null && byProject.has(`${STAGING_PREFIX}${parent}`) ? parent : base;
      kind = "staging";
    } else {
      const exposed = members.some((c) => c.Config.Labels?.["traefik.enable"] === "true");
      if (!exposed) continue;
      id = project;
      kind = "service";
    }
    const key = `${kind}:${id}`;
    const stack: Stack = stacks.get(key) ?? {
      id,
      kind,
      projects: [],
      hosts: [],
      containers: [],
      workingDir: null,
      createdAt: null,
    };
    stack.projects.push(project);
    for (const container of members) {
      const labels = container.Config.Labels ?? {};
      stack.hosts.push(...routerHosts(labels));
      stack.containers.push({
        name: container.Name.replace(/^\//, ""),
        service: labels["com.docker.compose.service"] ?? container.Name.replace(/^\//, ""),
        state: container.State.Status,
        health: container.State.Health?.Status ?? null,
      });
      const created = Date.parse(container.Created);
      if (!Number.isNaN(created)) {
        stack.createdAt = Math.min(stack.createdAt ?? created, created);
      }
      // The backend project's dir is the worktree (/var/apps/gigapay-<slug>).
      if (stack.workingDir === null || project === `${STAGING_PREFIX}${id}`) {
        stack.workingDir = labels["com.docker.compose.project.working_dir"] ?? stack.workingDir;
      }
    }
    stacks.set(key, stack);
  }

  return [...stacks.values()]
    .map((stack) => ({
      ...stack,
      projects: stack.projects.sort(),
      hosts: [...new Set(stack.hosts)].sort(),
      containers: stack.containers.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

async function list(signal: AbortSignal): Promise<StackListing> {
  const base = { hostname: os.hostname(), sampledAt: Date.now() };
  try {
    return { ...base, dockerError: null, stacks: groupStacks(await inspectAll(signal)) };
  } catch (cause) {
    if (signal.aborted) throw cause;
    return { ...base, dockerError: errorMessage(cause), stacks: [] };
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    list: (_input, context) => list(context.signal),
    destroy: async ({ slug }, context) => {
      if (!SLUG_PATTERN.test(slug)) throw new Error(`Invalid slug: ${slug}`);
      const listing = await list(context.signal);
      if (listing.dockerError !== null) throw new Error(listing.dockerError);
      // Only ever tear down projects we just saw grouped under this staging slug.
      const stack = listing.stacks.find((s) => s.kind === "staging" && s.id === slug);
      if (stack === undefined) throw new Error(`No staging stack named ${slug} on ${listing.hostname}.`);
      // Frontend first: it shares the backend's isolated network.
      const projects = [...stack.projects].sort((a, b) => b.length - a.length);
      const output: string[] = [];
      for (const project of projects) {
        try {
          // By project name, from a neutral cwd, so it works even when the
          // worktree is gone and never picks up a stray compose file.
          const { stdout, stderr } = await run(
            "docker",
            ["compose", "-p", project, "down", "--volumes", "--remove-orphans"],
            { cwd: os.tmpdir(), timeout: DOWN_TIMEOUT_MS, maxBuffer: MAX_BUFFER, signal: context.signal },
          );
          output.push(`$ docker compose -p ${project} down --volumes --remove-orphans`, stdout, stderr);
        } catch (cause) {
          throw new Error(`docker compose -p ${project} down failed: ${errorMessage(cause)}`);
        }
      }
      return {
        slug,
        projects,
        output: output.map((chunk) => chunk.trim()).filter(Boolean).join("\n"),
      };
    },
  },
});
