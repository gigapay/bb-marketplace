Start a thread, pick Pi, and let the Pi coding agent work in your repository from bb. This is a fork of bb's bundled Pi provider that keeps everything it does and adds three things: pi-toolbox background subagents in bb's native agent display, a `/reload` command, and every skill Pi loaded in the `/` menu.

## What you get

- Everything from the bundled provider: reasoning levels from None to Max, checkpoint forks, manual compaction, Pi extension dialogs, health and install status.
- pi-toolbox subagents as native background agent tasks, attached to the `subagent_spawn` call that started them. They keep updating after the turn ends.
- `/reload` restarts the thread's Pi runtime on the same session after you update Pi packages or extensions. Busy threads are refused, never interrupted.
- Skills Pi loads at runtime (Pi packages, pi-toolbox, Claude marketplace generated skills) show up in the `/` menu.

## How it works

The plugin starts `pi` in RPC mode on the host and loads a small bb extension into it. That extension forwards pi-toolbox's lifecycle events (labels and statuses only) to the bridge, which turns them into bb's native background task items. Pi runs with full permissions in bb threads.

## Requirements

- Pi coding agent 0.84.0 or newer on the host (`npm install -g @earendil-works/pi-coding-agent`), signed in with `pi`.
- For native subagents: pi-toolbox with host lifecycle events (commit `ac4c248`, PR #88, or later).
- It uses the provider id `pi`, so disable bb's bundled `provider-pi` plugin before enabling this one.
