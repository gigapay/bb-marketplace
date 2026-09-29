import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { PI_PROVIDER_STATE_DIR_ENV } from "./loaded-skills.js";
import { PI_NATIVE_ROOTS_DECLARATION } from "./native-roots.js";

/**
 * Same provider id as bb's bundled Pi provider on purpose: this plugin
 * replaces it, so existing Pi threads keep resolving. bb rejects a second
 * live registration of an id, so the bundled `provider-pi` plugin must be
 * disabled first.
 */

export function piProviderDeclaration(): PluginProviderDeclaration {
  return {
    id: "pi",
    displayName: "Pi",
    icon: "./icons/pi.svg",
    strings: {
      signInHint: "Run `pi` on the machine to sign in.",
      expiredHint: "Your Pi session expired. Run `pi`, then reload.",
      installUrl: "https://pi.dev",
      iconTint: { light: "#6D5DFB", dark: "#6D5DFB" },
    },
    maintenance: { health: true, usage: false, installation: true },
    env: {
      passthrough: [
        "BB_PI_BRIDGE_COMMAND",
        "BB_PI_BRIDGE_ARGS",
        PI_PROVIDER_STATE_DIR_ENV,
      ],
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    ...PI_NATIVE_ROOTS_DECLARATION,
    composerActions: [],
  };
}
