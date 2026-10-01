# bb-plugin-github-kit

My own GitHub plugin for BB, meant to replace the bundled `github` one. It adds a GitHub page in the sidebar with your pull requests, and a "Pull request" tab in each thread's side panel.

## Setup

The plugin needs a GitHub token with the `repo` and `read:org` scopes. If the machine running the BB server has `gh` logged in, there's nothing to do, it uses `gh auth token`. Otherwise set a personal access token in Settings → Plugins → GitHub Kit, or run:

```
bb plugin config github-kit set token <token>
```

It's a secret setting, so it stays on the BB server and never reaches the browser. The setting wins over `gh` when both exist.

The plugin writes to GitHub only on your click: merging or toggling auto-merge, changing the PR's state, updating its branch, requesting or removing a reviewer, ticking a file as reviewed (Viewed), commenting on lines, submitting a review, resolving or reopening a review thread, and posting a comment or reply.

## What's in it

- `server.ts` is the backend. It holds the GitHub GraphQL client, the RPC contract used by the page, and the `bb github-kit` CLI.
- `shared/search.ts` builds the GitHub search string for each scope (covered by `npm test`).
- `app.tsx` registers the GitHub page (`/plugins/github-kit/pulls`, and `/pulls/<owner>/<repo>/<number>` for one PR) and the thread tab.
- `views/PullRequestList.tsx` is the list. Scopes are Review requested, Reviewed, Created, Assigned and Involved. There's a search box that takes GitHub qualifiers (`repo:owner/name`, `label:bug`), a "Show closed" toggle, and PRs are grouped by repository. Each row shows state, branch, labels, review decision, checks, diff size and last update. Clicking it opens the PR inside BB.
- `views/HomeSection.tsx` is the "Reviews" home-screen section: open PRs that request your review first, then open ones you already reviewed (not your own), with a repository filter that sticks across reloads. A row opens the PR page.
- `views/PullRequestDetail.tsx` is one PR, laid out after Linear's: Overview and Diff pills on top, next to Merge / Auto merge (`views/MergeControl.tsx`), refresh, copy link and Open on GitHub. The Overview has the title, author and `base ← head` line, a foldable description and an Activity timeline on the left, and a right column with Status (a menu to switch draft / open / closed), Threads, Reviewers (request or remove, GitHub's suggestions first), Checks (a filterable popover of every check, and "Resolve with agent" for the failing ones), Branch (update by rebase or merge commit when it's behind) and Files changed (jumps into the Diff). Menus use the small `views/Popover.tsx`.
- Merging: "Merge" shows when GitHub's merge state says the PR can merge now, asks for a confirmation that names the base and the method (only the ones the repo allows), and is refused if the head moved since the page loaded. Otherwise, when the repo allows it, an "Auto merge" switch turns GitHub's auto-merge on or off.
- The Activity feed merges conversation comments, review summaries and inline review threads, filters by All / Humans / Bots, and lays each one out as a Linear-style card: avatar, name, time and a review-state chip, replies on a rail, Resolve, and a "Leave a reply…" row. Resolved discussions sit folded under "N resolved discussions", and a composer at the bottom posts a new PR comment. Review threads get real replies; GitHub doesn't thread conversation comments, so replying to one posts a new comment that quotes it (`views/Discussion.tsx`). Tick comments to queue them, then "Send to thread" queues one message on the thread with the comments as untrusted JSON (the prompt comes from Orca's, see `shared/prompt.ts`).
- `views/Checks.tsx` is the live Checks section: check runs and commit statuses on the head commit, failures and running jobs first with a live duration, passing ones folded. GitHub has no push channel for API clients (webhooks would need a public URL and repo admin), so it polls `pr_checks` every 10s while something runs, every minute once everything settled, and pauses while the window is hidden. The server shares one call per PR every 5s, and each call costs one GraphQL point. A new head commit reloads the PR.
- `views/PrDiffView.tsx` is the PR's Diff tab, after Linear's PR review: a file tree grouped into Implementation / Tests / Documentation (`fileGroup` in `diff.ts`) with a filter, file cards with a "Reviewed" checkbox that is GitHub's own Viewed state (reviewed files fold away), a commit picker (all commits, since your last review, or one commit), split or unified view, and inline review threads filtered by All / Comments / Agents & bots. Patches come from the REST files endpoints (`pr_diff`), capped at 4 MB per answer, and each file only renders once it scrolls near the viewport. The file under the top of the scroll area is highlighted in the tree, and file headers stick to the top while you read them. "Since your last review" compares your review commit with the head and drops files that aren't in the PR, so a merged base branch doesn't flood it.
- Reviewing, like Linear: in the Diff tab (all commits, open PR), hover a line number and press + (or drag across lines) to open `views/LineComposer.tsx`. It has three modes: Agent queues the note on the thread working on the branch (`line_to_agent`), Comment posts one review comment now (`review_comment`), and Review adds it to the pending review. Pending comments live in `views/reviewDrafts.ts` (localStorage, per PR) and show under their lines. `views/ReviewBar.tsx` is the sticky bar under the PR: Approve in one click, or Submit review with a summary and Comment / Approve / Request changes (`review_submit`, which sends the pending comments with it). On your own PR only Comment is offered, since GitHub refuses the others.
- `views/SidebarPrBadges.tsx` puts a PR badge on sidebar rows, next to the Linear one: purple merge icon once merged, muted for closed or draft, green / amber / red for an open PR by checks (Orca's colors). It reads BB's own per-branch PR lookup, and a click opens the PR page.
- Thread ↔ PR links, like the Linear plugin's: a thread follows its branch's PR, and a manual link or unlink (SQLite table `thread_pr_links`, `link_get` / `link_set` / `link_reset`) wins over it. `bb github-kit link <url|owner/repo#N|#N>`, `unlink`, `relink` and `current` work from a thread, and `/github-kit link …` in the composer goes through the skill. `views/ThreadHeaderPr.tsx` puts "PR #123" (state-colored) or "Link PR" in the thread header; both open the Pull request tab, which has Change, Unlink and Use branch, and `views/PrLinkPicker.tsx` to search your PRs or paste a URL. Changes reach every open view through realtime.
- In a thread, clicking a GitHub PR link (chat messages, BB's "PR #123" chip above the composer, links in a description) opens the Pull request tab instead of the browser; another PR gets its own tab. Modifier and middle clicks still go to the browser, and our explicit "Open on GitHub" links carry `data-github-kit-external` so they do too. The listener lives in `views/ThreadHeaderPr.tsx`, which is mounted for as long as the thread is shown.
- `views/ThreadPrPanel.tsx` is the thread tab. It uses BB's own PR lookup for the thread, and falls back to a GitHub search on the branch name (`pr_for_branch`) when that finds nothing, which happens when the branch tracks the base branch.
- `views/DiffWithComments.tsx` is an opt-in diff renderer (Settings → Appearance → Diff renderer → "GitHub review comments"). In a thread whose branch has a PR, files with non-outdated review threads render through `@pierre/diffs` (the engine BB's own diff uses, shared at runtime) with each thread as an inline discussion under its line (Reply, Resolve, and "Send to thread"). Resolved ones start collapsed. Every other diff renders with BB's original renderer. Lines come from GitHub, so they match the pushed head: unpushed local edits can shift them.
- `views/uiState.ts` keeps UI state in sessionStorage, because BB unmounts the page when you leave it and reopens it on the bare route. That route (`/plugins/github-kit/pulls`) reopens your last PR on its last tab, commit range and file; `/pulls/list` always shows the list (the back button and the home section use it). The list keeps its scope and "Show closed" too.
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
