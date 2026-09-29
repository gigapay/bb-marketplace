// Server ↔ host RPC for the one thing that must run next to the checkout:
// renaming a freshly created worktree branch to the Linear branch name.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  renameBranch: {
    input: z
      .object({
        path: z.string().min(1),
        from: z.string().min(1).max(250),
        to: z.string().min(1).max(250),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("renamed"), branch: z.string() }).strict(),
      z.object({ status: z.literal("skipped"), reason: z.string() }).strict(),
    ]),
  },
});
