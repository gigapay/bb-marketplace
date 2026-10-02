// Runs inside the BB daemon of whichever machine the server targets, so every
// reading and docker call here is local to that machine.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { destroyStack, listStacks } from "./host-stacks.js";
import { snapshot } from "./host-stats.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    snapshot: (_input, context) => snapshot(context.signal),
    list_stacks: (_input, context) => listStacks(context.signal),
    destroy_stack: ({ slug }, context) => destroyStack(slug, context.signal),
  },
});
