Adds a Linear page to the sidebar and ties your BB threads to your Linear tickets.

## What you get

Filter issues by label, priority or project. A Projects tab lists your projects with their health and progress. Open one to read its description and updates, see its issues, and write a new update. An agent can draft it from what changed since the last one, and you review it before posting.

The Linear page lists the issues assigned to you, created by you, or that you're subscribed to. They're grouped by workflow state, and you can search them or show done issues. A "With threads" tab shows only the issues that already have a BB thread, and every row shows how many threads it has.

Open an issue to read its description and sub-issues, follow its comment discussions (replies grouped under their comment, resolved ones folded away), post a comment or reply, and to see the threads linked to it. From there you can start a new thread. The composer is prefilled with the ticket and preselects the last project you used for that Linear team.

The home screen gets a "Linear issues" section with your most urgent open issues. Start one right into the composer above it, or jump to its latest thread.

You can also start from a ticket in BB's regular new-thread composer. Use the Linear button next to the send button, or "Start from a Linear issue" in the `+` menu. Picking a ticket fills the prompt and switches to a Linear worktree.

## Create and edit

Create issues and projects from the Linear page. Edit an issue's title, description, status, priority, assignee, labels, project and milestone in place. Edit or delete your comments and project updates. Agents get the same through `bb linear`: `create`, `update`, `comment`, `project-create`, `update-post` and more.

## Linear worktrees

The plugin adds a "Linear worktree" environment. It branches off the project's primary branch, directly on the ticket's Linear branch name, like `yoann/gig-123-fix-login`. You can choose where worktrees go on each machine with the Worktrees folder setting, for example `~/worktrees/<repo>/gig-123-fix-login`. If the ticket already has a worktree (from Orca or made by hand) it's reused, and an existing branch is picked up without being reset. You can also choose "New worktree" or pick any existing worktree from the "Work on" control. A second fresh worktree on the same ticket gets `-2`, so nothing is ever overwritten.

## Triage with Jev

"Triage with Jev" asks TypeSafe's Jev model to suggest a priority, type and area labels, and a project for every issue in your current list, flags tickets that need more information (with a ready-to-post comment listing what's missing, or an agent to draft it), and spots stale tickets that could be cancelled. The same button in the Projects tab reviews projects: overdue updates or deadlines, slipping pace, missing owners, a health that doesn't match reality, and projects that could be completed, paused or cancelled. You review each suggestion with its confidence and apply only the ones you keep. Nothing changes in Linear before that. It needs an OpenRouter API key. Issue text is sent to OpenRouter and TypeSafe, and OpenRouter bills the usage.

## How linking works

A thread is linked to an issue in three cases: it was started from the issue (from either composer), you linked it by hand, its worktree branch contains the identifier, or it runs in a worktree that's already linked (`yoann/gig-123-fix-login` links to `GIG-123`). Linked worktrees and threads get a Linear icon in the sidebar. Hover it to see the ticket's title and status. The thread header shows the linked issue. Click it to open a "Linear issue" tab in the thread's side panel, with the ticket's status, description and comments, and buttons to change or unlink it. A manual choice always wins over the branch.

Agents get `bb linear current`, `show`, `link` and `unlink`.

## Requirements

You need a Linear personal API key. Set it in the plugin settings, or run `bb plugin config linear-issues set apiKey <key>`. The key stays on the BB server. The plugin writes to Linear under your name when you, or an agent you asked, create or edit something. Nothing is permanently deleted: issues and updates are archived, and projects go to Linear's trash.
