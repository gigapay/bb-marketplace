# bb-marketplace

My personal BB plugin marketplace. It holds the plugins themselves under `plugins/` and the `marketplace.json` catalog that points at them.

## Add it to BB

```
bb marketplace add git:github.com/yteruel31/bb-marketplace@main
```

Then install from the Plugins page, or run `bb plugin install linear-issues@yteruel31`.

## Plugins

| Plugin | What it does |
| --- | --- |
| [linear-issues](plugins/linear-issues) | Browse your Linear issues and start a BB thread from any ticket. |

## Releasing

Each plugin is tagged on its own with `<plugin-id>/vX.Y.Z`. The catalog uses the range `>=0.1.0 <1.0.0` (a plain `^0.x` would lock the minor version), so a new tag reaches users without editing `marketplace.json`:

1. Bump `version` in `plugins/<id>/package.json`.
2. Commit, then tag with `git tag <id>/vX.Y.Z` and run `git push --follow-tags`.

Never move an existing tag. BB records the commit each tag pointed at and refuses the plugin if it changes. Ship a fix as a new version instead.

## Adding a plugin

Scaffold it with `bb plugin new <name>` inside `plugins/`. Then add an entry to `.bb/plugins.json` and to `marketplace.json`, and tag the first release.
