---
name: linear-issues
description: Read Linear issues with the `bb linear-issues` CLI. Use when a thread was started from a Linear issue, when the prompt names an issue identifier such as ENG-42, or when the user asks about their assigned Linear tickets.
---

# Linear issues

The Linear plugin reads issues with the user's own Linear API key. It is read-only: it never changes an issue.

| Command | Effect |
| --- | --- |
| `bb linear-issues list` | List the user's open assigned issues with identifier, state, and title. |
| `bb linear-issues show <identifier>` | Print one issue: metadata, suggested branch, description, and comments. |

Add `--json` when the output drives code.

When a thread was started from an issue, its prompt carries a truncated copy of the ticket. Run `bb linear-issues show <identifier>` before you plan the work so you see the full description and the comment thread. Prefer the suggested branch name when you create a branch for the issue.

If a command fails with "Linear API key is not configured", tell the user to set it with `bb plugin config linear-issues set apiKey <key>`. Never ask them to paste the key into the chat.
