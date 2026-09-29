// Extension commands for the fake pi: one that only works in pi's TUI (like
// gigapay/pi-extension-manager's /extensions) and one that reports progress.
export default function fakeCommands(pi) {
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
}
