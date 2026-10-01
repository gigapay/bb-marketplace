import { useEffect, useMemo, useState } from "react";
import { LINEAR_ICON } from "@/lib/plugin-id";
import { toast } from "sonner";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginHomepageSectionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { IssueSummary, rpcContract } from "../server";
import { startFromIssue } from "./ComposerIssuePicker";
import { useIssueLinks } from "./links";
import { PriorityIcon, StateIcon, errorText, stateTypeRank } from "./shared";

const MAX_ROWS = 6;

// In progress first, then by priority (urgent first, "none" last).
function byUrgency(a: IssueSummary, b: IssueSummary): number {
  const rank = (p: number) => (p === 0 ? 5 : p);
  return (
    stateTypeRank(a.state.type) - stateTypeRank(b.state.type) ||
    rank(a.priority) - rank(b.priority) ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/** A glance at your open Linear issues under the home composer. */
export function HomeSection({ projectId }: PluginHomepageSectionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  // Home sections mount inside the root composer, so this is the draft above.
  const composer = useComposer();
  const links = useIssueLinks();
  const { projects } = useSidebarThreads();
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unconfigured" | "error">("loading");
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("status").then(async (status) => {
      if (cancelled) return;
      if (!status.configured) return setState("unconfigured");
      if (status.viewer === null) return setState("error");
      try {
        const result = await rpc.call("issues_list", { scope: "assigned", includeCompleted: false, query: "" });
        if (cancelled) return;
        setIssues(result.issues);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    }, () => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  const visible = useMemo(() => (issues ?? []).slice().sort(byUrgency).slice(0, MAX_ROWS), [issues]);
  const isPersonal = projects.find((project) => project.id === projectId)?.isPersonal ?? projectId === null;

  const start = async (issue: IssueSummary) => {
    setStarting(issue.identifier);
    try {
      await startFromIssue(composer, rpc, issue.identifier, isPersonal);
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setStarting(null);
    }
  };

  if (state === "unconfigured") {
    return (
      <p className="text-sm text-muted-foreground">
        Connect Linear with <code>bb plugin config linear-issues set apiKey &lt;key&gt;</code> to see your issues here.
      </p>
    );
  }
  if (state === "error") return <p className="text-sm text-muted-foreground">Couldn't reach Linear.</p>;

  return (
    <div>
      {/* BB renders the section title; this row only adds the count and a way out. */}
      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name={LINEAR_ICON} className="size-3.5 text-[#5E6AD2]" />
        <span>{issues ? `${issues.length} open, assigned to you` : "Your open issues"}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-muted-foreground"
          onClick={() => navigate.toPluginPanel("issues")}
        >
          View all
          <Icon name="ChevronRight" className="size-3.5" />
        </Button>
      </div>
      {state === "loading" ? (
        <div className="space-y-1.5" aria-busy="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-9 animate-pulse rounded-md bg-muted/50" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open issues assigned to you. Nice.</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {visible.map((issue) => {
            const threads = links.byIssue.get(issue.identifier) ?? [];
            return (
              <li key={issue.id} className="group flex items-center gap-3 px-3 py-1.5 text-sm">
                <PriorityIcon priority={issue.priority} label={issue.priorityLabel} />
                <button
                  type="button"
                  onClick={() => navigate.toPluginPanel("issues", { subPath: issue.identifier })}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
                  <StateIcon state={issue.state} />
                  <span className="min-w-0 flex-1 truncate group-hover:underline">{issue.title}</span>
                </button>
                {threads.length > 0 ? (
                  <button
                    type="button"
                    aria-label={`${threads.length} linked ${threads.length === 1 ? "thread" : "threads"}, open the latest`}
                    onClick={() => {
                      const latest = threads.slice().sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0]!;
                      navigate.toThread(latest.thread.id);
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-xs text-accent-foreground hover:bg-accent/70"
                  >
                    <Icon name="MessageSquare" className="size-3" />
                    {threads.length}
                  </button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-muted-foreground hover:text-foreground"
                  disabled={starting !== null}
                  aria-label={`Start a thread for ${issue.identifier}`}
                  onClick={() => void start(issue)}
                >
                  <Icon
                    name={starting === issue.identifier ? "Loading" : "Play"}
                    className={starting === issue.identifier ? "size-3.5 animate-spin" : "size-3.5"}
                  />
                  Start
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {issues && issues.length > MAX_ROWS ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {issues.length - MAX_ROWS} more in the Linear page.
        </p>
      ) : null}
    </div>
  );
}
