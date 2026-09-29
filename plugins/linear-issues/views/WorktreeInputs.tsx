import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginEnvironmentProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { rpcContract } from "../server";

// Mirrors linearWorktreeInputsSchema in worktree/provider.ts.
type Mode =
  | { kind: "auto" }
  | { kind: "new" }
  | { kind: "existing"; path: string };

const AUTO_VALUE: JsonValue = { branch: { kind: "default" } };

function readMode(value: unknown): Mode {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const candidate = value as { kind: unknown; path?: unknown };
    if (candidate.kind === "new") return { kind: "new" };
    if (candidate.kind === "existing" && typeof candidate.path === "string") {
      return { kind: "existing", path: candidate.path };
    }
  }
  return { kind: "auto" };
}

function toValue(mode: Mode): JsonValue {
  if (mode.kind === "existing") return { kind: "existing", path: mode.path };
  if (mode.kind === "new") return { kind: "new", branch: { kind: "default" } };
  return AUTO_VALUE;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

type Existing = { path: string; branch: string | null };

/** The composer control beside "Linear worktree": auto, always new, or adopt one. */
export function WorktreeInputs({ projectId, target, value, onChange }: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const mode = readMode(value);
  const [open, setOpen] = useState(false);
  const [existing, setExisting] = useState<Existing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostId = target.kind === "existing-host" ? target.hostId : null;

  useEffect(() => {
    if (value === null) onChange({ status: "ready", value: AUTO_VALUE });
  }, [value, onChange]);

  useEffect(() => {
    if (!open || projectId === null || hostId === null) return;
    let cancelled = false;
    setError(null);
    rpc.call("worktrees_existing", { projectId, hostId }).then(
      (result) => !cancelled && setExisting(result.worktrees),
      (cause) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, open, projectId, hostId]);

  const pick = (next: Mode) => {
    onChange({ status: "ready", value: toValue(next) });
    setOpen(false);
  };

  const selectedExisting = mode.kind === "existing" ? existing?.find((entry) => entry.path === mode.path) : undefined;
  const label =
    mode.kind === "auto"
      ? "Ticket branch"
      : mode.kind === "new"
        ? "New worktree"
        : (selectedExisting?.branch ?? basename(mode.path));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={`Worktree: ${label}`}
          className="inline-flex h-7 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Icon name={mode.kind === "existing" ? "FolderOpen" : "GitBranch"} className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground">Work on: </span>
            <span className="font-medium text-foreground">{label}</span>
          </span>
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} mobileTitle="Work on" className="w-80 p-1">
        <Option
          selected={mode.kind === "auto"}
          icon="GitBranch"
          title="Ticket branch"
          detail="Reuse the ticket's worktree or branch if one exists, else start fresh from the main branch"
          onSelect={() => pick({ kind: "auto" })}
        />
        <Option
          selected={mode.kind === "new"}
          icon="Plus"
          title="New worktree"
          detail="Always start fresh from the main branch (adds -2 if the branch is taken)"
          onSelect={() => pick({ kind: "new" })}
        />
        {hostId === null ? null : (
          <>
            <div className="my-1 h-px bg-border" />
            <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Existing worktrees</p>
            <div className="max-h-64 overflow-y-auto">
              {error !== null ? (
                <p className="px-2 py-2 text-xs text-destructive">{error}</p>
              ) : existing === null ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
              ) : existing.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">No other worktrees of this repository.</p>
              ) : (
                existing.map((entry) => (
                  <Option
                    key={entry.path}
                    selected={mode.kind === "existing" && mode.path === entry.path}
                    icon="FolderOpen"
                    title={entry.branch ?? "(detached)"}
                    detail={entry.path}
                    onSelect={() => pick({ kind: "existing", path: entry.path })}
                  />
                ))
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Option({
  selected,
  icon,
  title,
  detail,
  onSelect,
}: {
  selected: boolean;
  icon: string;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
        selected && "bg-accent/60",
      )}
    >
      <Icon name={icon} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        <span className="block truncate text-xs text-muted-foreground [direction:rtl] text-left">{detail}</span>
      </span>
      {selected ? <Icon name="Check" className="mt-0.5 size-3.5 shrink-0" /> : null}
    </button>
  );
}
