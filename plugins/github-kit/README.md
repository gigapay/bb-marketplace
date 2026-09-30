# bb-plugin-github-kit

My own GitHub plugin for BB, meant to replace the bundled `github` one. It adds a GitHub page in the sidebar with your pull requests, and a "Pull request" tab in each thread's side panel.

## Setup

The plugin needs a GitHub token with the `repo` and `read:org` scopes. If the machine running the BB server has `gh` logged in, there's nothing to do, it uses `gh auth token`. Otherwise set a personal access token in Settings → Plugins → GitHub Kit, or run:

```
bb plugin config github-kit set token <token>
```

It's a secret setting, so it stays on the BB server and never reaches the browser. The setting wins over `gh` when both exist.

The plugin writes to GitHub only on your click: requesting or removing a reviewer, resolving or reopening a review thread, and posting a comment or reply.

## What's in it

- `server.ts` is the backend. It holds the GitHub GraphQL client, the RPC contract used by the page, and the `bb github-kit` CLI.
- `shared/search.ts` builds the GitHub search string for each scope (covered by `npm test`).
- `app.tsx` registers the GitHub page (`/plugins/github-kit/pulls`, and `/pulls/<owner>/<repo>/<number>` for one PR) and the thread tab.
- `views/PullRequestList.tsx` is the list. Scopes are Review requested, Reviewed, Created, Assigned and Involved. There's a search box that takes GitHub qualifiers (`repo:owner/name`, `label:bug`), a "Show closed" toggle, and PRs are grouped by repository. Each row shows state, branch, labels, review decision, checks, diff size and last update. Clicking it opens the PR inside BB.
- `views/HomeSection.tsx` is the "Reviews" home-screen section: open PRs that request your review first, then open ones you already reviewed (not your own), with a repository filter that sticks across reloads. A row opens the PR page.
- `views/PullRequestDetail.tsx` is one PR: header, the threads working on its branch, reviewers (request or remove, with GitHub's suggestions first), the description, and the comment feed. The feed merges conversation comments, review summaries and inline review threads, filters by All / Humans / Bots, and lays each one out as a discussion like the Linear plugin: the root comment, replies on a rail, then Reply and Resolve. Resolved discussions sit folded under "N resolved discussions", and a composer at the bottom posts a new PR comment. Review threads get real replies; GitHub doesn't thread conversation comments, so replying to one posts a new comment that quotes it (`views/Discussion.tsx`). Tick comments to queue them, then "Send to thread" queues one message on the thread with the comments as untrusted JSON (the prompt comes from Orca's, see `shared/prompt.ts`).
- `views/Checks.tsx` is the live Checks section: check runs and commit statuses on the head commit, failures and running jobs first with a live duration, passing ones folded. GitHub has no push channel for API clients (webhooks would need a public URL and repo admin), so it polls `pr_checks` every 10s while something runs, every minute once everything settled, and pauses while the window is hidden. The server shares one call per PR every 5s, and each call costs one GraphQL point. A new head commit reloads the PR.
- `views/ThreadPrPanel.tsx` is the thread tab. It uses BB's own PR lookup for the thread, and falls back to a GitHub search on the branch name (`pr_for_branch`) when that finds nothing, which happens when the branch tracks the base branch.
- `views/DiffWithComments.tsx` is an opt-in diff renderer (Settings → Appearance → Diff renderer → "GitHub review comments"). In a thread whose branch has a PR, files with non-outdated review threads render through `@pierre/diffs` (the engine BB's own diff uses, shared at runtime) with each thread as an inline discussion under its line (Reply, Resolve, and "Send to thread"). Resolved ones start collapsed. Every other diff renders with BB's original renderer. Lines come from GitHub, so they match the pushed head: unpushed local edits can shift them.
- `views/useThreadPr.ts` finds a thread's PR and caches PR details, so the tab and every diff card share one request per minute.
- `detail.ts` holds the PR detail query and normalizes it into one feed. Bot detection (`shared/audience.ts`) follows Orca: GitHub's Bot type, `[bot]` logins, and known review tools like SonarCloud or CodeRabbit.
- `views/icons.tsx` has the inline PR and checks glyphs.
- `skills/github-kit/SKILL.md` tells agents how to use `bb github-kit prs`.

## Develop

```
npm install
npm test
bb plugin build
```
