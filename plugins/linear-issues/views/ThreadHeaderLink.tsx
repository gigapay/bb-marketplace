import { useEffect, useRef, useState } from "react";
import { LINEAR_ICON } from "@/lib/plugin-id";
import { toast } from "sonner";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { issueIdentifierFromBranch } from "../shared/links";
import type { IssueSummary, rpcContract } from "../server";
import { SOURCE_LABELS, useIssueLinks } from "./links";
import { IssuePickerDialog } from "./pickers";
import { THREAD_PANEL_ACTION_ID, openLinearTarget } from "./ThreadLinearPanel";
import { parseLinearUrl } from "../shared/linear-url";
import { errorText } from "./shared";

export function ThreadHeaderLink({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const links = useIssueLinks();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [issue, setIssue] = useState<IssueSummary | null>(null);

  const link = links.byThread.get(threadId) ?? null;
  const thread = links.threads.find((candidate) => candidate.id === threadId);
  const branchMatch = issueIdentifierFromBranch(thread?.environment?.branchName, links.teamKeys);
  const hasStoredRow = links.rows.has(threadId);
  // Read inside the click handler without re-binding it on every change.
  const threadIssue = useRef<string | null>(null);
  threadIssue.current = link?.identifier ?? null;

  // A Linear issue or project link clicked anywhere in this thread (chat
  // messages, the side panel) opens in the side panel instead of the browser.
  // This header lives as long as the thread is shown, so it owns the listener;
  // capture runs before the host's own link handler. Cmd/Ctrl/Shift/Alt-click,
  // middle click and our explicit "Open in Linear" links still go to Linear.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("data-linear-external")) return;
      const target = parseLinearUrl(anchor.href);
      if (target === null) return;
      if (!openLinearTarget(navigate, target, threadIssue.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [navigate, threadId]);

  // Title and state for the chip and dialog; one small request per header.
  useEffect(() => {
    if (link === null) return setIssue(null);
    let cancelled = false;
    rpc.call("issues_by_identifiers", { identifiers: [link.identifier] }).then(
      (result) => !cancelled && setIssue(result.issues[0] ?? null),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, link?.identifier]);

  if (!links.ready) return null;

  const run = (promise: Promise<unknown>, message: string) => {
    promise.then(
      () => toast.success(message),
      (cause) => toast.error(errorText(cause)),
    );
  };

  if (link === null) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground"
          aria-label="Link a Linear issue"
          onClick={() => setPickerOpen(true)}
        >
          <Icon name={LINEAR_ICON} className="size-4" />
          {isCompactViewport ? null : <span>Link issue</span>}
        </Button>
        <IssuePickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={(picked) => {
            setPickerOpen(false);
            run(rpc.call("link_set", { threadId, identifier: picked.identifier }), `Linked to ${picked.identifier}`);
          }}
        />
      </>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2"
        aria-label={`Linear issue ${link.identifier}`}
        onClick={() => {
          // The side-panel tab holds the ticket and its actions; the dialog
          // only covers surfaces without a thread side panel.
          const opened = navigate.openThreadPanel({ actionId: THREAD_PANEL_ACTION_ID, title: link.identifier });
          if (!opened) setMenuOpen(true);
        }}
      >
        <Icon name={LINEAR_ICON} className="size-3.5 text-[#5E6AD2]" />
        <span className="font-mono text-xs">{link.identifier}</span>
      </Button>

      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {link.identifier}
              {issue ? `: ${issue.title}` : ""}
            </DialogTitle>
            <DialogDescription>
              {SOURCE_LABELS[link.source]}
              {link.source === "branch" && thread?.environment?.branchName
                ? ` (${thread.environment.branchName})`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                setMenuOpen(false);
                navigate.toPluginPanel("issues", { subPath: link.identifier });
              }}
            >
              <Icon name={LINEAR_ICON} className="size-4" />
              Open issue
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMenuOpen(false);
                setPickerOpen(true);
              }}
            >
              <Icon name="Search" className="size-4" />
              Change
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setMenuOpen(false);
                run(rpc.call("link_set", { threadId, identifier: null }), "Unlinked");
              }}
            >
              <Icon name="X" className="size-4" />
              Unlink
            </Button>
            {hasStoredRow && branchMatch !== null && branchMatch !== link.identifier ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMenuOpen(false);
                  run(rpc.call("link_reset", { threadId }), `Back to ${branchMatch} from the branch`);
                }}
              >
                Use branch ({branchMatch})
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <IssuePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(picked) => {
          setPickerOpen(false);
          run(rpc.call("link_set", { threadId, identifier: picked.identifier }), `Linked to ${picked.identifier}`);
        }}
      />
    </>
  );
}
