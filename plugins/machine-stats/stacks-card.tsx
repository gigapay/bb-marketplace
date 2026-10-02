// Bottom of the Machine card: the staging slugs and Traefik services running
// on the machine's docker engine, with a destroy button per slug.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { CleanupStatus, rpcContract, Stack, StackListing } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// The card only mounts while the disclosure is open, so polling costs nothing
// when it's closed.
const POLL_INTERVAL_MS = 10_000;
// The server caches ticket and PR lookups for five minutes anyway.
const CLEANUP_INTERVAL_MS = 5 * 60_000;

function useListing(hostId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<StackListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    setListing(null);
    setError(null);
  }, [hostId]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      rpc
        .call("list_stacks", { hostId })
        .then(
          (next) => {
            if (cancelled) return;
            setListing(next);
            setError(null);
          },
          (cause: unknown) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, hostId, nonce]);

  return { listing, error, refresh, nonce };
}

/** Which slugs are done in Linear with their PRs merged, keyed by slug. */
function useCleanup(hostId: string | null, slugs: string[], nonce: number) {
  const rpc = useRpc<typeof rpcContract>();
  const [statuses, setStatuses] = useState<Map<string, CleanupStatus>>(new Map());
  const lastNonce = useRef(nonce);
  const slugKey = slugs.join(",");

  useEffect(() => {
    setStatuses(new Map());
  }, [hostId]);

  useEffect(() => {
    const ids = slugKey === "" ? [] : slugKey.split(",");
    if (ids.length === 0) return;
    // A manual refresh also skips the server's cache.
    const fresh = lastNonce.current !== nonce;
    lastNonce.current = nonce;
    let cancelled = false;
    const load = (skipCache: boolean) => {
      if (document.visibilityState === "hidden") return;
      rpc.call("cleanup_status", { hostId, slugs: ids, fresh: skipCache }).then(
        (next) => {
          if (!cancelled) setStatuses(new Map(next.map((status) => [status.slug, status])));
        },
        // Best effort: the rows just go without a badge.
        () => {},
      );
    };
    load(fresh);
    const timer = window.setInterval(() => load(false), CLEANUP_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpc, hostId, slugKey, nonce]);

  return statuses;
}

function CleanupBadge({ cleanup }: { cleanup: CleanupStatus | undefined }) {
  if (cleanup === undefined) return null;
  const title = [cleanup.reason, cleanup.worktreeMissing ? "Its worktree is gone." : null]
    .filter(Boolean)
    .join(" ");
  if (cleanup.verdict === "ready") {
    return (
      <span
        title={`Safe to destroy: ${title}`}
        className="shrink-0 rounded bg-success/15 px-1 text-2xs leading-4 text-success"
      >
        done
      </span>
    );
  }
  if (cleanup.worktreeMissing) {
    return (
      <span
        title={title}
        className="shrink-0 rounded bg-warning/15 px-1 text-2xs leading-4 text-warning"
      >
        no worktree
      </span>
    );
  }
  return null;
}

function formatAge(createdAt: number | null): string | null {
  if (createdAt === null) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// app-gig-5697.yoann.gigapay.dev -> "app"; bb.yoann.gigapay.dev -> "bb".
function hostLabel(host: string, stack: Stack): string {
  const first = host.split(".")[0] ?? host;
  if (stack.kind !== "staging") return first;
  const suffix = `-${stack.id}`;
  if (first.endsWith(suffix)) return first.slice(0, -suffix.length) || first;
  return first === stack.id ? "web" : first;
}

function health(stack: Stack): { tone: "ok" | "partial" | "down"; label: string } {
  const running = stack.containers.filter((c) => c.state === "running").length;
  const unhealthy = stack.containers.filter((c) => c.health === "unhealthy").length;
  const total = stack.containers.length;
  const label = `${running}/${total} running${unhealthy > 0 ? `, ${unhealthy} unhealthy` : ""}`;
  if (running === 0) return { tone: "down", label };
  if (running < total || unhealthy > 0) return { tone: "partial", label };
  return { tone: "ok", label };
}

const DOT_CLASS = {
  ok: "bg-success",
  partial: "bg-warning",
  down: "bg-muted-foreground",
} as const;

function HostLinks({ stack }: { stack: Stack }) {
  if (stack.hosts.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {stack.hosts.map((host) => (
        <UrlLink
          key={host}
          href={`https://${host}`}
          target="_blank"
          title={host}
          className="rounded bg-sidebar-accent px-1 text-2xs leading-4 text-subtle-foreground hover:text-sidebar-foreground"
        >
          {hostLabel(host, stack)}
        </UrlLink>
      ))}
    </span>
  );
}

type DestroyState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "running" }
  | { phase: "failed"; error: string };

function StagingRow({
  stack,
  hostId,
  cleanup,
  onDestroyed,
}: {
  stack: Stack;
  hostId: string | null;
  cleanup: CleanupStatus | undefined;
  onDestroyed: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<DestroyState>({ phase: "idle" });
  const status = health(stack);
  const age = formatAge(stack.createdAt);

  const destroy = () => {
    setState({ phase: "running" });
    rpc.call("destroy_stack", { hostId, slug: stack.id }).then(
      () => {
        setState({ phase: "idle" });
        onDestroyed();
      },
      (cause: unknown) =>
        setState({
          phase: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        }),
    );
  };

  return (
    <li className="flex flex-col gap-0.5 rounded px-1 py-1 hover:bg-sidebar-accent/50">
      <div className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
        <span
          className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[status.tone])}
          title={status.label}
        />
        <span
          className="min-w-0 flex-1 truncate text-sidebar-foreground"
          title={[stack.projects.join(", "), stack.workingDir].filter(Boolean).join("\n")}
        >
          {stack.id}
        </span>
        <CleanupBadge cleanup={cleanup} />
        <span className="shrink-0 text-2xs tabular-nums text-subtle-foreground" title={status.label}>
          {stack.containers.filter((c) => c.state === "running").length}/{stack.containers.length}
          {age !== null ? ` · ${age}` : ""}
        </span>
        {state.phase === "running" ? (
          <Icon
            name="LoaderCircle"
            aria-label="Destroying"
            className="size-3.5 shrink-0 animate-spin text-subtle-foreground"
          />
        ) : (
          <button
            type="button"
            onClick={() => setState({ phase: "confirming" })}
            disabled={state.phase === "confirming"}
            aria-label={`Destroy ${stack.id}`}
            title={`Destroy ${stack.id}`}
            className="shrink-0 rounded p-0.5 text-subtle-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          >
            <Icon name="Trash2" aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <div className="pl-3">
        <HostLinks stack={stack} />
      </div>
      {state.phase === "confirming" ? (
        <div className="ml-3 flex items-center gap-1.5 text-2xs leading-4">
          <span className="min-w-0 flex-1 text-destructive">Containers and volumes go too.</span>
          <button
            type="button"
            onClick={() => setState({ phase: "idle" })}
            className="rounded px-1.5 py-0.5 text-subtle-foreground hover:bg-sidebar-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={destroy}
            autoFocus
            className="rounded bg-destructive px-1.5 py-0.5 font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            Destroy
          </button>
        </div>
      ) : null}
      {state.phase === "running" ? (
        <p className="ml-3 text-2xs text-subtle-foreground">Running docker compose down…</p>
      ) : null}
      {state.phase === "failed" ? (
        <p className="ml-3 line-clamp-3 text-2xs text-destructive" title={state.error}>
          {state.error}
        </p>
      ) : null}
    </li>
  );
}

function ServiceRow({ stack }: { stack: Stack }) {
  const status = health(stack);
  return (
    <li className="flex min-w-0 items-start gap-1.5 px-1 py-0.5 text-2xs leading-4">
      <span
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT_CLASS[status.tone])}
        title={status.label}
      />
      <span className="w-24 shrink-0 truncate text-subtle-foreground" title={stack.projects.join(", ")}>
        {stack.id}
      </span>
      <HostLinks stack={stack} />
    </li>
  );
}

function SectionTitle({ children, actions }: { children: string; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1 px-1">
      <p className="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {children}
      </p>
      {actions}
    </div>
  );
}

export function TraefikStacks({ hostId }: { hostId: string | null }) {
  const { listing, error, refresh, nonce } = useListing(hostId);
  const slugs =
    listing?.stacks.filter((s) => s.kind === "staging").map((s) => s.id) ?? [];
  const cleanup = useCleanup(hostId, slugs, nonce);

  const actions = (
    <>
      {error !== null ? (
        <span title={error} className="flex shrink-0 items-center text-warning">
          <Icon name="TriangleAlert" aria-label="Last refresh failed" className="size-3" />
        </span>
      ) : null}
      <button
        type="button"
        onClick={refresh}
        aria-label="Refresh slugs"
        title="Refresh slugs"
        className="shrink-0 rounded p-0.5 text-subtle-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <Icon name="RefreshCw" aria-hidden className="size-3" />
      </button>
    </>
  );

  if (listing === null) {
    return (
      <div className="flex flex-col gap-0.5 px-1.5 py-2">
        <SectionTitle actions={actions}>Staging slugs</SectionTitle>
        <p className="px-1 text-2xs text-muted-foreground">
          {error ?? "Reading docker stacks…"}
        </p>
      </div>
    );
  }

  if (listing.dockerError !== null) {
    return (
      <div className="flex flex-col gap-0.5 px-1.5 py-2">
        <SectionTitle actions={actions}>Staging slugs</SectionTitle>
        <p className="px-1 text-2xs text-muted-foreground" title={listing.dockerError}>
          Docker isn't reachable on this machine.
        </p>
      </div>
    );
  }

  const staging = listing.stacks.filter((s) => s.kind === "staging");
  const services = listing.stacks.filter((s) => s.kind === "service");
  const done = staging.filter((s) => cleanup.get(s.id)?.verdict === "ready").length;

  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto px-1.5 py-2">
      <div className="flex flex-col gap-0.5">
        <SectionTitle actions={actions}>
          {[
            "Staging slugs",
            staging.length > 0 ? String(staging.length) : null,
            done > 0 ? `${done} done` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </SectionTitle>
        {staging.length === 0 ? (
          <p className="px-1 text-2xs text-subtle-foreground">No staging stacks running.</p>
        ) : (
          <ul className="flex flex-col">
            {staging.map((stack) => (
              <StagingRow
                key={stack.id}
                stack={stack}
                hostId={hostId}
                cleanup={cleanup.get(stack.id)}
                onDestroyed={refresh}
              />
            ))}
          </ul>
        )}
      </div>
      {services.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <SectionTitle>Other services</SectionTitle>
          <ul className="flex flex-col">
            {services.map((stack) => (
              <ServiceRow key={stack.id} stack={stack} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
