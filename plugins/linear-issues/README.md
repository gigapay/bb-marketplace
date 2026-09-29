# bb-plugin-linear-issues

A BB plugin that adds a Linear page to the sidebar. You can browse your issues, open one, and start a BB thread from it with a prompt prefilled from the ticket.

## Setup

Create a personal API key in Linear (Settings → Security & access → Personal API keys), then either paste it into Settings → Plugins → Linear Issues or run:

```
bb plugin config linear-issues set apiKey <key>
```

The key is a secret setting. It stays on the BB server and never reaches the browser.

## Thread links

A thread is linked to an issue when it was started from the issue page, when you link it by hand (from the thread header, the issue page, or `bb linear-issues link <id>`), or when its worktree branch contains the identifier. Stored links live in the plugin's SQLite database. A stored row overrides the branch match, and a stored "unlinked" row hides one. Branch matches are computed on read from `environment.branchName`, and only keys of real Linear teams count.

## What's in it

- `server.ts` is the backend. It holds the Linear GraphQL client, the RPC contract used by the page, and the `bb linear-issues` CLI.
- `app.tsx` is the page entry. The route `/plugins/linear-issues/issues/<IDENTIFIER>` opens an issue directly.
- `views/IssueList.tsx` shows the list. It has Assigned, Created, Subscribed and With threads scopes, search, a "show done" toggle, and a thread count per issue. Issues are grouped by workflow state and sorted by priority.
- `views/IssueDetail.tsx` shows one issue: its metadata, description, sub-issues and comments, its linked threads, and BB's new-thread composer seeded with the ticket and the last project used for that team.
- `views/ThreadHeaderLink.tsx` is the chip in the thread header that shows, links, changes or unlinks the issue.
- `views/links.tsx` resolves every thread's link from stored rows plus branch names (`shared/links.ts`, covered by `npm test`).
- `lib/prompt.ts` builds that seeded prompt. The description is wrapped as untrusted reference data.
- `skills/linear-issues/SKILL.md` tells agents how to use `bb linear-issues show <id>`.

## Develop

```
npm install
bb plugin build
bb plugin install .
bb plugin dev
```
