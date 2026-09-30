// bb-plugin-github-kit frontend: a GitHub page in the sidebar, a "Pull
// request" tab in each thread's side panel, and a diff renderer with inline
// review comments. The page's subPath carries the
// open PR, so deep links and back/forward work: /plugins/github-kit/pulls/owner/repo/123.
import { useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { EmptyState, ErrorLine, errorText } from "./views/shared";
import { PullRequestDetail } from "./views/PullRequestDetail";
import { PullRequestList } from "./views/PullRequestList";
import { THREAD_PANEL_ACTION_ID, ThreadPrPanel } from "./views/ThreadPrPanel";
import { DiffWithComments } from "./views/DiffWithComments";
import { HomeSection } from "./views/HomeSection";
import { parsePrKey, prKey } from "./shared/pr-ref";
import type { rpcContract } from "./server";

const PANEL_PATH = "pulls";

type Status = { configured: boolean; viewer: { login: string } | null; error: string | null };

function keyFromSubPath(subPath: string): string | null {
  const [owner, name, number] = subPath.split("/").map((part) => decodeURIComponent(part));
  if (!owner || !name || !number) return null;
  const ref = parsePrKey(`${owner}/${name}#${number}`);
  return ref === null ? null : prKey(ref);
}

function GitHubPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("status").then(setStatus, (cause) => setError(errorText(cause)));
  }, [rpc]);

  const openKey = keyFromSubPath(subPath);
  const openPr = (key: string) => {
    const ref = parsePrKey(key);
    if (ref) navigate.toPluginPanel(PANEL_PATH, { subPath: `${ref.owner}/${ref.name}/${ref.number}` });
  };
  const backToList = () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-5xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <ErrorLine error={error} />
        {status === null ? (
          error === null ? <EmptyState>Connecting to GitHub…</EmptyState> : null
        ) : !status.configured ? (
          <EmptyState>
            Add a GitHub token in Settings → Plugins → GitHub Kit, or run <code>gh auth login</code> on the
            machine that runs the BB server.
          </EmptyState>
        ) : status.viewer === null ? (
          <ErrorLine error={status.error ?? "Could not reach GitHub."} />
        ) : openKey !== null ? (
          <PullRequestDetail key={openKey} prKey={openKey} threadId={null} onBack={backToList} />
        ) : (
          <PullRequestList viewer={status.viewer.login} onOpen={openPr} />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "github",
    title: "GitHub",
    icon: "github-kit/github",
    path: PANEL_PATH,
    component: GitHubPage,
  });
  app.slots.homepageSection({
    id: "reviews",
    title: "Reviews",
    component: HomeSection,
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: "Pull request",
    component: ThreadPrPanel,
  });
  // Opt-in: pick "GitHub review comments" in Settings → Appearance → Diff renderer.
  app.slots.experimental_diffRenderer({
    id: "review-comments",
    title: "GitHub review comments",
    description: "BB's diff, plus the thread PR's unresolved GitHub review comments inline.",
    component: DiffWithComments,
  });
});
