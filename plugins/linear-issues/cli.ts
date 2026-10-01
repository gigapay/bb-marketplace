// The `bb linear` CLI agents use from threads: read issues and
// projects, and write issues, comments, projects and project updates.
// Names are accepted everywhere ids are ("In Progress", "me", "Bug").
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { groupCommentThreads } from "./shared/comments.js";
import { IDENTIFIER_PATTERN } from "./shared/links.js";
import { PROJECTS_QUERY, PROJECT_QUERY, flattenProject, flattenProjectDetail, type ProjectDetail, type ProjectSummary } from "./projects.js";
import { PROJECT_MILESTONES_QUERY, createWriter, loadWriteOptions, resolver, type WriteOptions } from "./writes.js";
import type { IssueDetail, IssueSummary } from "./server.js";

type Linear = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface CliDeps {
  linear: Linear;
  listIssues(): Promise<IssueSummary[]>;
  getIssue(id: string): Promise<IssueDetail>;
  linkForThread(threadId: string): Promise<{ identifier: string; source: string } | null>;
  storeLink(threadId: string, identifier: string | null, source: "spawn" | "manual"): void;
}

// ------------------------------------------------------------------ parsing

type Parsed = { positionals: string[]; flags: Map<string, string[]>; switches: Set<string> };

const SWITCHES = new Set(["json", "all", "link", "help"]);

/** `--flag value` (repeatable) and `--switch`; everything else is positional. */
export function parseArgs(argv: readonly string[]): Parsed {
  const parsed: Parsed = { positionals: [], flags: new Map(), switches: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--") || token === "--") {
      parsed.positionals.push(token);
      continue;
    }
    const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const name = rawName.toLowerCase();
    if (SWITCHES.has(name) && inline === undefined) {
      parsed.switches.add(name);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (inline === undefined) index += 1;
    parsed.flags.set(name, [...(parsed.flags.get(name) ?? []), value]);
  }
  return parsed;
}

const one = (parsed: Parsed, name: string) => parsed.flags.get(name)?.at(-1);
const many = (parsed: Parsed, name: string) => parsed.flags.get(name) ?? [];

function known(parsed: Parsed, allowed: string[]) {
  const unknown = [...parsed.flags.keys()].filter((name) => !allowed.includes(name));
  if (unknown.length) throw new Error(`Unknown option ${unknown.map((name) => `--${name}`).join(", ")}. Allowed: ${allowed.map((name) => `--${name}`).join(", ")}`);
}

// Agents write multi-line Markdown with literal "\n"; turn it into newlines.
const text = (value: string) => value.replace(/\\n/g, "\n");

// ----------------------------------------------------------------- formatting

export function formatIssueText(issue: IssueDetail): string {
  const lines = [
    `${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    `State: ${issue.state.name} · Priority: ${issue.priorityLabel} · Team: ${issue.team.key}`,
    `Assignee: ${issue.assignee?.name ?? "Unassigned"} · Branch: ${issue.branchName}`,
  ];
  if (issue.project) lines.push(`Project: ${issue.project.name}${issue.milestone ? ` · Milestone: ${issue.milestone.name}` : ""}`);
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.map((label) => label.name).join(", ")}`);
  lines.push("", issue.description?.trim() || "(no description)");
  for (const thread of groupCommentThreads(issue.comments)) {
    const status = thread.resolved ? " [resolved]" : "";
    lines.push("", `--- ${thread.root.author.name} (${thread.root.createdAt}) [comment ${thread.root.id}]${status}`, thread.root.body);
    for (const reply of thread.replies) {
      lines.push(`    ↳ ${reply.author.name} (${reply.createdAt}) [comment ${reply.id}]`, ...reply.body.split("\n").map((line) => `      ${line}`));
    }
  }
  return lines.join("\n");
}

function formatProject(project: ProjectDetail): string {
  const lines = [
    `${project.name} [project ${project.id}]`,
    `URL: ${project.url}`,
    `Status: ${project.status?.name ?? "—"} · Health: ${project.health ?? "—"} · Progress: ${Math.round(project.progress * 100)}%`,
    `Lead: ${project.lead?.name ?? "—"} · ${project.startDate ?? "…"} → ${project.targetDate ?? "…"}`,
  ];
  if (project.description) lines.push(`Summary: ${project.description}`);
  if (project.milestones.length) {
    lines.push("", "Milestones:", ...project.milestones.map((m) => `- ${m.name} (${Math.round(m.progress * 100)}%${m.targetDate ? `, ${m.targetDate}` : ""})`));
  }
  lines.push("", project.content?.trim() || "(no description)");
  for (const update of project.updates.slice(0, 5)) {
    lines.push("", `--- Update by ${update.author} (${update.createdAt}) · ${update.health ?? "no health"} [update ${update.id}]`, update.body);
  }
  return lines.join("\n");
}

const bounded = (value: string) => (value.length > 200_000 ? `${value.slice(0, 200_000)}\n… (truncated)` : value);
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const USAGE = `Usage: bb linear <command> [options] [--json]

Issues
  list                                   Your open assigned issues
  show <ID>                              Issue with description and comments (with comment ids)
  create --title <t> [--team KEY] [--description <md>] [--priority urgent|high|medium|low|none]
         [--state <name>] [--assignee me|<name>|none] [--label <name>]... [--project <name>|none]
         [--milestone <name>] [--parent <ID>] [--link]
  update <ID> [--title] [--description] [--priority] [--state] [--assignee]
         [--add-label <name>]... [--remove-label <name>]... [--project <name>|none] [--milestone <name>|none]
  archive <ID>

Comments
  comment <ID> <markdown> [--reply-to <comment id>]
  comment-edit <comment id> <markdown>
  comment-delete <comment id>

Projects and updates
  projects [--all]                       Your active projects (--all: everyone's, including closed)
  project <name|id>                      Project with milestones and recent updates (with update ids)
  project-create --name <n> [--team KEY]... [--description <one line>] [--content <md>]
         [--lead me|<name>] [--status <name>] [--start YYYY-MM-DD] [--target YYYY-MM-DD]
  project-edit <name|id> [--name] [--description] [--content] [--status] [--lead] [--start|none] [--target|none]
  project-delete <name|id>               Moves the project to Linear's trash
  update-post <project> --health onTrack|atRisk|offTrack <markdown>
  update-edit <update id> [--health <h>] [<markdown>]
  update-archive <update id>

This thread
  current                                Issue linked to this thread
  link <ID> / unlink

Text arguments are Markdown; write "\\n" for a line break.`;

// --------------------------------------------------------------------- CLI

export function registerCli(bb: BbPluginApi, deps: CliDeps) {
  const writer = createWriter(deps.linear);
  let optionsCache: { at: number; value: Promise<WriteOptions> } | null = null;
  const options = () => {
    if (!optionsCache || Date.now() - optionsCache.at > 60_000) optionsCache = { at: Date.now(), value: loadWriteOptions(deps.linear) };
    return optionsCache.value;
  };

  async function findProject(value: string): Promise<ProjectSummary> {
    const data = await deps.linear<{ projects: { nodes: Parameters<typeof flattenProject>[0][] } }>(PROJECTS_QUERY, { filter: null });
    const projects = data.projects.nodes.map(flattenProject);
    const wanted = value.trim().toLowerCase();
    const exact = projects.filter((project) => project.id === value || project.name.toLowerCase() === wanted);
    const partial = exact.length ? exact : projects.filter((project) => project.name.toLowerCase().includes(wanted));
    if (partial.length === 1) return partial[0]!;
    const choices = (partial.length ? partial : projects).slice(0, 12).map((project) => project.name).join(", ");
    throw new Error(`${partial.length ? "Ambiguous" : "Unknown"} project "${value}". Choose one of: ${choices}`);
  }

  async function milestoneId(projectId: string, value: string): Promise<string | null> {
    if (value.trim().toLowerCase() === "none") return null;
    const data = await deps.linear<{ project: { projectMilestones: { nodes: { id: string; name: string }[] } } | null }>(PROJECT_MILESTONES_QUERY, { id: projectId });
    const milestones = data.project?.projectMilestones.nodes ?? [];
    const match = milestones.filter((m) => m.name.toLowerCase() === value.trim().toLowerCase() || m.id === value);
    const found = match.length ? match : milestones.filter((m) => m.name.toLowerCase().includes(value.trim().toLowerCase()));
    if (found.length === 1) return found[0]!.id;
    throw new Error(`Unknown milestone "${value}". Milestones: ${milestones.map((m) => m.name).join(", ") || "none"}`);
  }

  const done = (json: boolean, value: unknown, message: string) => ({ exitCode: 0, stdout: bounded(json ? JSON.stringify(value) : message) });

  const cli: Parameters<typeof bb.cli.register>[0] = {
    name: "linear",
    summary: "Read and write your Linear issues, comments, projects and project updates",
    commands: [
      { name: "list", summary: "List your open assigned issues", usage: "bb linear list [--json]" },
      { name: "show", summary: "Show an issue with its comments", usage: "bb linear show <ID> [--json]" },
      { name: "create", summary: "Create an issue", usage: "bb linear create --title <t> [options]" },
      { name: "update", summary: "Edit an issue's fields", usage: "bb linear update <ID> [options]" },
      { name: "archive", summary: "Archive an issue", usage: "bb linear archive <ID>" },
      { name: "comment", summary: "Comment on an issue or reply", usage: "bb linear comment <ID> <markdown> [--reply-to <id>]" },
      { name: "comment-edit", summary: "Edit a comment", usage: "bb linear comment-edit <comment id> <markdown>" },
      { name: "comment-delete", summary: "Delete a comment", usage: "bb linear comment-delete <comment id>" },
      { name: "projects", summary: "List projects", usage: "bb linear projects [--all]" },
      { name: "project", summary: "Show a project", usage: "bb linear project <name|id>" },
      { name: "project-create", summary: "Create a project", usage: "bb linear project-create --name <n> [options]" },
      { name: "project-edit", summary: "Edit a project", usage: "bb linear project-edit <name|id> [options]" },
      { name: "project-delete", summary: "Move a project to the trash", usage: "bb linear project-delete <name|id>" },
      { name: "update-post", summary: "Post a project update", usage: "bb linear update-post <project> --health <h> <markdown>" },
      { name: "update-edit", summary: "Edit a project update", usage: "bb linear update-edit <update id> [--health <h>] [<markdown>]" },
      { name: "update-archive", summary: "Archive a project update", usage: "bb linear update-archive <update id>" },
      { name: "current", summary: "Show the issue linked to this thread", usage: "bb linear current [--json]" },
      { name: "link", summary: "Link this thread to an issue", usage: "bb linear link <ID>" },
      { name: "unlink", summary: "Unlink this thread", usage: "bb linear unlink" },
    ],
    async run(argv, context) {
      let parsed: Parsed;
      try {
        parsed = parseArgs(argv);
      } catch (cause) {
        return { exitCode: 1, stderr: `${errorMessage(cause)}\n\n${USAGE}` };
      }
      const [command, ...rest] = parsed.positionals;
      const json = parsed.switches.has("json");
      const threadId = context?.threadId;
      try {
        switch (command) {
          case undefined:
          case "help":
            return { exitCode: 0, stdout: USAGE };

          case "list": {
            const issues = await deps.listIssues();
            const lines = issues.map((issue) => `${issue.identifier}  [${issue.state.name}]  ${issue.title}`);
            return done(json, issues, lines.join("\n") || "No open assigned issues.");
          }
          case "show": {
            if (!rest[0]) break;
            const issue = await deps.getIssue(rest[0]);
            return done(json, issue, formatIssueText(issue));
          }

          case "create": {
            known(parsed, ["title", "team", "description", "priority", "state", "assignee", "label", "project", "milestone", "parent"]);
            const title = one(parsed, "title") ?? rest.join(" ");
            if (!title.trim()) throw new Error("Pass --title");
            const opts = await options();
            const r = resolver(opts);
            const team = r.team(one(parsed, "team"));
            const projectId = one(parsed, "project") ? r.project(one(parsed, "project")!) : null;
            const milestone = one(parsed, "milestone");
            if (milestone && !projectId) throw new Error("--milestone needs --project");
            const assignee = one(parsed, "assignee");
            const parent = one(parsed, "parent");
            const result = await writer.createIssue({
              teamId: team.id,
              title: title.trim(),
              ...(one(parsed, "description") ? { description: text(one(parsed, "description")!) } : {}),
              ...(one(parsed, "priority") ? { priority: r.priority(one(parsed, "priority")!) } : {}),
              ...(one(parsed, "state") ? { stateId: r.state(team, one(parsed, "state")!).id } : {}),
              ...(assignee && r.user(team, assignee) ? { assigneeId: r.user(team, assignee)! } : {}),
              ...(many(parsed, "label").length ? { labelIds: r.labels(team, many(parsed, "label")) } : {}),
              ...(projectId ? { projectId } : {}),
              ...(milestone && projectId ? { projectMilestoneId: (await milestoneId(projectId, milestone)) ?? undefined } : {}),
              ...(parent ? { parentId: (await deps.getIssue(parent)).id } : {}),
            });
            if (parsed.switches.has("link") && threadId) deps.storeLink(threadId, result.id, "manual");
            return done(json, result, `Created ${result.id}: ${result.url}${parsed.switches.has("link") && threadId ? "\nLinked this thread to it." : ""}`);
          }

          case "update": {
            known(parsed, ["title", "description", "priority", "state", "assignee", "add-label", "remove-label", "project", "milestone"]);
            if (!rest[0]) break;
            const issue = await deps.getIssue(rest[0]);
            const opts = await options();
            const r = resolver(opts);
            const team = opts.teams.find((candidate) => candidate.id === issue.team.id) ?? r.team(issue.team.key);
            const project = one(parsed, "project");
            const projectId = project === undefined ? undefined : r.project(project);
            const milestone = one(parsed, "milestone");
            const milestoneProject = projectId ?? issue.project?.id ?? null;
            if (milestone && milestone.toLowerCase() !== "none" && !milestoneProject) throw new Error("The issue has no project; pass --project too");
            const assignee = one(parsed, "assignee");
            const input = {
              id: issue.id,
              ...(one(parsed, "title") ? { title: one(parsed, "title")! } : {}),
              ...(one(parsed, "description") !== undefined ? { description: text(one(parsed, "description")!) } : {}),
              ...(one(parsed, "priority") ? { priority: r.priority(one(parsed, "priority")!) } : {}),
              ...(one(parsed, "state") ? { stateId: r.state(team, one(parsed, "state")!).id } : {}),
              ...(assignee !== undefined ? { assigneeId: r.user(team, assignee) } : {}),
              ...(many(parsed, "add-label").length ? { addedLabelIds: r.labels(team, many(parsed, "add-label")) } : {}),
              ...(many(parsed, "remove-label").length ? { removedLabelIds: r.labels(team, many(parsed, "remove-label")) } : {}),
              ...(projectId !== undefined ? { projectId } : {}),
              ...(milestone !== undefined ? { projectMilestoneId: milestoneProject ? await milestoneId(milestoneProject, milestone) : null } : {}),
            };
            if (Object.keys(input).length === 1) throw new Error("Nothing to update: pass at least one option");
            const result = await writer.updateIssue(input);
            return done(json, result, `Updated ${result.id}: ${result.url}`);
          }

          case "archive": {
            if (!rest[0]) break;
            const issue = await deps.getIssue(rest[0]);
            await writer.archiveIssue(issue.id);
            return done(json, { archived: issue.identifier }, `Archived ${issue.identifier}.`);
          }

          case "comment": {
            known(parsed, ["reply-to"]);
            const [id, ...body] = rest;
            if (!id || !body.length) break;
            const issue = await deps.getIssue(id);
            const result = await writer.createComment(issue.id, text(body.join(" ")), one(parsed, "reply-to") ?? null);
            return done(json, result, `Commented on ${issue.identifier}: ${result.url}`);
          }
          case "comment-edit": {
            const [id, ...body] = rest;
            if (!id || !body.length) break;
            await writer.updateComment(id, text(body.join(" ")));
            return done(json, { edited: id }, `Edited comment ${id}.`);
          }
          case "comment-delete": {
            if (!rest[0]) break;
            await writer.deleteComment(rest[0]);
            return done(json, { deleted: rest[0] }, `Deleted comment ${rest[0]}.`);
          }

          case "projects": {
            const filter = parsed.switches.has("all")
              ? null
              : {
                  and: [
                    { or: [{ lead: { isMe: { eq: true } } }, { members: { some: { isMe: { eq: true } } } }] },
                    { status: { type: { nin: ["completed", "canceled"] } } },
                  ],
                };
            const data = await deps.linear<{ projects: { nodes: Parameters<typeof flattenProject>[0][] } }>(PROJECTS_QUERY, { filter });
            const projects = data.projects.nodes.map(flattenProject);
            const lines = projects.map((p) => `${p.name}  [${p.status?.name ?? "—"} · ${p.health ?? "no health"} · ${Math.round(p.progress * 100)}%]  ${p.id}`);
            return done(json, projects, lines.join("\n") || "No projects.");
          }
          case "project": {
            if (!rest.length) break;
            const summary = await findProject(rest.join(" "));
            const data = await deps.linear<{ project: Parameters<typeof flattenProjectDetail>[0] }>(PROJECT_QUERY, { id: summary.id });
            const project = flattenProjectDetail(data.project);
            return done(json, project, formatProject(project));
          }

          case "project-create":
          case "project-edit": {
            known(parsed, ["name", "team", "description", "content", "lead", "status", "start", "target"]);
            const opts = await options();
            const r = resolver(opts);
            const date = (value: string | undefined) => (value === undefined ? undefined : value.toLowerCase() === "none" ? null : value);
            const lead = one(parsed, "lead");
            const fields = {
              ...(one(parsed, "name") ? { name: one(parsed, "name")! } : {}),
              ...(one(parsed, "description") !== undefined ? { description: text(one(parsed, "description")!) } : {}),
              ...(one(parsed, "content") !== undefined ? { content: text(one(parsed, "content")!) } : {}),
              ...(one(parsed, "status") ? { statusId: r.projectStatus(one(parsed, "status")!).id } : {}),
              ...(lead !== undefined ? { leadId: r.user(null, lead) } : {}),
              ...(date(one(parsed, "start")) !== undefined ? { startDate: date(one(parsed, "start")) } : {}),
              ...(date(one(parsed, "target")) !== undefined ? { targetDate: date(one(parsed, "target")) } : {}),
            };
            if (command === "project-create") {
              if (!fields.name) throw new Error("Pass --name");
              const teams = many(parsed, "team").length ? many(parsed, "team").map((key) => r.team(key)) : [r.team(undefined)];
              const result = await writer.createProject({ ...fields, name: fields.name, teamIds: teams.map((team) => team.id) });
              return done(json, result, `Created project ${result.label}: ${result.url}`);
            }
            if (!rest.length) break;
            if (Object.keys(fields).length === 0) throw new Error("Nothing to update: pass at least one option");
            const project = await findProject(rest.join(" "));
            const result = await writer.updateProject(project.id, fields);
            return done(json, result, `Updated project ${result.label}: ${result.url}`);
          }
          case "project-delete": {
            if (!rest.length) break;
            const project = await findProject(rest.join(" "));
            await writer.deleteProject(project.id);
            return done(json, { deleted: project.id }, `Moved project ${project.name} to the trash.`);
          }

          case "update-post": {
            known(parsed, ["health"]);
            const [projectName, ...body] = rest;
            const health = one(parsed, "health");
            if (!projectName || !body.length || !health) break;
            if (!["onTrack", "atRisk", "offTrack"].includes(health)) throw new Error("--health must be onTrack, atRisk or offTrack");
            const project = await findProject(projectName);
            const result = await writer.postUpdate(project.id, text(body.join(" ")), health);
            return done(json, result, `Posted an update on ${project.name}: ${result.url}`);
          }
          case "update-edit": {
            known(parsed, ["health"]);
            const [id, ...body] = rest;
            const health = one(parsed, "health");
            if (!id || (!body.length && !health)) break;
            if (health && !["onTrack", "atRisk", "offTrack"].includes(health)) throw new Error("--health must be onTrack, atRisk or offTrack");
            await writer.editUpdate(id, { ...(body.length ? { body: text(body.join(" ")) } : {}), ...(health ? { health } : {}) });
            return done(json, { edited: id }, `Edited update ${id}.`);
          }
          case "update-archive": {
            if (!rest[0]) break;
            await writer.archiveUpdate(rest[0]);
            return done(json, { archived: rest[0] }, `Archived update ${rest[0]}.`);
          }

          case "current":
          case "link":
          case "unlink": {
            if (threadId === undefined) return { exitCode: 1, stderr: `\`${command}\` only works from inside a BB thread.` };
            if (command === "link") {
              const identifier = rest[0]?.toUpperCase() ?? "";
              if (!IDENTIFIER_PATTERN.test(identifier)) break;
              deps.storeLink(threadId, identifier, "manual");
              return done(json, { linked: identifier }, `Linked this thread to ${identifier}.`);
            }
            if (command === "unlink") {
              deps.storeLink(threadId, null, "manual");
              return done(json, { linked: null }, "Unlinked this thread.");
            }
            const link = await deps.linkForThread(threadId);
            if (link === null) return { exitCode: 1, stderr: "This thread is not linked to a Linear issue." };
            const issue = await deps.getIssue(link.identifier);
            return done(json, { ...link, issue }, `Linked via ${link.source}.\n\n${formatIssueText(issue)}`);
          }
        }
      } catch (cause) {
        return { exitCode: 1, stderr: errorMessage(cause) };
      }
      return { exitCode: 1, stderr: USAGE };
    },
  };
  // A plugin gets exactly one CLI command, so the old `bb linear-issues`
  // name can't live on as an alias.
  bb.cli.register(cli);
}
