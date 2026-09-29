---
name: pi-custom-provider
description: "Inspect the custom BB Pi provider (pi-provider plugin): /reload, pi-toolbox subagents as native background tasks, Pi-loaded skills in the / menu, message editing, and compaction."
---

# Custom Pi provider

This plugin replaces bb's bundled Pi provider under the same provider id, `pi`.
Everything the bundled provider does still works: models, reasoning levels,
checkpoint forks, message editing (`bb thread edit-message`), and compaction of
idle or errored threads (`bb thread compact`). Inspect the thread first and use
live command help for arguments. Provider confirmation determines whether an
operation completed.

## /reload

Send `/reload` on its own in a Pi thread to restart that thread's Pi runtime
after updating Pi, Pi packages, or extensions. The same conversation, session
file, working directory, model, and thinking level are kept, and nothing reaches
the model. The row settles only once the new runtime reported ready. A failed
reload keeps the previous runtime and says so; send `/reload` again to retry.

`/reload` is refused, with the reason, while a turn is running or a pi-toolbox
background subagent is still running (a reload would cancel it). Wait, stop the
turn, or cancel the subagent first.

## Subagents

pi-toolbox (`@yteruel31/pi-subagents` with host lifecycle events, pi-toolbox
commit `ac4c248` or later) background runs show up as bb's native background
agent tasks under their `subagent_spawn` tool call and settle when the run
does, even after the turn ended. Only the run label and status cross into bb:
never prompts, transcripts, paths, results, or errors. Runs a session restores
as already finished are not shown again. A run that was live when Pi exited is
settled as stopped.

## Skills in the / menu

bb lists the skills Pi actually loaded, including ones Pi receives at runtime
(pi-toolbox or Claude-marketplace generated skills, git or npm Pi packages).
The list refreshes whenever a thread's Pi runtime starts, so run `/reload` after
installing, enabling, disabling, or removing a skill. Skills already under Pi's
documented directories are listed once.

Use the target host's provider catalog for available models and execution options.
