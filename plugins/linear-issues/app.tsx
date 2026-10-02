// bb-plugin-linear frontend: a Linear page in the sidebar. The route's
// subPath carries the open issue identifier so deep links and back/forward
// work: /plugins/linear-issues/issues/ENG-42.
import { useEffect, useState } from "react";
import { LINEAR_ICON } from "@/lib/plugin-id";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { EmptyState, ErrorLine, errorText } from "./views/shared";
import { IssueDetail } from "./views/IssueDetail";
import { IssueList } from "./views/IssueList";
import { ProjectDetailView, ProjectList } from "./views/Projects";
import { InitiativeDetailView, InitiativeList } from "./views/Initiatives";
import { HomeSection } from "./views/HomeSection";
import { ThreadHeaderLink } from "./views/ThreadHeaderLink";
import { THREAD_PANEL_ACTION_ID, ThreadLinearPanel } from "./views/ThreadLinearPanel";
import { ComposerIssuePicker, requestIssuePicker } from "./views/ComposerIssuePicker";
import { SidebarDecorator } from "./views/SidebarDecorator";
import { WorktreeInputs } from "./views/WorktreeInputs";
import type { rpcContract } from "./server";
import { IDENTIFIER_PATTERN } from "./shared/links";

const PANEL_PATH = "issues";


let returnTo = "";

function PageTabs({ active, onSelect }: { active: "issues" | "projects" | "initiatives"; onSelect: (path: string) => void }) {
  const tabs = [
    { id: "issues", label: "Issues", path: "" },
    { id: "projects", label: "Projects", path: "projects" },
    { id: "initiatives", label: "Initiatives", path: "initiatives" },
  ] as const;
  return (
    <div role="tablist" aria-label="Linear" className="mb-3 flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.path)}
          className={
            active === tab.id
              ? "-mb-px border-b-2 border-[#5E6AD2] px-3 py-1.5 text-sm font-medium text-foreground"
              : "-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function LinearPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<{ configured: boolean; viewer: { name: string } | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("status").then(setStatus, (cause) => setError(errorText(cause)));
  }, [rpc]);

  // Routes: "" issues · "projects" · "projects/<id>" · "<IDENTIFIER>" an issue.
  const parts = subPath.split("/").filter(Boolean).map(decodeURIComponent);
  const identifier = parts[0] ?? "";
  const go = (path: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: path });
  // An issue opened from a project goes back to that project, not the issue list.
  const openIssueFrom = (from: string) => (id: string) => {
    returnTo = from;
    go(id);
  };

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
        ) : parts[0] === "initiatives" && parts[1] ? (
          <InitiativeDetailView
            key={parts[1]}
            initiativeId={parts[1]}
            onBack={() => go("initiatives")}
            onOpenProject={(id) => go(`projects/${encodeURIComponent(id)}`)}
            onOpenInitiative={(id) => go(`initiatives/${encodeURIComponent(id)}`)}
          />
        ) : parts[0] === "initiatives" ? (
          <>
            <PageTabs active="initiatives" onSelect={go} />
            <InitiativeList onOpen={(id) => go(`initiatives/${encodeURIComponent(id)}`)} />
          </>
        ) : parts[0] === "projects" && parts[1] ? (
          <ProjectDetailView
            key={`${parts[1]}/${parts[2] ?? ""}`}
            projectId={parts[1]}
            initialTab={parts[2] === "updates" || parts[2] === "issues" ? parts[2] : undefined}
            onBack={() => go("projects")}
            onOpenIssue={openIssueFrom(`projects/${parts[1]}`)}
          />
        ) : parts[0] === "projects" ? (
          <>
            <PageTabs active="projects" onSelect={go} />
            <ProjectList onOpen={(id, tab) => go(`projects/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`)} />
          </>
        ) : IDENTIFIER_PATTERN.test(identifier.toUpperCase()) ? (
          <IssueDetail identifier={identifier.toUpperCase()} onBack={() => go(returnTo)} />
        ) : (
          <>
            <PageTabs active="issues" onSelect={go} />
            <IssueList onOpen={openIssueFrom("")} />
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "issues",
    title: "Linear",
    icon: LINEAR_ICON,
    path: PANEL_PATH,
    component: LinearPage,
  });
  app.slots.homepageSection({
    id: "my-issues",
    title: "Linear issues",
    component: HomeSection,
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: "Linear issue",
    component: ThreadLinearPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "linked-issue",
    title: "Linear issue",
    component: ThreadHeaderLink,
  });
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: "linear-worktree",
    component: WorktreeInputs,
  });
  app.slots.experimental_appOverlay({
    id: "sidebar-badges",
    component: SidebarDecorator,
  });
  app.composer.customize({
    id: "linear-issue",
    scopes: ["new-thread"],
    actions: [{ id: "pick-issue", component: ComposerIssuePicker }],
    plusMenu: [
      {
        id: "pick-issue",
        label: "Start from a Linear issue",
        description: "Fill the prompt from a ticket and work in its own worktree",
        run: () => requestIssuePicker(),
      },
    ],
  });
});
