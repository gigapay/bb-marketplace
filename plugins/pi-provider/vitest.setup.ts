import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the bridge's loaded-skills record and command files out of ~/.bb.
process.env.BB_PI_PROVIDER_STATE_DIR ??= mkdtempSync(
  join(tmpdir(), "bb-pi-provider-state-"),
);
