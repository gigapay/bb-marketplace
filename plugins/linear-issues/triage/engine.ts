// Turns Jev's answers into reviewable proposals. Code owns every decision
// rule; Jev only answers the questions in criteria.ts.
import type { Questions } from "@typesafe-ai/sdk";
import {
  AREA_LABELS,
  PRIORITY_VALUES,
  THRESHOLDS,
  TYPE_LABELS,
  areaQuestion,
  priorityQuestion,
  projectQuestion,
  readinessQuestion,
  typeQuestion,
  type PriorityChoice,
} from "./criteria.js";

export interface TriageIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  state: string;
  labels: { id: string; name: string }[];
  project: { id: string; name: string } | null;
  comments: string[];
}

export interface TriageContext {
  labels: { id: string; name: string }[];
  projects: { id: string; name: string; description: string | null }[];
  guidelines: string;
}

export type TriageChange =
  | { kind: "priority"; value: number; label: string; currentLabel: string; confidence: number; preselected: boolean }
  | { kind: "label"; labelId: string; label: string; group: "type" | "area"; confidence: number; preselected: boolean }
  | { kind: "project"; projectId: string; label: string; confidence: number; preselected: boolean };

export interface TriageProposal {
  issueId: string;
  identifier: string;
  title: string;
  changes: TriageChange[];
  /** Probability an engineer could start without more information. */
  readiness: number | null;
  needsInfo: boolean;
}

/** The subset of the SDK client the engine needs, so tests can fake it. */
export interface JevClient {
  systemOne(request: { state: unknown; questions: Questions }): PromiseLike<{
    answers: Record<string, { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>;
  }>;
}

const DESCRIPTION_LIMIT = 6_000;
const COMMENT_LIMIT = 800;

const PRIORITY_LABELS: Record<number, string> = { 0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

function byName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name.toLowerCase(), item]));
}

/** Project choice keys must be stable and unique; names can collide. */
function projectKey(index: number): string {
  return `project_${index}`;
}

export async function triageIssue(jev: JevClient, issue: TriageIssue, context: TriageContext): Promise<TriageProposal> {
  const workspaceLabels = byName(context.labels);
  const issueLabels = new Set(issue.labels.map((label) => label.name.toLowerCase()));

  // Only ask about labels that exist in this workspace.
  const typeLabels = Object.entries(TYPE_LABELS).filter(([name]) => workspaceLabels.has(name.toLowerCase()));
  const areaLabels = Object.entries(AREA_LABELS).filter(([name]) => workspaceLabels.has(name.toLowerCase()));
  const hasType = typeLabels.some(([name]) => issueLabels.has(name.toLowerCase()));
  const askProject = issue.project === null && context.projects.length > 0;

  const state = {
    issue: {
      identifier: issue.identifier,
      title: issue.title,
      description: (issue.description ?? "").slice(0, DESCRIPTION_LIMIT) || null,
      current_state: issue.state,
      current_priority: issue.priorityLabel,
      current_labels: issue.labels.map((label) => label.name),
      recent_comments: issue.comments.slice(-5).map((body) => body.slice(0, COMMENT_LIMIT)),
    },
    team: {
      ...(context.guidelines.trim() ? { guidelines: context.guidelines.trim().slice(0, 4_000) } : {}),
      ...(askProject
        ? {
            projects: context.projects.map((project, index) => ({
              key: projectKey(index),
              name: project.name,
              description: project.description?.slice(0, 400) ?? null,
            })),
          }
        : {}),
    },
  };

  const questions: Questions = { priority: priorityQuestion(), ready: readinessQuestion() };
  if (!hasType && typeLabels.length >= 2) questions.type = typeQuestion(Object.fromEntries(typeLabels));
  for (const [name, description] of areaLabels) {
    if (!issueLabels.has(name.toLowerCase())) questions[`area_${name}`] = areaQuestion(name, description);
  }
  if (askProject) {
    questions.project = projectQuestion(
      Object.fromEntries(context.projects.map((project, index) => [projectKey(index), `${project.name}${project.description ? `: ${project.description.slice(0, 300)}` : ""}`])),
    );
  }

  const { answers } = await jev.systemOne({ state, questions });
  const changes: TriageChange[] = [];

  const priority = answers.priority;
  if (priority?.choice && priority.confidence !== undefined && priority.choice in PRIORITY_VALUES) {
    const value = PRIORITY_VALUES[priority.choice as PriorityChoice];
    if (value !== issue.priority && priority.confidence >= THRESHOLDS.priority.propose) {
      changes.push({
        kind: "priority",
        value,
        label: PRIORITY_LABELS[value]!,
        currentLabel: issue.priorityLabel,
        confidence: priority.confidence,
        preselected: priority.confidence >= THRESHOLDS.priority.preselect,
      });
    }
  }

  const type = answers.type;
  if (type?.choice && type.confidence !== undefined && type.confidence >= THRESHOLDS.type.propose) {
    const label = workspaceLabels.get(type.choice.toLowerCase());
    if (label) {
      changes.push({
        kind: "label",
        labelId: label.id,
        label: label.name,
        group: "type",
        confidence: type.confidence,
        preselected: type.confidence >= THRESHOLDS.type.preselect,
      });
    }
  }

  for (const [name] of areaLabels) {
    const answer = answers[`area_${name}`];
    const label = workspaceLabels.get(name.toLowerCase());
    if (answer?.noul === undefined || !label || answer.noul < THRESHOLDS.area.propose) continue;
    changes.push({
      kind: "label",
      labelId: label.id,
      label: label.name,
      group: "area",
      confidence: answer.noul,
      preselected: answer.noul >= THRESHOLDS.area.preselect,
    });
  }

  const project = answers.project;
  if (project?.choice && project.choice !== "none" && project.confidence !== undefined) {
    const index = Number(project.choice.replace("project_", ""));
    const target = context.projects[index];
    if (target && project.confidence >= THRESHOLDS.project.propose) {
      changes.push({
        kind: "project",
        projectId: target.id,
        label: target.name,
        confidence: project.confidence,
        preselected: project.confidence >= THRESHOLDS.project.preselect,
      });
    }
  }

  const readiness = answers.ready?.noul ?? null;
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    changes,
    readiness,
    needsInfo: readiness !== null && readiness < THRESHOLDS.readyWarning,
  };
}
