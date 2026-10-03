# Pi provider (custom)

A fork of bb's bundled Pi provider for the [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). It keeps the bundled provider's behavior (sessions, models, reasoning levels, tools, extension dialogs, streaming, forks, compaction) and adds three things:

- pi-toolbox background subagents show up in bb's native background agent display, like Claude Code's.
- `/reload` restarts a thread's Pi runtime after you update Pi packages or extensions.
- Every skill Pi actually loaded appears in bb's `/` menu, including skills Pi only receives at runtime.

Pi is user-installed (`npm install -g @earendil-works/pi-coding-agent`, 0.84.0 or newer). The plugin ships no agent tree.

## Identity

| | |
| --- | --- |
| Plugin id | `pi-provider` |
| Provider id | `pi` (same as the bundled provider, on purpose) |
| Display name | Pi |

The provider id is shared with bb's bundled `provider-pi` plugin so existing Pi threads keep resolving to it. Pi session files live in `~/.bb/pi-bridge-sessions` on the host whatever the plugin, so a thread resumes on this provider without losing its conversation. bb rejects a second live registration of an id, so **disable the bundled plugin first** (see [Install](#install-and-validate)). The two can't run side by side.

## Provenance

Ported from [`get-bb/bb`](https://github.com/get-bb/bb) `plugins/provider-pi` at tag `desktop-v0.44.0`, commit [`0baa605b32a00619c1d7e3f32be6553ebcf8244a`](https://github.com/get-bb/bb/tree/0baa605b32a00619c1d7e3f32be6553ebcf8244a/plugins/provider-pi), which is the source of the installed bb 0.44.0 and of `@get-bb/plugin-sdk` 0.5.29. Upstream is MIT licensed (Copyright (c) 2026 Michael Yong); see [LICENSE](LICENSE). The contract research was done against `main` at [`66bbc1a`](https://github.com/get-bb/bb/tree/66bbc1a2d80bdaba936d9df6cd583953a5f23937); its `provider-pi` differs from the tag only by a `delta-translation.ts` tweak and a removed extension-UI test, and nothing this fork touches.

The only departures from the upstream package layout are what a marketplace plugin needs: the SDK is a pinned npm dependency instead of a workspace link, and `components/ui` plus `lib/utils.ts` are vendored from bb's plugin registry at `desktop-v0.44.0` (`components.json`) instead of `@bb/shared-ui`.

### What the fork changes

Upstream files edited (every change is marked "Fork addition" or sits in a clearly separate block):

- `src/declaration.ts`: state dir env passthrough, identity note.
- `src/extension-ui-contract.ts`: plugin id `pi-provider` (the interaction kind is plugin-scoped).
- `src/bridge/bb-pi-extension.ts`: pi-toolbox lifecycle subscription and projection.
- `src/bridge/rpc-session.ts`: lifecycle channel decoding, child-exit hook, `isBusy()`, `getCommands()`.
- `src/bridge/bridge.ts`: lifecycle wiring, `/reload`, loaded-skills recording.
- `src/native-roots.ts`, `src/host.ts`: resolved skill roots and the `/reload` command file.
- Tests and fixtures: `server.test.ts`, `src/bridge/extension-ui.test.ts`, `src/bridge/test-support.ts`, `src/bridge/fake-pi-rpc.mjs` (a shared `pi.events` bus, extra extensions, `get_commands`, `session_shutdown`, a delayed tool line).
- Packaging: `package.json`, `tsconfig.json`, `vitest.config.ts`, `skills/`.

New files: `src/subagents/*`, `src/reload-command.ts`, `src/loaded-skills.ts`, `vitest.setup.ts`, `scripts/smoke-built-bridge.mjs`, and the `*.test.ts` files named after them.

### Updating from upstream

1. Pick the bb release you run (`bb --version`) and its tag, `desktop-vX.Y.Z`. Check which `@get-bb/plugin-sdk` it ships: `git show desktop-vX.Y.Z:packages/plugin-sdk/package.json`.
2. Diff upstream between the pinned commit and the new tag: `git diff 0baa605 desktop-vX.Y.Z -- plugins/provider-pi packages/provider-bridge-protocol/src/thread-delta.ts`.
3. Apply that diff here. Conflicts can only land in the files listed above; keep the fork blocks.
4. Bump `@get-bb/plugin-sdk` to the matching version (`bb plugin types` repins it) and the `engines` ranges, re-vendor UI components if `components.json` changed, then update the commit and tag in this section.
5. Run `npm test`, `npm run typecheck`, `bb plugin build .`, and `npm run smoke`.

If upstream ever ships native pi-toolbox support, drop the matching fork blocks rather than keeping two paths.

## Native subagents

pi-toolbox's subagents package (`@yteruel31/pi-subagents`) publishes run lifecycle on Pi's in-process `pi.events` bus: `pi-toolbox:subagents:lifecycle` for events, and `pi-toolbox:subagents:lifecycle:request` for snapshot requests. This needs pi-toolbox commit [`ac4c248`](https://github.com/yteruel31/pi-toolbox/commit/ac4c24815a46c17e72d3b52af8374b74409e331b) (PR #88) or later. Older versions just show no tasks. The bus never reaches Pi's RPC stdout, so:

1. The generated bb extension subscribes when it loads and requests a snapshot (again at `session_start`), copies an allowlist (`id`, `label`, `toolCallId`, `harness`, `status`, `createdAt`, `settledAt`, and the optional display fields `agent`, `model`, `thinking`, plus the `v`/`sessionId`/`sourceId`/`sequence` envelope) with bounded lengths, and writes `{ kind: "subagents-lifecycle", event }` on FD 3. This envelope is private to this plugin, not a bb protocol.
2. `rpc-session.ts` validates it again with a strict schema (unknown fields, oversized values, wrong versions, and more than 256 snapshot runs are dropped) and delivers it in stdout order, idle or not.
3. `src/subagents/lifecycle-translator.ts` keeps per-thread run state apart from the per-turn tool state and emits bb's native `backgroundTask` items (`taskType: "local_agent"`, `skipTranscript: false`, `parentRef` = Pi's `execute` tool-call id, so the task nests under its `subagent_spawn` call).

| pi-toolbox | bb `taskStatus` | bb item `status` |
| --- | --- | --- |
| queued | pending | pending |
| running | running | pending |
| completed | completed | completed |
| failed | failed | failed |
| cancelled | stopped | interrupted |

The task row reads `label (agent) · model · thinking`, e.g. `Recapture dialogs (designer) · openai-codex/gpt-5.6-sol · high`. `agent` is the agent-file profile, which pi-toolbox only sends for runs spawned with `subagent_spawn.agent`. Ad-hoc runs show no profile, like pi-toolbox's own UI. The profile is skipped when the label already is it. `model` is pi-toolbox's `effectiveModel ?? requestedModel`, and the row updates when routing resolves it. BB 0.44's `backgroundTask` has no model field, so the text carries it. These fields need a pi-toolbox version that publishes them. Older ones just show the label.

The behaviors that make it hold together:

- FD 3 is written synchronously and stdout isn't, so a run often reports `queued` before Pi's `tool_execution_start` line. Runs wait for their spawn tool item, then open under it. If it never shows up (1.5 s), the run opens against the current or last turn, but only if a turn existed in this bridge lifetime.
- `item.open` uses `attach: "currentOrLast"`. Progress and completion are thread-scoped in bb's assembler, so a run keeps updating after `tool_execution_end` and after the parent `agent_end`. No turn is ever synthesized.
- Identity is `(sessionId, run.id)`, encoded into `providerItemId`/`familyId` as `pi-subagent:<sessionId>:<runId>` (both parts URI-encoded). The same `run-1` in two sessions gives two tasks.
- Stale sequences and repeated snapshots never reopen or duplicate a task. The first terminal state wins (a cancel/complete race can't flip it).
- A new `sourceId` for a session (reload, rebuild) supersedes older live ones. An old publisher may still settle its own runs (shutdown cancellation) but can't move them forward.
- Each pi child is an owner: its events are held while it is still constructing, applied once it reported ready, and dropped if its construction fails. That way a replacement that published and then failed can't hijack the runs of the child that survives.
- bb's assembler forgets a thread's turns and item ids on `session.reset`, which follows every new pi child (start, resume, settings rebuild, `/reload`). Open tasks are settled as stopped just before it, so a later close can't mint a duplicate row.
- A run seen for the first time already settled (a restored run: interrupted runs restore as `failed`) is not displayed. Neither are runs without a tool-call origin (command-created).
- `clear`, a Pi child exit (after a 250 ms drain, since real Pi does not always run `session_shutdown` on stdin EOF), and bridge shutdown settle still-open tasks as stopped. bb core also settles dangling background tasks when a thread stops. Discarding a thread drops its state so late events can't create ghosts.

Nothing else crosses: no prompts, transcripts, working directories, results, or error text.

Known limits:

- Command-created runs, and runs that start before any turn in the bridge's lifetime, are tracked (they block `/reload`) but not displayed. There's no spawn call to hang them under, and no turn to attach them to.
- A terminal update pi-toolbox sends in a shape the bridge rejects is dropped. The task then stays open until a `clear`, a child exit, or a thread stop settles it.
- A settings change that rebuilds pi (model, thinking level, env) still cancels running subagents, like upstream. The tasks settle as stopped.

## /reload

Pi 0.87 has no RPC reload. Its `/reload` is interactive-only, and `ctx.reload()` exists only for extension command handlers, where it would also leave the bridge's FD 4 reader duplicated. So `/reload` restarts the thread's `pi --mode rpc` child through the same rebuild path the bundled provider already uses when execution settings change. It's the same session file and provider thread id, with the same cwd, model, thinking level, env, tools, and prompts.

- Input that is exactly `/reload`, typed or picked from the composer, is handled by the bridge and never sent to the model. `/reload now` is an ordinary prompt, and so is a skill named `reload`.
- The host entry offers `/reload` in the composer as a `command-file` root under the provider state dir (`~/.bb/pi-provider/commands/reload.md`). It's scoped to this provider only.
- It's refused with an actionable error while a turn, compaction, queued input, or another `turn/start` is in flight (on `turn/start` and `turn/steer`), or while a pi-toolbox subagent is still running, even one that isn't displayed, since a restart would cancel it.
- The reload row settles only after the new child reported ready, and before the `session.reset` that follows it. If the new child fails, the previous runtime stays active and the row says so. Just send `/reload` again. Turns, stops, and discards sent during a reload wait for it.

## Pi extension commands

Pi runs an extension command (`pi.registerCommand`) sent through RPC `prompt` in place: it emits no `agent_start`/`agent_end` and answers the prompt once the handler returned. The bundled provider waits for an agent run, so such a turn stays "Working" forever. This fork checks the child's `get_commands` catalog: a prompt whose first word is one of its extension commands (`/extensions`, `/subagents`, ...) opens and settles its own turn when pi answers, or when the run the handler started (`pi.sendMessage`) ends. `notify` calls made while the command runs show up as the command's output (info as a message, warnings and errors as notices); outside a command they stay dropped, like upstream.

Commands built only for Pi's interactive TUI (`ctx.ui.custom`, or a `ctx.mode !== "tui"` guard like gigapay/pi-extension-manager's `/extensions`) can't render in bb; you now see their notice instead of a stuck turn. Extension commands aren't listed in the `/` menu (bb's command roots need files), but typing them works.

When `/subagents background` is sent during an active turn, it is dispatched as Pi's registered extension command rather than ordinary steering text. The parent wait yields cooperatively; sibling work and native child runs stay live and may settle later. This is distinct from **Stop**, which still cancels children. Update pi-toolbox to a version containing that command before using it; this repository change does not deploy or update Pi packages.

## Skills in the / menu

bb scans the directories a provider declares or resolves on the host. Pi also loads skills it only learns about at runtime: `resources_discover` results from extensions (pi-toolbox or Claude marketplace generated skills), git and npm Pi packages, `settings.json` file entries. Upstream's resolver can't see those.

Each time a thread's Pi child becomes ready (start, resume, rebuild, `/reload`), the bridge asks Pi for `get_commands` and records the skills it loaded, per workspace, in `~/.bb/pi-provider/loaded-skills/<hash>.json`. The host entry's `resolveNativeRoots` returns them as `skill-file` roots, next to upstream's roots:

- Names and descriptions come from each `SKILL.md`, the same file Pi read, with Pi's name as `fallbackName`. Invocation stays `/skill:<name>`.
- bb's own skills (the `--skill` roots bb hands Pi) are excluded by path. Pi reports them as `temporary`, just like extension-supplied skills.
- Skills under a declared or settings-resolved root are skipped, since bb already lists them once. Duplicate names keep Pi's first.
- Disabled skills are absent because Pi doesn't load them. A skill whose file is gone is dropped at listing time. The record is replaced on every runtime start, so run `/reload` after changing skills.

Prompt templates and extension commands from `get_commands` are not listed: bb's command roots need files, and extension commands have none.

`BB_PI_PROVIDER_STATE_DIR` moves the state dir (default `~/.bb/pi-provider`).

## Upstream notes

### Skills

The registration declares Pi's documented directories (`experimental_nativeSkillRoots`): `user` is `.pi/agent/skills` and `.agents/skills` under the host's home, and `project` is `.pi/skills` and `.agents/skills` under the workspace. The host entry adds what only the host knows: `<agentDir>/settings.json` `skills` directory entries, and `<agentDir>/skills` when `PI_CODING_AGENT_DIR` moves the agent dir.

### Extension dialogs

`ctx.ui.select/confirm/input/editor` inside a Pi extension arrive as Pi RPC `extension_ui_request` lines. The bridge forwards each dialog as a `pi-provider/extension-ui` interaction, and `app.tsx` renders it. Fire-and-forget requests (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are dropped. A dialog left pending when the session closes is answered cancelled.

### Environment

`BB_PI_BRIDGE_COMMAND` and `BB_PI_BRIDGE_ARGS` point the bridge at a Pi executable other than the `pi` on `PATH`. `BB_PI_BRIDGE_SESSION_DIR` moves the session files. These and `BB_PI_PROVIDER_STATE_DIR` are declared as environment passthrough.

## Tests

```
npm install --legacy-peer-deps   # npm 10.9 trips on vitest's optional peers otherwise
npm test
npm run typecheck
bb plugin build .
npm run smoke                    # runs the built dist/host.js
```

The bridge tests drive `src/bridge/fake-pi-rpc.mjs`, a scripted `pi --mode rpc` that loads the real generated bb extension. `src/subagents/fake-subagents-extension.mjs` speaks pi-toolbox's lifecycle contract on the fake's `pi.events` bus. `src/subagents/pi-toolbox-contract.test.ts` runs the real pi-toolbox `LifecyclePublisher` when it is installed in Pi's git cache (or at `PI_TOOLBOX_SUBAGENTS_DIR`), and is skipped otherwise. `scripts/smoke-built-bridge.mjs` runs the built `dist/host.js` the way bb's runtime spawns it.

These prove the bridge emits the right native deltas and that bb's production assembler (from the SDK testing kit) turns them into native task rows. They don't prove how bb's UI renders them. That needs the live check below.

## Install and validate

Managed installs need the plugin on a git ref the bb server can fetch, so this needs a push first (branch or `pi-provider/v0.1.0` tag). Nothing here is installed yet.

1. Pick a quiet moment: no Pi turn running. The switch unloads the bundled provider, and open Pi threads show "provider unavailable" until this one is enabled.
2. `bb plugin disable provider-pi`. This is reversible, and keeps its settings. `bb plugin uninstall provider-pi` also deletes its settings, and a bundled plugin may come back with a bb update.
3. Install this plugin, either from a pushed branch: `bb plugin install git:github.com/gigapay/bb-marketplace@<branch> --plugin pi-provider`, or from the marketplace once tagged: `bb plugin install pi-provider@gigapay`.
4. `bb plugin list` should show `pi-provider` running. Then check it in a Pi thread:
   - The `/` menu lists `/reload` and Pi package skills (e.g. `gig-plan`, Claude marketplace `claude-*` skills).
   - Ask Pi to spawn a pi-toolbox subagent with a name. A background agent row appears under the `subagent_spawn` call, stays live after the reply, and settles when the run ends.
   - Send `/reload` while idle. You get a "Reloaded Pi runtime" row and the same conversation. Send it while a subagent runs, and it's refused.
5. Roll back with `bb plugin disable pi-provider`, then `bb plugin enable provider-pi`.
