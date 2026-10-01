// The plugin's own id, injected by `bb plugin build`. Never hard-code it:
// a copy installed under another id (say, to test a branch side by side)
// must still find its icons, its upload proxy and its scoped CSS.
declare const __BB_PLUGIN_ID__: string | undefined;

export const PLUGIN_ID = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : "linear-issues";

/** The Linear mark declared in the manifest's `experimental_icons`. */
export const LINEAR_ICON = `${PLUGIN_ID}/linear`;
