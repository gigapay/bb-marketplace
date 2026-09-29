# bb-plugin-linear-issues

A BB plugin that adds a Linear page to the sidebar. You can browse your issues, open one, and start a BB thread from it with a prompt prefilled from the ticket.

## Setup

Create a personal API key in Linear (Settings → Security & access → Personal API keys), then either paste it into Settings → Plugins → Linear Issues or run:

```
bb plugin config linear-issues set apiKey <key>
```

The key is a secret setting. It stays on the BB server and never reaches the browser.

## Starting from BB's composer

The plugin adds a Linear button to the root new-thread composer (`app.composer.customize`) and a `+` menu entry. Picking a ticket does two things. It sets the environment to the `git-worktree` provider on the machine already selected, which bases the worktree on the default (primary) branch. It also writes a prompt whose first line is `GIG-123: <title>`. BB builds the worktree branch as `<prefix><slug of the title fallback>-<threadId>`, and that fallback is the start of the prompt, so the branch name starts with the identifier. A plugin can't pick that name up front. So once the worktree exists (on `thread.active`, with `thread.idle` as a fallback), the server asks the plugin's host entry (`host.ts`) to rename BB's generated branch to the ticket's Linear `branchName` with `git branch -m`. It only does this for threads started from a ticket, only when the current branch still ends with the thread id, and only once per thread. A taken name gets `-2`, `-3`, and so on. BB re-reads the branch on its next status poll, so the sidebar and PR tools follow along. You can turn it off with the `renameWorktreeBranch` setting.

The prompt carries a `Linked Linear issue: GIG-123` line. A `message.dispatch` hook on the server reads it on the first send and stores the link, so it works however the thread was sent.

## Sidebar badges

BB's sidebar belongs to its bundled thread-list plugin, which has no extension point for rows. An app-wide overlay (`views/SidebarDecorator.tsx`) sets a `data-linear-issue` attribute on the worktree row, or on the thread row when there's no worktree group, and CSS draws the Linear mark and identifier after the name. Worktree rows are found through their "Collapse/Expand <name> threads" chevron. If BB changes that markup the badge disappears, and nothing else breaks.

## Thread links

A thread is linked to an issue when it was started from a ticket (issue page or composer button), when you link it by hand (from the thread header, the issue page, or `bb linear-issues link <id>`), or when its worktree branch contains the identifier. Stored links live in the plugin's SQLite database. A stored row overrides the branch match, and a stored "unlinked" row hides one. Branch matches are computed on read from `environment.branchName`, and only keys of real Linear teams count.

## What's in it

- `server.ts` is the backend. It holds the Linear GraphQL client, the RPC contract used by the page, and the `bb linear-issues` CLI.
- `app.tsx` is the page entry. The route `/plugins/linear-issues/issues/<IDENTIFIER>` opens an issue directly.
- `views/IssueList.tsx` shows the list. It has Assigned, Created, Subscribed and With threads scopes, search, a "show done" toggle, and a thread count per issue. Issues are grouped by workflow state and sorted by priority.
- `views/IssueDetail.tsx` shows one issue: its metadata, description, sub-issues and comments, its linked threads, and BB's new-thread composer seeded with the ticket and the last project used for that team.
- `views/ThreadHeaderLink.tsx` is the chip in the thread header that shows, links, changes or unlinks the issue.
- `views/links.tsx` resolves every thread's link from stored rows plus branch names (`shared/links.ts`, covered by `npm test`).
- `host.ts` and `contract.ts` hold the host-side git rename.
- `assets/linear.svg` is the Linear mark. It's the plugin icon, and `linear-issues/linear` everywhere in the UI.
- `lib/prompt.ts` builds that seeded prompt. The description is wrapped as untrusted reference data.
- `skills/linear-issues/SKILL.md` tells agents how to use `bb linear-issues show <id>`.

## Develop

```
npm install
bb plugin build
bb plugin install .
bb plugin dev
```
