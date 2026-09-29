import type {
  DeltaItemShape,
  DeltaPresentation,
  PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";

/**
 * `/reload` restarts this thread's `pi --mode rpc` process on the same session
 * file. Pi 0.87 has no RPC reload command (its `/reload` is interactive-only),
 * so a fresh process is the only way to pick up updated packages, extensions,
 * skills, and the pi binary itself.
 */
export const PI_RELOAD_COMMAND_NAME = "reload";

export const PI_RELOAD_COMMAND_DESCRIPTION =
  "Restart this thread's Pi runtime to load updated Pi packages and extensions. The conversation and settings are kept.";

export const PI_RELOAD_ITEM_SHAPE: DeltaItemShape = {
  type: "tool",
  tool: "pi_reload",
  args: {},
};

export const PI_RELOAD_PRESENTATION: DeltaPresentation = {
  label: { pending: "Reloading Pi runtime", completed: "Reloaded Pi runtime" },
  icon: { glyph: "RefreshCw" },
};

/**
 * True for an input that is exactly `/reload`: typed plainly, or picked from
 * the composer as this provider's command. A skill named `reload`, extra text,
 * or an attachment makes it an ordinary prompt.
 */
export function isStandaloneReloadCommand(
  input: readonly PromptInput[],
): boolean {
  if (input.length === 0 || input.some((item) => item.type !== "text")) {
    return false;
  }
  const texts = input.filter(
    (item): item is Extract<PromptInput, { type: "text" }> =>
      item.type === "text",
  );
  if (texts.map((item) => item.text).join("").trim() !== `/${PI_RELOAD_COMMAND_NAME}`) {
    return false;
  }
  return texts.every((item) =>
    item.mentions.every(
      (mention) =>
        mention.resource.kind === "command" &&
        mention.resource.source === "command" &&
        mention.resource.trigger === "/" &&
        mention.resource.name === PI_RELOAD_COMMAND_NAME,
    ),
  );
}

export interface PiReloadBusyState {
  reloading: boolean;
  processing: boolean;
  activeSubagents: number;
}

/** Why `/reload` must wait, as an actionable message; null when it can run. */
export function describeReloadBlocker(state: PiReloadBusyState): string | null {
  if (state.reloading) {
    return "Pi is already reloading this thread. Wait for it to finish.";
  }
  if (state.processing) {
    return "Pi is still working on this thread. Wait for the turn to finish (or stop it), then send /reload again.";
  }
  if (state.activeSubagents > 0) {
    const noun =
      state.activeSubagents === 1 ? "subagent is" : "subagents are";
    return `${state.activeSubagents} background ${noun} still running and a reload would cancel them. Wait for them to finish or cancel them, then send /reload again.`;
  }
  return null;
}

/** The command-file body bb lists in the composer for this provider. */
export function reloadCommandFileContent(): string {
  return [
    "---",
    `description: ${PI_RELOAD_COMMAND_DESCRIPTION}`,
    "---",
    "",
    "Handled by the bb Pi provider bridge; never sent to the model.",
    "",
  ].join("\n");
}
