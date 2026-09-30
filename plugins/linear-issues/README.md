# bb-plugin-linear-issues

A BB plugin that adds a Linear page to the sidebar. You can browse your issues, open one, and start a BB thread from it with a prompt prefilled from the ticket.

## Setup

Create a personal API key in Linear (Settings → Security & access → Personal API keys), then either paste it into Settings → Plugins → Linear Issues or run:

```
bb plugin config linear-issues set apiKey <key>
```

The key is a secret setting. It stays on the BB server and never reaches the browser.

## Linear worktree environment

The plugin registers its own environment provider, `linear-worktree` ("Linear worktree"), built from BB's bundled Worktree provider (see `worktree/ORIGIN.md`). It differs in three ways:

- The branch is the ticket's Linear `branchName`, like `yoann/gig-123-fix-login`. The ticket comes from the thread's stored link or from a title or prompt that starts with the identifier. Threads without a ticket keep BB's generated name.
- The `worktreesRoot` setting (for example `~/worktrees`) puts worktrees at `<folder>/<repo>/<branch with / as ->`, like Orca does. Leave it empty to keep BB's per-attempt folder under its data dir.
- Before creating anything, the server reserves a branch and folder that nobody uses yet (`-2`, `-3`, … when taken) and stores the choice per attempt, so retries reuse it. This matters because BB's create resets the branch (`git worktree add -B`) and clears the target folder, which is only safe on names nobody else holds.

New worktrees always branch off the project's default (primary) branch. A "Work on" control beside the environment picker (`views/WorktreeInputs.tsx`) has three modes:

- Ticket branch (the default). If the ticket's branch is already checked out in a worktree BB doesn't manage (made by Orca or by hand), that worktree is adopted. If the branch exists without a worktree, a worktree is created on it without resetting it, so earlier commits are kept. Otherwise it starts fresh.
- New worktree. Always starts fresh, and adds `-2` if the branch is taken.
- An existing worktree of the repository, picked from the list.

Adopted worktrees are attached with `ownsPath: false`. BB never deletes them and never runs setup or teardown scripts on them. Worktrees BB may delete when their environment retires are never offered. Those are the ones under BB's data dir, plus the ones this plugin created, which it tracks per attempt in `worktree_reservations.target_path`. Worktrees you made yourself stay adoptable even inside the worktrees folder. Folder names follow Orca's convention, the branch with `/` turned into `-`, so `~/dev/worktrees/gigapay-app/yoann-gig-123-fix-login`.

## Starting from BB's composer

The plugin adds a Linear button to the root new-thread composer (`app.composer.customize`) and a `+` menu entry. Picking a ticket switches the environment to a Linear worktree on the machine already selected, and writes a prompt whose first line is `GIG-123: <title>`. The ticket page's composer preselects a Linear worktree on the project's default machine.

The prompt carries a `Linked Linear issue: GIG-123` line. A `message.dispatch` hook on the server reads it on the first send and stores the link, so it works however the thread was sent. Threads on BB's regular Worktree provider still get their generated branch renamed to the Linear name after creation (`renameWorktreeBranch`), as long as it was never pushed.

## Sidebar badges

BB's sidebar belongs to its bundled thread-list plugin, which has no extension point for rows. An app-wide overlay (`views/SidebarDecorator.tsx`) portals a small Linear icon into the worktree row, or into the thread row when there's no worktree group. Hovering it opens a hover card with the ticket's title, status, priority and assignee, and clicking it opens the issue. The badge wrapper carries `data-bb-plugin="linear-issues"` so the plugin's scoped CSS applies inside the sidebar. Worktree rows are found through their "Collapse/Expand <name> threads" chevron. If BB changes that markup the badge stops showing, and nothing else breaks.

## Images and attachments

Linear serves pasted images and attachments from `uploads.linear.app` only when the request carries the API key. The server exposes `GET /api/v1/plugins/linear-issues/http/upload?url=…` (auth `local`), which fetches the file with the key and streams it back. It only proxies `https://uploads.linear.app`, so the key can't be sent anywhere else. `lib/uploads.ts` rewrites those URLs in descriptions and comments before they reach `Markdown`. Non-image files are served as downloads, and responses carry `nosniff` plus a sandboxing CSP.

## Triage with Jev

"Triage with Jev" in the Linear page asks TypeSafe's Jev model about every issue in the current list (up to 50). It uses the official `@typesafe-ai/sdk`, pointed at OpenRouter (`openRouterApiKey` setting) with a small fetch shim, because OpenRouter serves the same System One protocol at `/api/alpha/decisions`.

Jev doesn't write text. It answers typed questions with probabilities, so triage is a set of narrow questions per issue, all in one request. They're defined, with their thresholds, in `triage/criteria.ts`:

- Priority: a `choice` of urgent/high/medium/low with contrastive, Gigapay-specific criteria.
- Type label: a `choice` among Bug, Improvement, Feature, Refactor and Maintenance. It's only asked when the issue has none of them.
- Area labels: one `noul` per area (Backend, Frontend, Devops, Design, Security, Data), so several can apply.
- Project: a `choice` among the team's active projects plus `none`. It's only asked when the issue has no project.
- Readiness: a `noul` "could an engineer start today?". A low value flags "Needs more info".
- Missing information: one `noul` per gap (goal, expected behaviour, acceptance criteria, plus repro steps for bugs and designs for UI work). When an issue needs more info, the review proposes a comment that lists exactly what's missing, addressed to the creator and editable before posting. "Enrich with an agent" opens the composer with a prompt for an agent to research the code and draft a better description, without touching Linear.
- Stale tickets: code first picks candidates. Those are open issues with no update or comment for `staleAfterDays` (setting, default 90), not urgent, not in an active cycle, with no BB thread and no GitHub or GitLab attachment. For those only, Jev answers "is this optional?" and "does it carry a commitment?". When optional × (1 − commitment) ≥ 0.4, the review proposes Cancel (the team's first canceled state), plus a closing comment. Cancel is never pre-checked.

Only labels that exist in the workspace are asked about. `triage/engine.ts` turns the answers into proposals. A proposal below the `propose` threshold is dropped, and one above `preselect` is pre-checked. The review dialog (`views/Triage.tsx`) lists them per issue with their confidence. Rows are colour-coded by kind: amber for priority, the label's own Linear colour, violet for project, blue for comment, red for cancel. Confidence is green, amber or grey. Only the checked changes are applied, through `issueUpdate`, then `commentCreate` for comments. Labels are added with `addedLabelIds` and never removed. The optional `triageGuidelines` setting passes team conventions to every request.

## Comments

`views/Comments.tsx` groups Linear's flat comment list into discussions with `shared/comments.ts`: each root comment with its replies, since Linear nests one level. Resolved discussions are folded away, and comments from integrations show the bot or external author. Comments and replies are posted through the `comment_create` RPC (`commentCreate` mutation) as the API key's owner, only when the user presses Comment or Reply. That is the plugin's only write to Linear. The agent CLI stays read-only.

## Thread links

A thread is linked to an issue when it was started from a ticket (issue page or composer button), when you link it by hand (from the thread header, the issue page, or `bb linear-issues link <id>`), when its worktree branch contains the identifier, or when it shares a worktree whose linked threads all point at one issue. Stored links live in the plugin's SQLite database. A stored row overrides the branch match, and a stored "unlinked" row hides one. Branch matches are computed on read from `environment.branchName`, and only keys of real Linear teams count.

## What's in it

- `server.ts` is the backend. It holds the Linear GraphQL client, the RPC contract used by the page, and the `bb linear-issues` CLI.
- `app.tsx` is the page entry. The route `/plugins/linear-issues/issues/<IDENTIFIER>` opens an issue directly.
- `views/Filters.tsx` is the filter bar under the list: labels (with their Linear colours and groups), priority, and project (including "No project"). Filters are OR within a kind and AND across kinds. The server turns them into an `IssueFilter` (`projects.ts`, `issueFilterClauses`).
- `views/Projects.tsx` is the Projects tab and the project page. The list is grouped by status, with health, progress and target date, and can show only your projects (lead or member) or include completed ones. The project page has an overview (milestones, the full description from `content`, the latest update), every project update with its health, and the project's issues grouped like the issue list. Routes are `/plugins/linear-issues/issues/projects` and `/plugins/linear-issues/issues/projects/<id>`.
- `views/IssueList.tsx` shows the list. It has Assigned, Created, Subscribed and With threads scopes, search, a "show done" toggle, and a thread count per issue. Issues are grouped by workflow state and sorted by priority.
- `views/IssueDetail.tsx` shows one issue: its metadata, description, sub-issues and comments, its linked threads, and BB's new-thread composer seeded with the ticket and the last project used for that team.
- `views/ThreadHeaderLink.tsx` is the chip in the thread header. Clicking a linked chip opens the "Linear issue" side-panel tab, and an unlinked one offers to link.
- `views/HomeSection.tsx` is the "Linear issues" home-screen section. It shows your six most urgent open assigned issues, in-progress first, with their thread count. "Start" puts the ticket into the home composer right above it through `useComposer()` (home sections mount inside the root composer host), the same way the composer button does.
- `views/ThreadLinearPanel.tsx` is that tab (`app.slots.threadPanelAction`). BB always lists it in the panel's new-tab launcher, so it follows the thread's link live. It shows the ticket (status, priority, branch, description, sub-issues, comments) with Change and Unlink when the thread is linked, and a picker when it isn't.
- `views/links.tsx` resolves every thread's link from stored rows plus branch names (`shared/links.ts`, covered by `npm test`).
- `worktree/provider.ts` is the Linear worktree provider. `worktree/host` and `worktree/vendor` are the host-side git code copied from BB, and `host.ts` and `contract.ts` merge it with the branch rename into the plugin's single host entry.
- `assets/linear.svg` is the Linear mark. It's the plugin icon, and `linear-issues/linear` everywhere in the UI.
- `lib/prompt.ts` builds that seeded prompt. The description is wrapped as untrusted reference data.
- `skills/linear-issues/SKILL.md` tells agents how to use `bb linear-issues show <id>`.

## Develop

```
npm install
npm test
bb plugin build
bb plugin install .
bb plugin dev
```
