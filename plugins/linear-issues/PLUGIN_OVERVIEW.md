Adds a Linear page to the sidebar and ties your BB threads to your Linear tickets.

## What you get

The Linear page lists the issues assigned to you, created by you, or that you're subscribed to. They're grouped by workflow state, and you can search them or show done issues. A "With threads" tab shows only the issues that already have a BB thread, and every row shows how many threads it has.

Open an issue to read its description, sub-issues and comments, and to see the threads linked to it. From there you can start a new thread. The composer is prefilled with the ticket and preselects the last project you used for that Linear team.

## How linking works

A thread is linked to an issue in three cases: it was started from the issue, you linked it by hand, or its worktree branch contains the identifier (`yoann/gig-123-fix-login` links to `GIG-123`). The thread header shows the linked issue, and you can link, change or unlink it from there. A manual choice always wins over the branch.

Agents get `bb linear-issues current`, `show`, `link` and `unlink`.

## Requirements

You need a Linear personal API key. Set it in the plugin settings, or run `bb plugin config linear-issues set apiKey <key>`. The key stays on the BB server. The plugin never writes to Linear.
