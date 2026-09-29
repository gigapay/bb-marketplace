Adds a Linear page to the sidebar and ties your BB threads to your Linear tickets.

## What you get

The Linear page lists the issues assigned to you, created by you, or that you're subscribed to. They're grouped by workflow state, and you can search them or show done issues. A "With threads" tab shows only the issues that already have a BB thread, and every row shows how many threads it has.

Open an issue to read its description and sub-issues, follow its comment discussions (replies grouped under their comment, resolved ones folded away), post a comment or reply, and to see the threads linked to it. From there you can start a new thread. The composer is prefilled with the ticket and preselects the last project you used for that Linear team.

The home screen gets a "Linear issues" section with your most urgent open issues. Start one right into the composer above it, or jump to its latest thread.

You can also start from a ticket in BB's regular new-thread composer. Use the Linear button next to the send button, or "Start from a Linear issue" in the `+` menu. Picking a ticket fills the prompt and switches to a Linear worktree.

## Linear worktrees

The plugin adds a "Linear worktree" environment. It branches off the project's primary branch, directly on the ticket's Linear branch name, like `yoann/gig-123-fix-login`. You can choose where worktrees go on each machine with the Worktrees folder setting, for example `~/worktrees/<repo>/gig-123-fix-login`. If the ticket already has a worktree (from Orca or made by hand) it's reused, and an existing branch is picked up without being reset. You can also choose "New worktree" or pick any existing worktree from the "Work on" control. A second fresh worktree on the same ticket gets `-2`, so nothing is ever overwritten.

## How linking works

A thread is linked to an issue in three cases: it was started from the issue (from either composer), you linked it by hand, its worktree branch contains the identifier, or it runs in a worktree that's already linked (`yoann/gig-123-fix-login` links to `GIG-123`). Linked worktrees and threads get a Linear icon in the sidebar. Hover it to see the ticket's title and status. The thread header shows the linked issue. Click it to open a "Linear issue" tab in the thread's side panel, with the ticket's status, description and comments, and buttons to change or unlink it. A manual choice always wins over the branch.

Agents get `bb linear-issues current`, `show`, `link` and `unlink`.

## Requirements

You need a Linear personal API key. Set it in the plugin settings, or run `bb plugin config linear-issues set apiKey <key>`. The key stays on the BB server. The only thing the plugin ever writes to Linear is a comment or reply that you send yourself from a ticket.
