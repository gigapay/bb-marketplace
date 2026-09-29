// bb-plugin-linear frontend: a Linear page in the sidebar. The route's
// subPath carries the open issue identifier so deep links and back/forward
// work: /plugins/linear-issues/issues/ENG-42.
import { useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { EmptyState, ErrorLine, errorText } from "./views/shared";
import { IssueDetail } from "./views/IssueDetail";
import { IssueList } from "./views/IssueList";
import { ThreadHeaderLink } from "./views/ThreadHeaderLink";
import type { rpcContract } from "./server";
import { IDENTIFIER_PATTERN } from "./shared/links";

const PANEL_PATH = "issues";


function LinearPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<{ configured: boolean; viewer: { name: string } | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("status").then(setStatus, (cause) => setError(errorText(cause)));
  }, [rpc]);

  const identifier = decodeURIComponent(subPath.split("/")[0] ?? "");
  const openIssue = (id: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: id });
  const backToList = () => navigate.toPluginPanel(PANEL_PATH, { subPath: "" });

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <ErrorLine error={error} />
        {status === null ? (
          error === null ? <EmptyState>Connecting to Linear…</EmptyState> : null
        ) : !status.configured ? (
          <EmptyState>
            Add your Linear personal API key in Settings → Plugins → Linear Issues, or run{" "}
            <code>bb plugin config linear-issues set apiKey &lt;key&gt;</code>.
          </EmptyState>
        ) : status.viewer === null ? (
          <ErrorLine error={status.error ?? "Could not reach Linear."} />
        ) : IDENTIFIER_PATTERN.test(identifier.toUpperCase()) ? (
          <IssueDetail identifier={identifier.toUpperCase()} onBack={backToList} />
        ) : (
          <IssueList onOpen={openIssue} />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "issues",
    title: "Linear",
    icon: "SquareKanban",
    path: PANEL_PATH,
    component: LinearPage,
  });
  app.slots.experimental_threadHeaderAction({
    id: "linked-issue",
    title: "Linear issue",
    component: ThreadHeaderLink,
  });
});
