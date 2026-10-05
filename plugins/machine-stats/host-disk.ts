// Folder sizes for the Disk tab, measured on the host entry's machine. The
// server drives the scan one subfolder at a time, so these stay small calls.
import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DirListing, DuLevel } from "./contract.js";

const run = promisify(execFile);
// /home on a busy dev box takes minutes.
const DU_TIMEOUT_MS = 15 * 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export function diskRoot(): string {
  // macOS's / is the sealed system volume; what fills up is in the home folder.
  return process.platform === "darwin" ? os.homedir() : "/";
}

export async function listDir(dir: string): Promise<DirListing> {
  const listing: DirListing = { path: dir, dirs: [], mounts: [], filesBytes: 0, unreadable: false };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { ...listing, unreadable: true };
  }
  const device = (await lstat(dir)).dev;
  await Promise.all(
    names.map(async (name) => {
      const stats = await lstat(path.join(dir, name)).catch(() => null);
      if (stats === null) return;
      if (stats.isDirectory()) {
        // Same rule as du -x: another filesystem is another disk's business.
        (stats.dev === device ? listing.dirs : listing.mounts).push(name);
      } else if (!stats.isSymbolicLink()) {
        // Allocated size, like du, not the apparent one.
        listing.filesBytes += stats.blocks * 512;
      }
    }),
  );
  listing.dirs.sort();
  listing.mounts.sort();
  return listing;
}

export async function duLevel(dir: string, signal: AbortSignal): Promise<DuLevel> {
  // du exits 1 on any unreadable folder but still prints the rest.
  const { stdout, partial } = await run("du", ["-xk", "-d", "1", dir], {
    timeout: DU_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    signal,
  }).then(
    (result) => ({ stdout: result.stdout, partial: false }),
    (cause: unknown) => {
      const out = (cause as { stdout?: unknown }).stdout;
      if (signal.aborted || typeof out !== "string" || out.trim() === "") throw cause;
      return { stdout: out, partial: true };
    },
  );
  let totalBytes = 0;
  const children: DuLevel["children"] = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const bytes = Number(line.slice(0, tab)) * 1024;
    const entry = line.slice(tab + 1);
    if (path.resolve(entry) === path.resolve(dir)) totalBytes = bytes;
    else children.push({ name: path.basename(entry), bytes });
  }
  return { path: dir, totalBytes, children, partial };
}
