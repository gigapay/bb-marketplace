// bb-plugin-github-kit frontend: a GitHub page in the sidebar that lists your
// pull requests. More GitHub views will hang off this page.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { EmptyState, ErrorLine, errorText } from "./views/shared";
import { PullRequestList } from "./views/PullRequestList";
import type { rpcContract } from "./server";

type Status = { configured: boolean; viewer: { login: string } | null; error: string | null };

function GitHubPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("status").then(setStatus, (cause) => setError(errorText(cause)));
  }, [rpc]);

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
        ) : (
          <PullRequestList viewer={status.viewer.login} />
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
    path: "pulls",
    component: GitHubPage,
  });
});
