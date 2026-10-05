// Server side of the Disk tab. A folder's level is scanned in the background,
// one `du -d 1` per subfolder, so sizes show up as they're measured instead of
// after one multi-minute `du /`. Each du also returns that subfolder's own
// children, so drilling one level down is usually instant.
import path from "node:path";
import type { DirListing, DiskEntry, DiskLevel, DuLevel } from "./contract.js";

const CACHE_MS = 15 * 60_000;
// du is disk-bound; two at once keeps a machine usable.
const CONCURRENCY = 2;
// Past this many subfolders (node_modules...), one du of the parent is faster.
const MAX_PER_CHILD = 64;
const DU_TIMEOUT_MS = 16 * 60_000;

type Level = {
  path: string;
  entries: Map<string, DiskEntry>;
  scanning: boolean;
  scannedAt: number | null;
  partial: boolean;
  error: string | null;
};

export type DiskHost = {
  root(hostId: string): Promise<string>;
  list(hostId: string, dir: string, signal: AbortSignal): Promise<DirListing>;
  du(hostId: string, dir: string, signal: AbortSignal): Promise<DuLevel>;
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createDiskScanner(host: DiskHost) {
  const levels = new Map<string, Level>();
  const roots = new Map<string, string>();
  const queues = new Map<string, { running: number; waiting: Array<() => void> }>();

  // A per-machine semaphore around du runs.
  async function limited<T>(hostId: string, job: () => Promise<T>): Promise<T> {
    const queue = queues.get(hostId) ?? { running: 0, waiting: [] };
    queues.set(hostId, queue);
    if (queue.running >= CONCURRENCY) await new Promise<void>((resolve) => queue.waiting.push(resolve));
    queue.running += 1;
    try {
      return await job();
    } finally {
      queue.running -= 1;
      queue.waiting.shift()?.();
    }
  }

  const keyOf = (hostId: string, dir: string) => `${hostId}:${dir}`;

  // A du of `dir` also describes `dir`'s own level, minus the mounts.
  function storeFromDu(hostId: string, result: DuLevel) {
    const existing = levels.get(keyOf(hostId, result.path));
    if (existing?.scanning) return;
    const entries = new Map<string, DiskEntry>();
    let childBytes = 0;
    for (const child of result.children) {
      entries.set(child.name, { name: child.name, kind: "dir", bytes: child.bytes });
      childBytes += child.bytes;
    }
    entries.set("", { name: "", kind: "files", bytes: Math.max(0, result.totalBytes - childBytes) });
    levels.set(keyOf(hostId, result.path), {
      path: result.path,
      entries,
      scanning: false,
      scannedAt: Date.now(),
      partial: result.partial,
      error: null,
    });
  }

  async function scan(hostId: string, level: Level) {
    const signal = AbortSignal.timeout(DU_TIMEOUT_MS);
    try {
      const listing = await host.list(hostId, level.path, signal);
      level.partial = listing.unreadable;
      level.entries = new Map();
      for (const name of listing.dirs) level.entries.set(name, { name, kind: "dir", bytes: null });
      for (const name of listing.mounts) level.entries.set(name, { name, kind: "mount", bytes: null });
      level.entries.set("", { name: "", kind: "files", bytes: listing.filesBytes });

      if (listing.dirs.length > MAX_PER_CHILD) {
        const result = await limited(hostId, () => host.du(hostId, level.path, signal));
        level.partial ||= result.partial;
        for (const child of result.children) {
          const entry = level.entries.get(child.name);
          if (entry !== undefined) entry.bytes = child.bytes;
        }
      } else {
        await Promise.all(
          listing.dirs.map((name) =>
            limited(hostId, async () => {
              const result = await host.du(hostId, path.join(level.path, name), signal);
              const entry = level.entries.get(name);
              if (entry !== undefined) entry.bytes = result.totalBytes;
              level.partial ||= result.partial;
              storeFromDu(hostId, result);
            }).catch(() => {
              // One unreadable subfolder shouldn't sink the whole level.
              level.partial = true;
              const entry = level.entries.get(name);
              if (entry !== undefined) entry.bytes = 0;
            }),
          ),
        );
      }
      level.scannedAt = Date.now();
    } catch (cause) {
      level.error = message(cause);
    } finally {
      level.scanning = false;
    }
  }

  function view(level: Level, rootPath: string): DiskLevel {
    const entries = [...level.entries.values()]
      .filter((entry) => entry.kind !== "files" || (entry.bytes ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name),
      );
    return {
      path: level.path,
      rootPath,
      entries,
      scanning: level.scanning,
      scannedAt: level.scannedAt,
      partial: level.partial,
      error: level.error,
    };
  }

  return async function diskLevel(
    hostId: string,
    requested: string | null,
    rescan: boolean,
  ): Promise<DiskLevel> {
    let rootPath = roots.get(hostId);
    if (rootPath === undefined) {
      rootPath = await host.root(hostId);
      roots.set(hostId, rootPath);
    }
    const dir = path.resolve(requested ?? rootPath);
    const key = keyOf(hostId, dir);
    const existing = levels.get(key);
    const fresh =
      existing !== undefined &&
      (existing.scanning ||
        (existing.error === null &&
          existing.scannedAt !== null &&
          Date.now() - existing.scannedAt < CACHE_MS));
    if (existing !== undefined && fresh && !(rescan && !existing.scanning)) {
      return view(existing, rootPath);
    }
    const level: Level = {
      path: dir,
      entries: existing?.entries ?? new Map(),
      scanning: true,
      scannedAt: existing?.scannedAt ?? null,
      partial: false,
      error: null,
    };
    levels.set(key, level);
    void scan(hostId, level);
    return view(level, rootPath);
  };
}
