import { useEffect } from "react";
import { useIssueLinks } from "./links";

// The sidebar belongs to BB's thread-list plugin, which has no extension point
// for rows. We only set a data attribute on its nodes and draw the badge with
// CSS, so React never sees a foreign child. If BB changes its markup the badge
// just disappears; nothing breaks.
const ATTRIBUTE = "data-linear-issue";
const STYLE_ID = "linear-issues-sidebar-badges";

const LINEAR_MARK =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#5E6AD2"><path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>',
  );

const CSS_RULES = `
[${ATTRIBUTE}]::after {
  content: attr(${ATTRIBUTE});
  flex-shrink: 0;
  margin-left: 6px;
  padding-left: 15px;
  background: url("${LINEAR_MARK}") no-repeat left center / 11px 11px;
  font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted-foreground, currentColor);
  white-space: nowrap;
}`;

function environmentHeaderLabels(name: string): Element[] {
  const quoted = CSS.escape(name);
  return [...document.querySelectorAll(
    `button[aria-label="Collapse ${quoted} threads"], button[aria-label="Expand ${quoted} threads"]`,
  )].flatMap((chevron) => (chevron.parentElement ? [chevron.parentElement] : []));
}

function threadTitleContainer(threadId: string): Element | null {
  const anchor = document.querySelector(`a[data-sidebar-thread-id="${CSS.escape(threadId)}"]`);
  return anchor?.nextElementSibling ?? null;
}

/** App-wide, renders nothing: keeps Linear badges on the sidebar rows. */
export function SidebarDecorator() {
  const links = useIssueLinks();

  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_RULES;
    document.head.append(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    // One badge per worktree when every linked thread in it agrees; threads
    // outside a worktree (or whose group isn't rendered) get their own.
    const environments = new Map<string, { label: string; identifiers: Set<string>; threadIds: string[] }>();
    const loose = new Map<string, string>();
    for (const thread of links.threads) {
      const link = links.byThread.get(thread.id);
      if (!link) continue;
      const environment = thread.environment;
      const label = environment?.name ?? environment?.branchName ?? null;
      if (environment?.id && label && environment.isWorktree) {
        const entry = environments.get(environment.id) ?? { label, identifiers: new Set(), threadIds: [] };
        entry.identifiers.add(link.identifier);
        entry.threadIds.push(thread.id);
        environments.set(environment.id, entry);
      } else {
        loose.set(thread.id, link.identifier);
      }
    }

    const apply = () => {
      const wanted = new Map<Element, string>();
      const threadBadges = new Map(loose);
      for (const entry of environments.values()) {
        const headers = entry.identifiers.size === 1 ? environmentHeaderLabels(entry.label) : [];
        if (headers.length > 0) {
          const [identifier] = entry.identifiers;
          for (const header of headers) wanted.set(header, identifier!);
        } else {
          for (const threadId of entry.threadIds) threadBadges.set(threadId, links.byThread.get(threadId)!.identifier);
        }
      }
      for (const [threadId, identifier] of threadBadges) {
        const container = threadTitleContainer(threadId);
        if (container) wanted.set(container, identifier);
      }
      for (const element of document.querySelectorAll(`[${ATTRIBUTE}]`)) {
        if (!wanted.has(element)) element.removeAttribute(ATTRIBUTE);
      }
      for (const [element, identifier] of wanted) {
        if (element.getAttribute(ATTRIBUTE) !== identifier) element.setAttribute(ATTRIBUTE, identifier);
      }
    };

    let frame = 0;
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(() => ((frame = 0), apply()));
    };
    apply();
    // Rows mount and unmount as the list virtualizes or regroups. Attribute
    // writes don't trigger childList mutations, so this can't loop.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      for (const element of document.querySelectorAll(`[${ATTRIBUTE}]`)) element.removeAttribute(ATTRIBUTE);
    };
  }, [links.threads, links.byThread]);

  return null;
}
