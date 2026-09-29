import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";

const run = promisify(execFile);

async function git(path: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await run("git", ["-C", path, ...args], { signal, timeout: 15_000 });
  return stdout.trim();
}

async function branchExists(path: string, branch: string, signal: AbortSignal): Promise<boolean> {
  try {
    await git(path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], signal);
    return true;
  } catch {
    return false;
  }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    renameBranch: async ({ path, from, to }, context) => {
      const signal = context.signal;
      const current = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
      // Only touch the branch BB just created; anything else means someone
      // (or the agent) already switched, and we leave it alone.
      if (current !== from) return { status: "skipped" as const, reason: `HEAD is on ${current}, not ${from}` };
      try {
        await git(path, ["check-ref-format", "--branch", to], signal);
      } catch {
        return { status: "skipped" as const, reason: `${to} is not a valid branch name` };
      }
      // A second thread on the same ticket gets `<branch>-2`, `-3`, …
      let target = to;
      for (let suffix = 2; await branchExists(path, target, signal); suffix += 1) {
        if (suffix > 20) return { status: "skipped" as const, reason: `${to} and its suffixes are taken` };
        target = `${to}-${suffix}`;
      }
      await git(path, ["branch", "-m", from, target], signal);
      return { status: "renamed" as const, branch: target };
    },
  },
});
