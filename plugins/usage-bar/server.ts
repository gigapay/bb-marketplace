import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULT_PREFS, PREFS_CHANGED, type UsagePrefs } from "./prefs";

// Lives here, not in prefs.ts, so zod stays out of the app bundle.
const prefsSchema = z.object({
  compact: z.boolean(),
  hideSignedOut: z.boolean(),
  hiddenProviders: z.array(z.string().min(1).max(200)).max(200),
  hiddenWindows: z.array(z.string().min(1).max(400)).max(500),
}) satisfies z.ZodType<UsagePrefs>;

// Usage itself is read in the app bundle (bb.sdk.system.usageLimits()); the
// server only keeps display prefs so every window and device agrees.
export const rpcContract = defineRpcContract({
  prefs_get: { input: z.null(), output: prefsSchema },
  prefs_set: { input: prefsSchema, output: prefsSchema },
});

const PREFS_KEY = "prefs.v1";

export default function plugin(bb: BbPluginApi): void {
  async function readPrefs(): Promise<UsagePrefs> {
    const parsed = prefsSchema.partial().safeParse(await bb.storage.kv.get(PREFS_KEY));
    return { ...DEFAULT_PREFS, ...(parsed.success ? parsed.data : {}) };
  }

  bb.rpc.register(rpcContract, {
    prefs_get: () => readPrefs(),
    prefs_set: async (prefs) => {
      await bb.storage.kv.set(PREFS_KEY, prefs);
      bb.realtime.publish(PREFS_CHANGED, prefs);
      return prefs;
    },
  });
}
