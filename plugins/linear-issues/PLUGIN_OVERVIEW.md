Adds a Linear page to the sidebar. It lists the issues assigned to you, created by you, or that you're subscribed to, grouped by workflow state, with search and a "show done" toggle.

Open an issue to read its description, sub-issues, and comments, copy its branch name, or start a thread from it. The thread composer is prefilled with the ticket, and agents get a `bb linear-issues show <identifier>` command to reread the full issue.

Set your Linear personal API key in the plugin settings (or `bb plugin config linear-issues set apiKey <key>`). The key stays on the server.
