# bb-plugin-github-kit

My own GitHub plugin for BB, meant to replace the bundled `github` one. It starts small: a GitHub page in the sidebar that lists your pull requests.

## Setup

The plugin needs a GitHub token with the `repo` and `read:org` scopes. If the machine running the BB server has `gh` logged in, there's nothing to do, it uses `gh auth token`. Otherwise set a personal access token in Settings → Plugins → GitHub Kit, or run:

```
bb plugin config github-kit set token <token>
```

It's a secret setting, so it stays on the BB server and never reaches the browser. The setting wins over `gh` when both exist.

## What's in it

- `server.ts` is the backend. It holds the GitHub GraphQL client, the RPC contract used by the page, and the `bb github-kit` CLI.
- `shared/search.ts` builds the GitHub search string for each scope (covered by `npm test`).
- `app.tsx` registers the GitHub page (`/plugins/github-kit/pulls`).
- `views/PullRequestList.tsx` is the list. Scopes are Review requested, Created, Assigned and Involved. There's a search box that takes GitHub qualifiers (`repo:owner/name`, `label:bug`), a "Show closed" toggle, and PRs are grouped by repository. Each row shows state, branch, labels, review decision, checks, diff size and last update, and opens the PR on GitHub.
- `views/icons.tsx` has the inline PR and checks glyphs.
- `skills/github-kit/SKILL.md` tells agents how to use `bb github-kit prs`.

## Develop

```
npm install
npm test
bb plugin build
```
