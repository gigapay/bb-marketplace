# bb-plugin-github-kit

My own GitHub plugin for BB, meant to replace the bundled `github` one. It adds a GitHub page in the sidebar with your pull requests, and a "Pull request" tab in each thread's side panel.

## Setup

The plugin needs a GitHub token with the `repo` and `read:org` scopes. If the machine running the BB server has `gh` logged in, there's nothing to do, it uses `gh auth token`. Otherwise set a personal access token in Settings → Plugins → GitHub Kit, or run:

```
bb plugin config github-kit set token <token>
```

It's a secret setting, so it stays on the BB server and never reaches the browser. The setting wins over `gh` when both exist.

The plugin only writes to GitHub when you request or remove a reviewer from a PR page.

## What's in it

- `server.ts` is the backend. It holds the GitHub GraphQL client, the RPC contract used by the page, and the `bb github-kit` CLI.
- `shared/search.ts` builds the GitHub search string for each scope (covered by `npm test`).
- `app.tsx` registers the GitHub page (`/plugins/github-kit/pulls`, and `/pulls/<owner>/<repo>/<number>` for one PR) and the thread tab.
- `views/PullRequestList.tsx` is the list. Scopes are Review requested, Created, Assigned and Involved. There's a search box that takes GitHub qualifiers (`repo:owner/name`, `label:bug`), a "Show closed" toggle, and PRs are grouped by repository. Each row shows state, branch, labels, review decision, checks, diff size and last update. Clicking it opens the PR inside BB.
- `views/PullRequestDetail.tsx` is one PR: header, the threads working on its branch, reviewers (request or remove, with GitHub's suggestions first), the description, and the comment feed. The feed merges conversation comments, review summaries and inline review threads, filters by All / Humans / Bots, and hides resolved threads by default. Tick comments to queue them, then "Send to thread" queues one message on the thread with the comments as untrusted JSON (the prompt comes from Orca's, see `shared/prompt.ts`).
- `views/ThreadPrPanel.tsx` is the thread tab. It uses BB's own PR lookup for the thread, and falls back to a GitHub search on the branch name (`pr_for_branch`) when that finds nothing, which happens when the branch tracks the base branch.
- `detail.ts` holds the PR detail query and normalizes it into one feed. Bot detection (`shared/audience.ts`) follows Orca: GitHub's Bot type, `[bot]` logins, and known review tools like SonarCloud or CodeRabbit.
- `views/icons.tsx` has the inline PR and checks glyphs.
- `skills/github-kit/SKILL.md` tells agents how to use `bb github-kit prs`.

## Develop

```
npm install
npm test
bb plugin build
```
