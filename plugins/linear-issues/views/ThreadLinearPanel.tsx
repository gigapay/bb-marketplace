import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Markdown, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { LinearMarkdown } from "./LinearMarkdown";
import type { IssueDetail, rpcContract } from "../server";
import { issueIdentifierFromBranch } from "../shared/links";
import { SOURCE_LABELS, useIssueLinks } from "./links";
import { CommentThreads } from "./Comments";
import { IssuePickerDialog } from "./pickers";
import { EmptyState, ErrorLine, LabelChip, PriorityIcon, StateIcon, errorText } from "./shared";

export const THREAD_PANEL_ACTION_ID = "linear-issue";

/**
 * The thread side-panel tab. BB always lists it in the panel launcher, so
 * it follows the thread's link live: the ticket when linked, a picker when not.
 */
export function ThreadLinearPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const links = useIssueLinks();
  const [pickerOpen, setPickerOpen] = useState(false);
  const link = links.byThread.get(threadId) ?? null;
  const thread = links.threads.find((candidate) => candidate.id === threadId);
  const branchMatch = issueIdentifierFromBranch(thread?.environment?.branchName, links.teamKeys);

  const run = (promise: Promise<unknown>, message: string) =>
    promise.then(
      () => toast.success(message),
      (cause) => toast.error(errorText(cause)),
    );
  const linkTo = (identifier: string) => {
    setPickerOpen(false);
    void run(rpc.call("link_set", { threadId, identifier }), `Linked to ${identifier}`);
  };

  if (!links.ready) return <EmptyState>Loading…</EmptyState>;

  return (
    <div>
      {link === null ? (
        <div className="space-y-3">
          <EmptyState>This thread isn't linked to a Linear ticket.</EmptyState>
          <Button size="sm" onClick={() => setPickerOpen(true)}>
            <Icon name="Plus" className="size-4" />
            Link a ticket
          </Button>
        </div>
      ) : (
        <LinkedIssue
          identifier={link.identifier}
          sourceLabel={SOURCE_LABELS[link.source]}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Icon name="Search" className="size-4" />
                Change
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void run(rpc.call("link_set", { threadId, identifier: null }), "Unlinked")}
              >
                <Icon name="X" className="size-4" />
                Unlink
              </Button>
              {links.rows.has(threadId) && branchMatch !== null && branchMatch !== link.identifier ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void run(rpc.call("link_reset", { threadId }), `Back to ${branchMatch}`)}
                >
                  Use branch ({branchMatch})
                </Button>
              ) : null}
            </>
          }
        />
      )}
      <IssuePickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onPick={(issue) => linkTo(issue.identifier)} />
    </div>
  );
}

function LinkedIssue({
  identifier,
  sourceLabel,
  actions,
}: {
  identifier: string;
  sourceLabel: string;
  actions: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    rpc.call("issue_get", { id: identifier }).then(
      (result) => {
        if (cancelled) return;
        setIssue(result);
        setError(null);
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(errorText(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, identifier]);
  useEffect(() => {
    setIssue(null);
    return load();
  }, [load]);

  return (
    <article className="space-y-4">
      <header>
        <div className="flex items-center gap-2">
          <Icon name="linear-issues/linear" className="size-3.5 shrink-0 text-[#5E6AD2]" />
          <span className="font-mono text-xs text-muted-foreground">{identifier}</span>
          <span className="text-xs text-muted-foreground">· {sourceLabel}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7 text-muted-foreground"
            aria-label="Refresh"
            disabled={loading}
            onClick={load}
          >
            <Icon name="ArrowReloadHorizontal" className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        </div>
        {issue ? <h2 className="mt-1 text-base font-semibold leading-snug">{issue.title}</h2> : null}
      </header>

      <ErrorLine error={error} />
      {issue === null ? (
        error === null ? <EmptyState>Loading {identifier}…</EmptyState> : null
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <UrlLink href={issue.url} target="_blank">
                <Icon name="ExternalLink" className="size-4" />
                Linear
              </UrlLink>
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("issues", { subPath: identifier })}>
              <Icon name="Maximize2" className="size-4" />
              Full page
            </Button>
            {actions}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
            <Meta label="State">
              <span className="inline-flex items-center gap-2">
                <StateIcon state={issue.state} />
                {issue.state.name}
              </span>
            </Meta>
            <Meta label="Priority">
              <span className="inline-flex items-center gap-2">
                <PriorityIcon priority={issue.priority} label={issue.priorityLabel} />
                {issue.priorityLabel}
              </span>
            </Meta>
            <Meta label="Assignee">{issue.assignee?.name ?? "Unassigned"}</Meta>
            {issue.project ? <Meta label="Project">{issue.project.name}</Meta> : null}
            {issue.cycle ? <Meta label="Cycle">{issue.cycle.name ?? `Cycle ${issue.cycle.number}`}</Meta> : null}
            <Meta label="Branch">
              <span className="font-mono text-xs">{issue.branchName}</span>
            </Meta>
            {issue.labels.length ? (
              <Meta label="Labels">
                <span className="flex flex-wrap gap-1">
                  {issue.labels.map((label) => (
                    <LabelChip key={label.id} name={label.name} color={label.color} />
                  ))}
                </span>
              </Meta>
            ) : null}
          </dl>

          <section>
            {issue.description?.trim() ? (
              <LinearMarkdown content={issue.description} />
            ) : (
              <p className="text-sm italic text-muted-foreground">No description.</p>
            )}
          </section>

          {issue.children.length ? (
            <section>
              <h3 className="mb-1.5 text-sm font-medium">Sub-issues</h3>
              <ul className="space-y-1">
                {issue.children.map((child) => (
                  <li key={child.id} className="flex items-center gap-2 text-sm">
                    <StateIcon state={child.state} />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{child.identifier}</span>
                    <span className="min-w-0 truncate">{child.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <CommentThreads issue={issue} onChanged={load} />
        </>
      )}
    </article>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}
