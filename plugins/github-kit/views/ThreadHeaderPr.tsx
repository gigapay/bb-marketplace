// Thread header chip: "PR #123" with its state when the thread has a PR,
// "Link PR" otherwise. Both open the Pull request tab, where linking lives.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { parsePrKey } from "../shared/pr-ref";
import { PrGlyphIcon } from "./icons";
import { prState } from "./shared";
import { THREAD_PANEL_ACTION_ID } from "./ThreadPrPanel";
import { usePrDetail, useThreadPrKey } from "./useThreadPr";

const STATE_CLASS = {
  open: "text-emerald-500",
  draft: "text-muted-foreground",
  merged: "text-purple-500 dark:text-purple-400",
  closed: "text-muted-foreground",
} as const;

export function ThreadHeaderPr({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const state = useThreadPrKey(threadId);
  const key = state.status === "found" ? state.key : null;
  const { detail } = usePrDetail(key);
  if (state.status === "loading" || state.status === "error") return null;

  const open = (title: string) => navigate.openThreadPanel({ actionId: THREAD_PANEL_ACTION_ID, title });

  if (key === null) {
    return (
      <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-muted-foreground" aria-label="Link a pull request" onClick={() => open("Pull request")}>
        <Icon name="github-kit/github" className="size-3.5" />
        {isCompactViewport ? null : <span>Link PR</span>}
      </Button>
    );
  }
  const number = parsePrKey(key)?.number;
  const kind = detail ? prState(detail) : "open";
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2"
      aria-label={`Pull request ${key}${detail ? `: ${detail.title}` : ""}`}
      onClick={() => open(`PR #${number}`)}
    >
      <span className={cn("inline-flex", STATE_CLASS[kind])}>
        <PrGlyphIcon kind={kind} label={kind} />
      </span>
      <span className="font-mono text-xs">#{number}</span>
    </Button>
  );
}
