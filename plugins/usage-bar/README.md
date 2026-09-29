# bb-plugin-usage-bar

A BB plugin that keeps your provider usage on screen. It pins a compact card above the sidebar footer icons with one block per provider (Claude Code, Codex, ...) and one bar per quota window: session (5h), weekly (7d), and model-specific windows like Fable. Bars drain like a battery: each row shows the percentage left and the time until it resets. Hover a row for the full label and reset date.

It's the same data as the built-in Provider usage plugin (`bb.sdk.system.usageLimits()` on the primary machine), just laid out like Orca's status bar so you don't have to click to see it.

## How it stays visible

BB's sidebar footer only offers click-to-open disclosures, so the plugin opens its own disclosure on load and re-opens it when it closes for any other reason than you clicking its icon (Escape, the sidebar remounting, another plugin's panel closing).

- Click the chart icon in the footer to hide the card. Click it again to pin it back. The choice is saved per browser.
- If another plugin opens its footer panel, the usage card steps aside and comes back when that panel closes.
- Hide the icon from the footer (right-click → Hide from footer) or move it into More and the card stops auto-opening.

## Refresh

Usage is fetched when the card mounts, every 2 minutes while the window is visible, when the window regains focus (if older than a minute), and a few seconds after a thread finishes a turn. The refresh button in the card forces a fetch.

## Limits

It only reads the primary machine's providers. Shared account pools and other machines are what the built-in Provider usage plugin is for. While the card is open, BB's footer treats Escape as "close disclosure", so the card flickers closed and reopens on Escape.

## Develop

```
npm install
bb plugin build
```

The BB server has to be able to read the source, so install from Git when BB runs on another machine:

```
bb plugin install git:https://github.com/yteruel31/bb-marketplace.git@main --subdirectory plugins/usage-bar
```
