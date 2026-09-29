import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Frontend-only plugin: usage comes from bb.sdk.system.usageLimits() in the
// app bundle. `bb plugin build` still needs a server entry.
export default function plugin(_bb: BbPluginApi): void {}
