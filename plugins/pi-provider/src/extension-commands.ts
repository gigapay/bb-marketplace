import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

/**
 * Pi extension commands (`pi.registerCommand`) sent through the RPC `prompt`
 * command run their handler in place: pi emits no `agent_start`/`agent_end`
 * and answers the prompt once the handler returned. Waiting for a run the
 * way ordinary prompts do would keep the bb turn working forever.
 */

const MAX_COMMANDS = 1024;
const MAX_NOTIFY_TEXT = 4_000;

/** The extension command names of a pi `get_commands` answer. */
export function extensionCommandNames(data: unknown): Set<string> {
  const names = new Set<string>();
  const commands =
    data && typeof data === "object" && Array.isArray((data as { commands?: unknown }).commands)
      ? (data as { commands: unknown[] }).commands
      : [];
  for (const command of commands.slice(0, MAX_COMMANDS)) {
    if (
      command &&
      typeof command === "object" &&
      (command as { source?: unknown }).source === "extension" &&
      typeof (command as { name?: unknown }).name === "string"
    ) {
      names.add((command as { name: string }).name);
    }
  }
  return names;
}

/** `extensions` for `/extensions` or `/extensions add foo`; null otherwise. */
export function leadingCommandName(text: string): string | null {
  const match = /^\/([^\s/]+)(?:\s|$)/u.exec(text.trimStart());
  return match ? (match[1] ?? null) : null;
}

/**
 * A `notify` an extension command raised, as a visible row. Outside a command
 * notifications stay dropped like upstream: extensions post many at startup.
 */
export function notifyDeltas(request: Record<string, unknown>): ThreadDelta[] {
  const raw = typeof request.message === "string" ? request.message.trim() : "";
  if (raw.length === 0) return [];
  const message = raw.length > MAX_NOTIFY_TEXT ? `${raw.slice(0, MAX_NOTIFY_TEXT)}…` : raw;
  const level = request.notifyType;
  if (level === "error") {
    return [{ kind: "provider.error", message: "Pi extension", detail: message }];
  }
  if (level === "warning") {
    return [
      { kind: "provider.warning", category: "general", summary: message, vouchedTurn: true },
    ];
  }
  return [
    {
      kind: "item.textClose",
      key: { channel: `pi-command-notify-${String(request.id ?? "")}` },
      channel: "agentMessage",
      text: message,
    },
  ];
}
