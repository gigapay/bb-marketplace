import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Icon } from "@/components/ui/icon";
import type { IssueSummary, rpcContract } from "../server";
import { LINKS_CHANGED } from "../shared/links";
import { SOURCE_LABELS, useIssueLinks } from "./links";
import { PriorityIcon, StateIcon } from "./shared";
import type { LinkSource } from "../shared/links";

// The sidebar belongs to BB's thread-list plugin, which has no extension point
// for rows. We portal a small badge into its row nodes. React tolerates extra
// trailing children, and if BB changes its markup the badge just stops
// showing. The wrapper carries the plugin scope so our Tailwind classes apply.
const MARKER = "data-linear-issues-badge";

type Target = { element: Element; identifier: string; source: LinkSource };

function environmentHeaderLabels(name: string): Element[] {
  const quoted = CSS.escape(name);
  return [
    ...document.querySelectorAll(
      `button[aria-label="Collapse ${quoted} threads"], button[aria-label="Expand ${quoted} threads"]`,
    ),
  ].flatMap((chevron) => (chevron.parentElement ? [chevron.parentElement] : []));
}

function threadTitleContainer(threadId: string): Element | null {
  const anchor = document.querySelector(`a[data-sidebar-thread-id="${CSS.escape(threadId)}"]`);
  return anchor?.nextElementSibling ?? null;
}

function sameTargets(a: Target[], b: Target[]): boolean {
  return a.length === b.length && a.every((t, i) => t.element === b[i]!.element && t.identifier === b[i]!.identifier);
}

/** App-wide, renders only portals: keeps a Linear badge on sidebar rows. */
export function SidebarDecorator() {
  const rpc = useRpc<typeof rpcContract>();
  const links = useIssueLinks();
  const [targets, setTargets] = useState<Target[]>([]);
  const [issues, setIssues] = useState<ReadonlyMap<string, IssueSummary>>(new Map());

  useEffect(() => {
    // One badge per worktree when every thread in it agrees; threads outside a
    // worktree (or whose group isn't rendered) get their own.
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

    const compute = (): Target[] => {
      const found: Target[] = [];
      const threadBadges = new Map(loose);
      for (const entry of environments.values()) {
        const headers = entry.identifiers.size === 1 ? environmentHeaderLabels(entry.label) : [];
        if (headers.length > 0) {
          const [identifier] = entry.identifiers;
          const source = links.byThread.get(entry.threadIds[0]!)!.source;
          for (const element of headers) found.push({ element, identifier: identifier!, source });
        } else {
          for (const id of entry.threadIds) threadBadges.set(id, links.byThread.get(id)!.identifier);
        }
      }
      for (const [threadId, identifier] of threadBadges) {
        const element = threadTitleContainer(threadId);
        if (element) found.push({ element, identifier, source: links.byThread.get(threadId)!.source });
      }
      return found;
    };

    let frame = 0;
    const apply = () => {
      frame = 0;
      const next = compute();
      setTargets((current) => (sameTargets(current, next) ? current : next));
    };
    apply();
    // Rows mount and unmount as the list virtualizes or regroups. Our own
    // badge insertions re-trigger this once, then compute() is stable.
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [links.threads, links.byThread]);

  // Popover data for every badged issue, in one request.
  const identifiersKey = useMemo(
    () => [...new Set(targets.map((target) => target.identifier))].sort().join(","),
    [targets],
  );
  const [refreshNonce, setRefreshNonce] = useState(0);
  useRealtime(LINKS_CHANGED, () => setRefreshNonce((n) => n + 1));
  useEffect(() => {
    if (identifiersKey === "") return;
    let cancelled = false;
    rpc.call("issues_by_identifiers", { identifiers: identifiersKey.split(",").slice(0, 100) }).then(
      (result) => !cancelled && setIssues(new Map(result.issues.map((issue) => [issue.identifier, issue]))),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, identifiersKey, refreshNonce]);

  return (
    <>
      {targets.map((target) =>
        createPortal(
          <SidebarBadge identifier={target.identifier} source={target.source} issue={issues.get(target.identifier)} />,
          target.element,
          `${target.identifier}:${targets.indexOf(target)}`,
        ),
      )}
    </>
  );
}

function SidebarBadge({
  identifier,
  source,
  issue,
}: {
  identifier: string;
  source: LinkSource;
  issue: IssueSummary | undefined;
}) {
  const navigate = useBbNavigate();
  return (
    <span
      data-bb-plugin-root=""
      data-bb-plugin="linear-issues"
      {...{ [MARKER]: "" }}
      className="pointer-events-auto relative z-[31] ml-1.5 inline-flex shrink-0 items-center"
    >
      <HoverCard openDelay={250} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={issue ? `${identifier}: ${issue.title}` : `Linear issue ${identifier}`}
            className="inline-flex size-4 items-center justify-center rounded-sm text-[#5E6AD2] hover:bg-accent"
            onClick={(event) => {
              // The row's own link sits underneath; this click is ours.
              event.preventDefault();
              event.stopPropagation();
              navigate.toPluginPanel("issues", { subPath: identifier });
            }}
          >
            <Icon name="linear-issues/linear" className="size-3.5" />
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" className="w-72 p-3">
          <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <Icon name="linear-issues/linear" className="size-3 text-[#5E6AD2]" />
            {identifier}
          </p>
          {issue ? (
            <>
              <p className="mt-1 text-sm font-medium leading-snug">{issue.title}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <StateIcon state={issue.state} />
                  {issue.state.name}
                </span>
                <span className="inline-flex items-center gap-1">
                  <PriorityIcon priority={issue.priority} label={issue.priorityLabel} />
                  {issue.priorityLabel}
                </span>
                {issue.assignee ? <span>{issue.assignee.name}</span> : null}
              </div>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">{SOURCE_LABELS[source]}</p>
        </HoverCardContent>
      </HoverCard>
    </span>
  );
}
