import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  Markdown,
  UrlLink,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { buildIssuePrompt } from "@/lib/prompt";
import type { IssueDetail as Issue, rpcContract } from "../server";
import { SOURCE_LABELS, useIssueLinks, type LinkedThread } from "./links";
import { ThreadPickerDialog } from "./pickers";
import { EmptyState, ErrorLine, LabelChip, PriorityIcon, StateIcon, errorText, relativeTime } from "./shared";

export function IssueDetail({ identifier, onBack }: { identifier: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIssue(null);
    setError(null);
    rpc.call("issue_get", { id: identifier }).then(
      (result) => !cancelled && setIssue(result),
      (cause) => !cancelled && setError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, identifier]);

  return (
    <div>
      <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
        <Icon name="ArrowLeft" className="size-4" />
        Issues
      </Button>
      <ErrorLine error={error} />
      {issue === null ? (
        error === null ? (
          <div className="mt-3">
            <EmptyState>Loading {identifier}…</EmptyState>
          </div>
        ) : null
      ) : (
        <IssueBody issue={issue} />
      )}
    </div>
  );
}

function IssueBody({ issue }: { issue: Issue }) {
  const sdk = useSdk();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { projectId: routeProjectId } = useBbContext();
  const links = useIssueLinks();
  const linked = links.byIssue.get(issue.identifier) ?? [];
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  // undefined while loading, so the composer mounts once with the right seed
  // instead of re-seeding (and dropping the user's picks) when it arrives.
  const [teamProjectId, setTeamProjectId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    rpc.call("team_project_get", { teamKey: issue.team.key }).then(
      (result) => !cancelled && setTeamProjectId(result.projectId),
      () => !cancelled && setTeamProjectId(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, issue.team.key]);
  const defaultProjectId = teamProjectId ?? routeProjectId ?? undefined;
  // Seed a Linear worktree on the project's machine once it's known; the
  // composer re-seeds on change, so wait for it before mounting.
  const [defaultHostId, setDefaultHostId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (teamProjectId === undefined) return;
    if (defaultProjectId === undefined) return setDefaultHostId(null);
    let cancelled = false;
    rpc.call("project_default_host", { projectId: defaultProjectId }).then(
      (result) => !cancelled && setDefaultHostId(result.hostId),
      () => !cancelled && setDefaultHostId(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, teamProjectId, defaultProjectId]);
  const composerRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const initialPrompt = useMemo(() => buildIssuePrompt(issue), [issue]);

  const startThread = () => {
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFocusRequest((n) => n + 1);
  };

  const copyBranch = () => {
    void navigator.clipboard.writeText(issue.branchName).then(
      () => toast.success("Branch name copied"),
      () => toast.error("Could not copy the branch name"),
    );
  };

  return (
    <article className="mt-2">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted-foreground">{issue.identifier}</p>
          <h1 className="mt-1 text-xl font-semibold leading-tight">{issue.title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <UrlLink href={issue.url} target="_blank">
              <Icon name="ExternalLink" className="size-4" />
              Open in Linear
            </UrlLink>
          </Button>
          <Button size="sm" onClick={startThread}>
            <Icon name="Play" className="size-4" />
            Start thread
          </Button>
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
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
        <Meta label="Team">{issue.team.name}</Meta>
        {issue.project ? <Meta label="Project">{issue.project.name}</Meta> : null}
        {issue.cycle ? <Meta label="Cycle">{issue.cycle.name ?? `Cycle ${issue.cycle.number}`}</Meta> : null}
        {issue.estimate !== null ? <Meta label="Estimate">{issue.estimate}</Meta> : null}
        {issue.dueDate ? <Meta label="Due">{issue.dueDate}</Meta> : null}
        <Meta label="Branch">
          <button
            type="button"
            onClick={copyBranch}
            title="Copy branch name"
            className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs hover:text-foreground"
          >
            <Icon name="GitBranch" className="size-3.5 shrink-0" />
            <span className="truncate">{issue.branchName}</span>
          </button>
        </Meta>
        <Meta label="Updated">{relativeTime(issue.updatedAt)}</Meta>
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

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium">Threads</h2>
          <span className="text-sm text-muted-foreground">{linked.length}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-muted-foreground"
            onClick={() => setThreadPickerOpen(true)}
          >
            <Icon name="Link" className="size-4" />
            Link a thread
          </Button>
        </div>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No thread yet. Start one below, link an existing one, or use a branch containing{" "}
            <code>{issue.identifier.toLowerCase()}</code>.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {linked.map((entry) => (
              <LinkedThreadRow
                key={entry.thread.id}
                entry={entry}
                projectName={links.projectName(entry.thread.projectId)}
                onOpen={() => navigate.toThread(entry.thread.id)}
                onUnlink={() => {
                  rpc
                    .call("link_set", { threadId: entry.thread.id, identifier: null })
                    .catch((cause) => toast.error(errorText(cause)));
                }}
              />
            ))}
          </ul>
        )}
        <ThreadPickerDialog
          open={threadPickerOpen}
          onOpenChange={setThreadPickerOpen}
          threads={links.threads.filter((thread) => links.byThread.get(thread.id)?.identifier !== issue.identifier)}
          projectName={links.projectName}
          onPick={(thread) => {
            setThreadPickerOpen(false);
            rpc.call("link_set", { threadId: thread.id, identifier: issue.identifier }).then(
              () => toast.success(`Linked to ${issue.identifier}`),
              (cause) => toast.error(errorText(cause)),
            );
          }}
        />
      </section>

      {issue.parent ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Sub-issue of <IssueLink identifier={issue.parent.identifier} /> {issue.parent.title}
        </p>
      ) : null}

      <section className="mt-6">
        {issue.description?.trim() ? (
          <Markdown content={issue.description} />
        ) : (
          <p className="text-sm italic text-muted-foreground">No description.</p>
        )}
      </section>

      {issue.children.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium">Sub-issues</h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {issue.children.map((child) => (
              <li key={child.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <StateIcon state={child.state} />
                <IssueLink identifier={child.identifier} />
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {issue.comments.length ? (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-medium">Activity</h2>
          <ol className="space-y-3">
            {issue.comments.map((comment) => (
              <li key={comment.id} className="rounded-lg border border-border bg-card p-3">
                <p className="mb-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{comment.user?.name ?? "Unknown"}</span>
                  {" · "}
                  {relativeTime(comment.createdAt)}
                </p>
                <Markdown content={comment.body} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section ref={composerRef} className="mt-8 scroll-mt-4">
        <h2 className="mb-1 text-sm font-medium">Start a thread from this issue</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Pick the project in the row under the prompt. The last project you used for {issue.team.name} is
          preselected.
        </p>
        {teamProjectId === undefined || defaultHostId === undefined ? (
          <EmptyState>Loading composer…</EmptyState>
        ) : (
          <NewThreadComposer
            layout="document"
            initialPrompt={initialPrompt}
            focusRequest={focusRequest}
            draftKey={`issue:${issue.id}`}
            {...(defaultProjectId ? { defaultProjectId } : {})}
            {...(defaultHostId
              ? {
                  defaultEnvironment: {
                    type: "provider" as const,
                    environmentProviderId: "linear-worktree",
                    machine: { type: "existing" as const, hostId: defaultHostId },
                    inputs: {},
                  },
                }
              : {})}
            onSubmit={async (request) => {
              const thread = await sdk.threads.spawn({
                ...request,
                title: `${issue.identifier}: ${issue.title}`,
                pluginMetadata: { issueId: issue.id, issueIdentifier: issue.identifier, issueUrl: issue.url },
              });
              // The thread exists at this point; a failed link must not
              // keep the draft around and invite a duplicate submit.
              await rpc
                .call("spawn_recorded", {
                  threadId: thread.id,
                  identifier: issue.identifier,
                  teamKey: issue.team.key,
                  projectId: request.projectId,
                })
                .catch((cause) => toast.error(`Thread created but not linked: ${errorText(cause)}`));
              navigate.toThread(thread.id);
            }}
          />
        )}
      </section>
    </article>
  );
}

function LinkedThreadRow({
  entry,
  projectName,
  onOpen,
  onUnlink,
}: {
  entry: LinkedThread;
  projectName: string | null;
  onOpen: () => void;
  onUnlink: () => void;
}) {
  const { thread, source } = entry;
  const busy = thread.status === "active" || thread.status === "starting";
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <span
        aria-label={thread.indicatorLabel ?? (busy ? "Running" : "Idle")}
        className={`size-2 shrink-0 rounded-full ${busy ? "animate-pulse bg-primary" : thread.hasPendingInteraction ? "bg-destructive" : "bg-muted-foreground/40"}`}
      />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate hover:underline">{thread.displayTitle}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{projectName ?? "Unknown project"}</span>
          {thread.environment?.branchName ? (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
              <Icon name="GitBranch" className="size-3 shrink-0" />
              <span className="truncate">{thread.environment.branchName}</span>
            </span>
          ) : null}
          <span className="shrink-0">· {SOURCE_LABELS[source]}</span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Unlink ${thread.displayTitle}`}
        onClick={onUnlink}
      >
        <Icon name="Unlink" className="size-4" />
      </Button>
    </li>
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

function IssueLink({ identifier }: { identifier: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate.toPluginPanel("issues", { subPath: identifier })}
      className="font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {identifier}
    </button>
  );
}
