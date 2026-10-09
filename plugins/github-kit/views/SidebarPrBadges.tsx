// A PR state badge on sidebar rows, next to the Linear badge: a purple merge
// icon once merged, muted for closed or draft, and green / amber / red for an
// open PR depending on its checks, like Orca's worktree cards.
//
// BB's sidebar has no extension point for rows, so this portals into its row
// nodes the same way the Linear plugin does. If BB changes that markup the
// badge just stops showing.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  experimental_useSidebarThreadPullRequest as useThreadPullRequest,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { parsePrUrl } from "../shared/pr-ref";
import { PrGlyphIcon, type PrGlyph } from "./icons";

const MARKER = "data-github-kit-pr-badge";

// element hosts the badge; dim is what greys out once the PR is merged (the
// worktree header and its thread titles, or the single thread's title).
type Target = { element: Element; threadId: string; dim: Element[] };

function environmentHeaderLabels(name: string): Element[] {
  const quoted = CSS.escape(name);
  return [
    ...document.querySelectorAll(`button[aria-label="Collapse ${quoted} threads"], button[aria-label="Expand ${quoted} threads"]`),
  ].flatMap((chevron) => (chevron.parentElement ? [chevron.parentElement] : []));
}

function threadTitleContainer(threadId: string): Element | null {
  return document.querySelector(`a[data-sidebar-thread-id="${CSS.escape(threadId)}"]`)?.nextElementSibling ?? null;
}

function sameTargets(a: Target[], b: Target[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (t, i) =>
        t.element === b[i]!.element &&
        t.threadId === b[i]!.threadId &&
        t.dim.length === b[i]!.dim.length &&
        t.dim.every((element, j) => element === b[i]!.dim[j]),
    )
  );
}

const DIMMED = "data-github-kit-merged";

/**
 * Greys out a row's title once its PR is merged, so it reads as done and safe
 * to archive. Plugin badges inside the row (ours, Linear's) keep full colour.
 * Elements are BB's; the attribute marks what we touched so cleanup only
 * undoes our own change.
 */
function dimElements(elements: Element[]): () => void {
  const touched: HTMLElement[] = [];
  for (const container of elements) {
    const hasText = [...container.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    const targets = hasText
      ? [container]
      : [...container.children].filter((child) => !child.hasAttribute("data-bb-plugin") && !child.querySelector("[data-bb-plugin]"));
    for (const target of targets) {
      if (!(target instanceof HTMLElement) || target.hasAttribute(DIMMED)) continue;
      target.setAttribute(DIMMED, "");
      target.style.opacity = "0.45";
      touched.push(target);
    }
  }
  return () => {
    for (const target of touched) {
      target.removeAttribute(DIMMED);
      target.style.removeProperty("opacity");
    }
  };
}

export function SidebarPrBadges() {
  const { threads } = useSidebarThreads();
  const [targets, setTargets] = useState<Target[]>([]);

  // One lookup per worktree (threads in it share the branch); a thread that
  // isn't in a worktree group gets its own badge.
  const groups = useMemo(() => {
    const byEnvironment = new Map<string, { label: string; threadIds: string[] }>();
    const loose: string[] = [];
    for (const thread of threads) {
      const environment = thread.environment;
      if (thread.isHidden || !environment?.branchName) continue;
      const label = environment.name ?? environment.branchName;
      if (environment.isWorktree && environment.id && label) {
        const entry = byEnvironment.get(environment.id) ?? { label, threadIds: [] };
        entry.threadIds.push(thread.id);
        byEnvironment.set(environment.id, entry);
      } else {
        loose.push(thread.id);
      }
    }
    return { byEnvironment, loose };
  }, [threads]);

  useEffect(() => {
    const compute = (): Target[] => {
      const found: Target[] = [];
      const rowsOf = (ids: string[]) => ids.flatMap((id) => threadTitleContainer(id) ?? []);
      for (const { label, threadIds } of groups.byEnvironment.values()) {
        const headers = environmentHeaderLabels(label);
        if (headers.length > 0) {
          // A worktree with several threads is a collapsible group: one badge on its header.
          for (const element of headers) found.push({ element, threadId: threadIds[0]!, dim: [element, ...rowsOf(threadIds)] });
        } else {
          // A worktree with a single thread shows as a plain row, with no header.
          for (const threadId of threadIds) {
            const element = threadTitleContainer(threadId);
            if (element) found.push({ element, threadId, dim: [element] });
          }
        }
      }
      for (const threadId of groups.loose) {
        const element = threadTitleContainer(threadId);
        if (element) found.push({ element, threadId, dim: [element] });
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
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [groups]);

  return (
    <>
      {targets.map((target, index) =>
        createPortal(<PrBadge threadId={target.threadId} dim={target.dim} />, target.element, `${target.threadId}:${index}`),
      )}
    </>
  );
}

function presentation(pr: PluginSidebarPullRequest): { glyph: PrGlyph; className: string; label: string } {
  switch (pr.state) {
    case "merged":
      return { glyph: "merged", className: "text-purple-600/80 dark:text-purple-400/80", label: "Merged" };
    case "closed":
      return { glyph: "closed", className: "text-muted-foreground/70", label: "Closed" };
    case "draft":
      return { glyph: "draft", className: "text-muted-foreground/60", label: "Draft" };
    default:
      // An open PR is always green: red read as "closed" at sidebar size.
      // What it's waiting on (checks, conflicts…) lives in the hover card.
      return { glyph: "open", className: "text-emerald-500/85", label: ATTENTION_LABEL[pr.attention] ? `Open, ${ATTENTION_LABEL[pr.attention]!.toLowerCase()}` : "Open" };
  }
}

const STATE_LABEL: Record<PluginSidebarPullRequest["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

// What needs doing next; states that repeat the PR state stay blank.
const ATTENTION_LABEL: Record<PluginSidebarPullRequest["attention"], string | null> = {
  blocked: "Blocked",
  changes_requested: "Changes requested",
  checks_failed: "Checks failing",
  checks_pending: "Checks running",
  closed: null,
  conflicts: "Has conflicts",
  draft: null,
  merged: null,
  none: null,
  ready_to_merge: "Ready to merge",
  review_requested: "Review requested",
};

function PrBadge({ threadId, dim }: { threadId: string; dim: Element[] }) {
  const { pullRequest } = useThreadPullRequest(threadId);
  const navigate = useBbNavigate();
  const merged = pullRequest?.state === "merged";
  useEffect(() => (merged ? dimElements(dim) : undefined), [merged, dim]);
  if (pullRequest === null) return null;
  const style = presentation(pullRequest);
  const ref = parsePrUrl(pullRequest.url);
  return (
    <span
      data-bb-plugin-root=""
      data-bb-plugin="github-kit"
      {...{ [MARKER]: "" }}
      className="pointer-events-auto relative z-[31] ml-1.5 inline-flex shrink-0 items-center"
    >
      <HoverCard openDelay={250} closeDelay={100}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            aria-label={`Pull request #${pullRequest.number}: ${style.label}`}
            className={cn("inline-flex size-4 items-center justify-center rounded-sm hover:bg-accent", style.className)}
            onClick={(event) => {
              // The row's own link sits underneath; this click is ours.
              event.preventDefault();
              event.stopPropagation();
              if (ref) navigate.toPluginPanel("pulls", { subPath: `${ref.owner}/${ref.name}/${ref.number}` });
            }}
          >
            <span className="inline-flex scale-[0.85]">
              <PrGlyphIcon kind={style.glyph} label={style.label} />
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent side="right" align="start" className="w-72 p-3">
          <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className={cn("inline-flex scale-75", style.className)}>
              <PrGlyphIcon kind={style.glyph} label={style.label} />
            </span>
            {ref ? `${ref.owner}/${ref.name}#${ref.number}` : `#${pullRequest.number}`}
          </p>
          <p className="mt-1 text-sm font-medium leading-snug">{pullRequest.title}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1.5", style.className)}>
              <span className="inline-flex scale-75">
                <PrGlyphIcon kind={style.glyph} label={style.label} />
              </span>
              {STATE_LABEL[pullRequest.state]}
            </span>
            {ATTENTION_LABEL[pullRequest.attention] ? <span>{ATTENTION_LABEL[pullRequest.attention]}</span> : null}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Click to open the pull request</p>
        </HoverCardContent>
      </HoverCard>
    </span>
  );
}
