// Extension commands for the fake pi: one that only works in pi's TUI (like
// gigapay/pi-extension-manager's /extensions), one that reports progress, and
// a /subagents background stand-in that releases a parent wait while its child
// continues independently.
import { appendFileSync } from "node:fs";

export default function fakeCommands(pi) {
  let sequence = 0;
  const sessionId = "fake-command-session";
  const sourceId = "fake-command-source";
  let childToolCallId = null;
  const emitChild = (status) => {
    const event = {
      v: 1,
      sessionId,
      sourceId,
      sequence: ++sequence,
      kind: "upsert",
      run: {
        id: "command-child",
        label: "background child",
        toolCallId: childToolCallId,
        harness: "pi",
        status,
        createdAt: 1,
        ...(status === "completed" ? { settledAt: 2 } : {}),
      },
    };
    if (process.env.FAKE_PI_COMMAND_CHILD_LOG) {
      appendFileSync(process.env.FAKE_PI_COMMAND_CHILD_LOG, `${JSON.stringify(event)}\n`);
    }
    pi.events.emit("pi-toolbox:subagents:lifecycle", event);
  };

  pi.registerTool({
    name: "fake_command_child_spawn",
    description: "Test-only command child spawn stand-in",
    parameters: { type: "object", properties: {} },
    async execute(toolCallId) {
      childToolCallId = toolCallId;
      emitChild("queued");
      emitChild("running");
      return { content: [{ type: "text", text: "child started" }], details: {} };
    },
  });

  pi.registerCommand("tui-only", {
    description: "Needs the interactive TUI",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("This command requires Pi's interactive TUI.", "warning");
      }
    },
  });
  pi.registerCommand("slow-report", {
    description: "Reports after a while",
    async handler(args, ctx) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      ctx.ui.notify(`Done: ${args || "nothing"}`, "info");
    },
  });
  pi.registerCommand("subagents", {
    description: "Release subagent waits into the background",
    async handler(args, ctx) {
      if (args.trim() !== "background") return;
      ctx.ui.notify("Released 1 subagent wait; child work continues in the background.", "info");
      pi.releaseParentWait?.();
      // The child was created by /hold's opt-in tool call, before this command.
      // Keep its completion independent of the released parent turn.
      if (childToolCallId !== null) setTimeout(() => emitChild("completed"), 500);
    },
  });
  pi.registerCommand("fail-command", {
    description: "Fails after dispatch",
    async handler() {
      throw new Error("fake command failed");
    },
  });
}
