import { fileURLToPath } from "node:url";
import { handleLine } from "./bridge.js";
import { FULL_PERMISSION_OPTIONS, type FakePiBridgeHarness } from "./test-support.js";

/** Helpers shared by this fork's bridge tests (subagents, /reload, skills). */

export const fakeSubagentsPath = fileURLToPath(
  new URL("../subagents/fake-subagents-extension.mjs", import.meta.url),
);

const REQUEST_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
let nextSerial = 7000;

export function nextRequestId(): number {
  nextSerial += 1;
  return nextSerial;
}

/** A protocol-valid `creq_` id (its alphabet has no 0, 1, l, or o). */
export function clientRequestId(serial: number): string {
  let suffix = "";
  let rest = serial;
  for (let index = 0; index < 10; index += 1) {
    suffix = REQUEST_ID_ALPHABET[rest % REQUEST_ID_ALPHABET.length] + suffix;
    rest = Math.floor(rest / REQUEST_ID_ALPHABET.length);
  }
  return `creq_${suffix}`;
}

export function providerThreadIdFor(h: FakePiBridgeHarness, threadId: string): string {
  const identity = [...h.messages]
    .reverse()
    .find(
      (message) =>
        message.method === "thread/identity" &&
        (message.params as { threadId?: unknown }).threadId === threadId,
    );
  return String((identity?.params as { providerThreadId?: unknown }).providerThreadId);
}

type TextInput = { type: "text"; text: string; mentions: unknown[] };

export function textInput(text: string, mentions: unknown[] = []): TextInput[] {
  return [{ type: "text", text, mentions }];
}

/** Fire-and-forget turn/start; returns the request id to await a reply. */
export function turnStart(
  h: FakePiBridgeHarness,
  threadId: string,
  input: string | TextInput[],
  options: Record<string, unknown> = FULL_PERMISSION_OPTIONS,
): number {
  const id = nextRequestId();
  handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "turn/start",
      params: {
        threadId,
        providerThreadId: providerThreadIdFor(h, threadId),
        clientRequestId: clientRequestId(id),
        input: typeof input === "string" ? textInput(input) : input,
        options,
      },
    }),
  );
  return id;
}

export function replyTo(h: FakePiBridgeHarness, id: number) {
  return h.waitForMessage((message) => message.id === id, `the reply to ${id}`);
}
