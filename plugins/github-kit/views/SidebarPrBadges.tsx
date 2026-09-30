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
import { cn } from "@/lib/utils";
import { parsePrUrl } from "../shared/pr-ref";
import { PrGlyphIcon, type PrGlyph } from "./icons";

const MARKER = "data-github-kit-pr-badge";

type Target = { element: Element; threadId: string };

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
  return a.length === b.length && a.every((t, i) => t.element === b[i]!.element && t.threadId === b[i]!.threadId);
}

export function SidebarPrBadges() {
  const { threads } = useSidebarThreads();
  const [targets, setTargets] = useState<Target[]>([]);

  // One lookup per worktree (threads in it share the branch); a thread that
  // isn't in a worktree group gets its own badge.
  const groups = useMemo(() => {
    const byEnvironment = new Map<string, { label: string; threadId: string }>();
    const loose: string[] = [];
    for (const thread of threads) {
      const environment = thread.environment;
      if (thread.isHidden || !environment?.branchName) continue;
      const label = environment.name ?? environment.branchName;
      if (environment.isWorktree && environment.id && label) {
        if (!byEnvironment.has(environment.id)) byEnvironment.set(environment.id, { label, threadId: thread.id });
      } else {
        loose.push(thread.id);
      }
    }
    return { byEnvironment, loose };
  }, [threads]);

  useEffect(() => {
    const compute = (): Target[] => {
      const found: Target[] = [];
      for (const { label, threadId } of groups.byEnvironment.values()) {
        for (const element of environmentHeaderLabels(label)) found.push({ element, threadId });
      }
      for (const threadId of groups.loose) {
        const element = threadTitleContainer(threadId);
        if (element) found.push({ element, threadId });
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

  return <>{targets.map((target, index) => createPortal(<PrBadge threadId={target.threadId} />, target.element, `${target.threadId}:${index}`))}</>;
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
      if (pr.attention === "checks_failed") return { glyph: "open", className: "text-rose-500/85", label: "Open, checks failing" };
      if (pr.attention === "checks_pending") return { glyph: "open", className: "text-amber-500/85", label: "Open, checks running" };
      if (pr.attention === "conflicts") return { glyph: "open", className: "text-rose-500/85", label: "Open, has conflicts" };
      return { glyph: "open", className: "text-emerald-500/80", label: pr.attention === "ready_to_merge" ? "Ready to merge" : "Open" };
  }
}

function PrBadge({ threadId }: { threadId: string }) {
  const { pullRequest } = useThreadPullRequest(threadId);
  const navigate = useBbNavigate();
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
      <button
        type="button"
        title={`PR #${pullRequest.number} · ${style.label}\n${pullRequest.title}`}
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
    </span>
  );
}
