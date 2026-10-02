// Linear initiatives: the list, and one initiative with its description,
// links, updates, sub-initiatives and projects.
import { z } from "zod";
import { PROJECT_SUMMARY_FIELDS, flattenProject, projectHealthSchema, projectSummarySchema } from "./projects.js";

export const initiativeStatusSchema = z.enum(["Proposed", "Planned", "Active", "Completed", "Canceled"]);

export const initiativeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  url: z.string(),
  status: initiativeStatusSchema,
  health: projectHealthSchema,
  priority: z.number(),
  targetDate: z.string().nullable(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  parent: z.object({ id: z.string(), name: z.string() }).nullable(),
  // Linear shows an initiative's progress as the mean of its projects'.
  progress: z.number().nullable(),
  projectCount: z.number(),
  lastUpdateAt: z.string().nullable(),
});
export type InitiativeSummary = z.infer<typeof initiativeSummarySchema>;

const initiativeUpdateSchema = z.object({
  id: z.string(),
  body: z.string(),
  health: projectHealthSchema,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  url: z.string(),
  author: z.string(),
  authorId: z.string().nullable(),
});

export const initiativeDetailSchema = initiativeSummarySchema.extend({
  content: z.string().nullable(),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  updates: z.array(initiativeUpdateSchema),
  subInitiatives: z.array(initiativeSummarySchema.pick({ id: true, name: true, status: true, health: true, targetDate: true, owner: true })),
  projects: z.array(projectSummarySchema),
});
export type InitiativeDetail = z.infer<typeof initiativeDetailSchema>;

const BASE_FIELDS = `
  id name description icon color url status health priority targetDate
  owner { id name }
  parent: parentInitiative { id name }
  lastUpdate { createdAt }
`;
// Kept small on purpose: initiatives × projects multiplies, and Linear
// rejects queries past its complexity budget (as it did for write options).
const SUMMARY_FIELDS = `${BASE_FIELDS} projects(first: 50) { nodes { progress } }`;

export const INITIATIVES_QUERY = `query Initiatives($filter: InitiativeFilter) {
  initiatives(first: 50, filter: $filter, orderBy: updatedAt) { nodes { ${SUMMARY_FIELDS} } }
}`;

export const INITIATIVE_QUERY = `query Initiative($id: String!) {
  initiative(id: $id) {
    ${BASE_FIELDS}
    content
    links(first: 50) { nodes { label url } }
    initiativeUpdates(first: 30) { nodes { id body health createdAt editedAt url user { id name } } }
    subInitiatives(first: 50) { nodes { id name status health targetDate owner { id name } } }
    projects(first: 50) { nodes { ${PROJECT_SUMMARY_FIELDS} } }
  }
}`;

type RawSummary = Omit<InitiativeSummary, "progress" | "projectCount" | "lastUpdateAt"> & {
  lastUpdate: { createdAt: string } | null;
  projects: { nodes: { progress: number }[] };
};

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

export function flattenInitiative(raw: RawSummary): InitiativeSummary {
  const { lastUpdate, projects, ...rest } = raw;
  return {
    ...rest,
    progress: mean(projects.nodes.map((project) => project.progress)),
    projectCount: projects.nodes.length,
    lastUpdateAt: lastUpdate?.createdAt ?? null,
  };
}

type RawDetail = Omit<RawSummary, "projects"> & {
  content: string | null;
  links: { nodes: { label: string; url: string }[] };
  initiativeUpdates: {
    nodes: { id: string; body: string; health: InitiativeDetail["health"]; createdAt: string; editedAt: string | null; url: string; user: { id: string; name: string } | null }[];
  };
  subInitiatives: { nodes: InitiativeDetail["subInitiatives"] };
  projects: { nodes: Parameters<typeof flattenProject>[0][] };
};

export function flattenInitiativeDetail(raw: RawDetail): InitiativeDetail {
  const projects = raw.projects.nodes.map(flattenProject);
  const summary = flattenInitiative({ ...raw, projects: { nodes: projects.map((project) => ({ progress: project.progress })) } });
  return {
    ...summary,
    content: raw.content,
    links: raw.links.nodes,
    updates: raw.initiativeUpdates.nodes
      .map((update) => ({
        id: update.id,
        body: update.body,
        health: update.health,
        createdAt: update.createdAt,
        editedAt: update.editedAt,
        url: update.url,
        author: update.user?.name ?? "Unknown",
        authorId: update.user?.id ?? null,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    subInitiatives: raw.subInitiatives.nodes,
    projects,
  };
}
