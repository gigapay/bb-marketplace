// Recognizes links to Linear issues and projects so the plugin can open them
// in BB (thread side panel or the Linear page) instead of the browser.

export type LinearTarget = { kind: "issue"; identifier: string } | { kind: "project"; id: string };

const ISSUE_PATH = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?:\/|$)/;
// Project URLs end their slug with the project's slugId: `my-project-8bb10d790123`.
const PROJECT_PATH = /^\/[^/]+\/project\/(?:[^/]*-)?([0-9a-f]{8,})(?:\/|$)/i;

export function parseLinearUrl(href: string): LinearTarget | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app") return null;
  const issue = ISSUE_PATH.exec(url.pathname);
  if (issue) return { kind: "issue", identifier: issue[1]!.toUpperCase() };
  const project = PROJECT_PATH.exec(url.pathname);
  if (project) return { kind: "project", id: project[1]!.toLowerCase() };
  return null;
}

/** Thread-panel params, validated: they come back from persistence as plain JSON. */
export function readPanelTarget(params: unknown): LinearTarget | null {
  if (typeof params !== "object" || params === null) return null;
  const value = params as { kind?: unknown; identifier?: unknown; id?: unknown };
  if (value.kind === "issue" && typeof value.identifier === "string") return { kind: "issue", identifier: value.identifier };
  if (value.kind === "project" && typeof value.id === "string") return { kind: "project", id: value.id };
  return null;
}
