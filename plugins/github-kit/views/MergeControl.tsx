// Merge button for the PR's top bar, like Linear's: "Merge" when GitHub says
// the PR can merge now, otherwise an "Auto merge" switch that merges it once
// reviews and checks pass. Merging asks for a confirmation first.
import { useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { PrDetail } from "../detail";
import type { rpcContract } from "../server";
import { MenuItem, Popover } from "./Popover";
import { errorText } from "./shared";

type Method = PrDetail["merge"]["methods"][number];

const METHOD_LABEL: Record<Method, string> = {
  MERGE: "Create a merge commit",
  SQUASH: "Squash and merge",
  REBASE: "Rebase and merge",
};

// UNSTABLE means only non-required checks fail, which GitHub still merges.
const MERGEABLE = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

export function MergeControl({ pr, headSha, onChanged }: { pr: PrDetail; headSha: string | null; onChanged: () => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);
  const methods = pr.merge.methods;
  const [method, setMethod] = useState<Method>(methods.includes(pr.merge.defaultMethod) ? pr.merge.defaultMethod : (methods[0] ?? "MERGE"));

  if (pr.state !== "OPEN" || pr.isDraft || methods.length === 0) return null;

  const run = (promise: Promise<unknown>, message: string) => {
    setPending(true);
    promise.then(
      async () => {
        toast.success(message);
        setPending(false);
        await onChanged();
      },
      (cause) => {
        toast.error(errorText(cause));
        setPending(false);
      },
    );
  };

  if (MERGEABLE.has(pr.mergeStateStatus)) {
    return (
      <Popover
        align="end"
        className="w-72 p-2"
        trigger={({ toggle }) => (
          <Button size="sm" onClick={toggle} disabled={pending || headSha === null} className="h-8 gap-1.5 rounded-full bg-indigo-500 px-3.5 text-white hover:bg-indigo-500/90">
            <Icon name={pending ? "Loading" : "GitMerge"} className={cn("size-4", pending && "animate-spin")} />
            Merge
          </Button>
        )}
      >
        {(close) => (
          <div className="space-y-2">
            <p className="px-1 text-sm">
              Merge <span className="font-mono">#{pr.number}</span> into <span className="font-mono">{pr.baseRefName}</span>?
            </p>
            {methods.length > 1 ? (
              <div className="space-y-0.5">
                {methods.map((option) => (
                  <MenuItem key={option} checked={option === method} onSelect={() => setMethod(option)}>
                    {METHOD_LABEL[option]}
                  </MenuItem>
                ))}
              </div>
            ) : (
              <p className="px-1 text-xs text-muted-foreground">{METHOD_LABEL[method]}</p>
            )}
            {pr.mergeStateStatus === "UNSTABLE" ? (
              <p className="px-1 text-xs text-amber-500">Some optional checks are failing.</p>
            ) : null}
            <Button
              size="sm"
              className="w-full bg-indigo-500 text-white hover:bg-indigo-500/90"
              onClick={() => {
                close();
                run(rpc.call("pr_merge", { key: pr.key, method, expectedHeadSha: headSha! }), `Merged #${pr.number}`);
              }}
            >
              Confirm merge
            </Button>
          </div>
        )}
      </Popover>
    );
  }

  if (!pr.merge.autoMergeAllowed) return null;
  const enabled = pr.merge.autoMerge !== null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={pending}
      title={enabled ? `Merges automatically once requirements pass${pr.merge.autoMerge?.enabledBy ? ` (enabled by ${pr.merge.autoMerge.enabledBy})` : ""}` : "Merge automatically once reviews and checks pass"}
      onClick={() => run(rpc.call("pr_auto_merge", { key: pr.key, enabled: !enabled, method }), enabled ? "Auto-merge turned off" : "Auto-merge turned on")}
      className="inline-flex h-8 items-center gap-2 rounded-full border border-border px-3 text-sm hover:bg-accent/50 disabled:opacity-60"
    >
      Auto merge
      <span className={cn("relative h-4 w-7 rounded-full transition-colors", enabled ? "bg-indigo-500" : "bg-muted-foreground/40")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-white transition-all", enabled ? "left-3.5" : "left-0.5")} />
      </span>
    </button>
  );
}
