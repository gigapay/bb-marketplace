# bb-marketplace

Gigapay's BB plugin marketplace. It holds the plugins themselves under `plugins/` and the `marketplace.json` catalog that points at them.

## Add it to BB

```
bb marketplace add git:github.com/gigapay/bb-marketplace@main
```

Then install from the Plugins page, or run `bb plugin install linear-issues@gigapay`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [linear-issues](plugins/linear-issues) | Browse your Linear issues and start a BB thread from any ticket. |
| [github-kit](plugins/github-kit) | Your GitHub PRs in BB: live checks, reviewers, comments you can reply to and resolve, and inline review comments in the diff. |
| [usage-bar](plugins/usage-bar) | Always-visible provider usage bars in the sidebar footer, Orca style. |
| [machine-stats](plugins/machine-stats) | Live CPU, RAM and disk usage of the thread's machine, plus its staging slugs and Traefik services with a destroy button per slug, in one sidebar footer card. |
| [browser-markup](plugins/browser-markup) | Screenshot a desktop Browser tab, draw on it Orca style, then copy the image or add it to the prompt. |
| [pi-provider](plugins/pi-provider) | A fork of bb's Pi provider: pi-toolbox subagents in the native agent display, `/reload`, and every Pi-loaded skill in the `/` menu. Replaces the bundled `provider-pi` (same provider id), so disable that one first. |

## Releasing

Each plugin is tagged on its own with `<plugin-id>/vX.Y.Z`. The catalog uses the range `>=0.1.0 <1.0.0` (a plain `^0.x` would lock the minor version), so a new tag reaches users without editing `marketplace.json`:

1. Bump `version` in `plugins/<id>/package.json` in your pull request.
2. Merge it. The "Tag plugin releases" workflow (`.github/workflows/tag-releases.yml`) then tags `<id>/vX.Y.Z` on main for every plugin in `marketplace.json` whose version has no tag yet. On a pull request, its summary lists the tags merging would create.

A change without a version bump is merged but not released. To tag by hand, `git tag <id>/vX.Y.Z` and `git push origin <id>/vX.Y.Z` still work; the workflow skips tags that already exist.

Never move an existing tag. BB records the commit each tag pointed at and refuses the plugin if it changes. Ship a fix as a new version instead.

## Adding a plugin

Scaffold it with `bb plugin new <name>` inside `plugins/`. Then add an entry to `.bb/plugins.json` and to `marketplace.json`, and tag the first release.
