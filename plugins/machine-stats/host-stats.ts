// CPU, RAM and disk readings, taken locally on the host entry's machine.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { DiskUsage, MachineSnapshot } from "./contract.js";

const run = promisify(execFile);
const CPU_SAMPLE_MS = 500;

function cpuTimes() {
  return os.cpus().map(({ times }) => {
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function cpuUsagePercent(signal: AbortSignal): Promise<number> {
  const before = cpuTimes();
  await sleep(CPU_SAMPLE_MS, signal);
  const after = cpuTimes();
  let idle = 0;
  let total = 0;
  after.forEach((sample, index) => {
    const previous = before[index];
    if (previous === undefined) return;
    idle += sample.idle - previous.idle;
    total += sample.total - previous.total;
  });
  return total <= 0 ? 0 : Math.min(100, Math.max(0, (1 - idle / total) * 100));
}

// os.freemem() ignores reclaimable page cache, which makes Linux and macOS
// look almost full all the time. Read the OS's own "available" figure instead.
async function availableMemoryBytes(signal: AbortSignal): Promise<number> {
  try {
    if (process.platform === "linux") {
      const meminfo = await readFile("/proc/meminfo", "utf8");
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
      if (match?.[1] !== undefined) return Number(match[1]) * 1024;
    } else if (process.platform === "darwin") {
      const { stdout } = await run("vm_stat", [], { timeout: 5_000, signal });
      const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
      const pages = (label: string) =>
        Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(stdout)?.[1] ?? 0);
      return (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
    }
  } catch {
    // Fall through to the portable (pessimistic) figure.
  }
  return os.freemem();
}

// Mounted .dmg installers are read-only and always look 100% full.
async function readOnlyDevices(signal: AbortSignal): Promise<Set<string>> {
  if (process.platform !== "darwin") return new Set();
  try {
    const { stdout } = await run("mount", [], { timeout: 5_000, signal });
    const devices = stdout
      .split("\n")
      .filter((line) => /\(.*\bread-only\b.*\)$/.test(line))
      .map((line) => line.split(" on ")[0] ?? "");
    return new Set(devices);
  } catch {
    return new Set();
  }
}

async function diskUsage(signal: AbortSignal): Promise<DiskUsage[]> {
  const readOnly = await readOnlyDevices(signal);
  // df exits 1 when any mount is unreadable (a dead FUSE mount, say) but still
  // prints every other filesystem, so keep its stdout on failure.
  const stdout = await run("df", ["-kP"], { timeout: 5_000, signal }).then(
    (result) => result.stdout,
    (cause: unknown) => {
      const partial = (cause as { stdout?: unknown }).stdout;
      if (typeof partial === "string" && partial.trim() !== "") return partial;
      throw cause;
    },
  );
  const disks: DiskUsage[] = [];
  const seen = new Set<string>();
  for (const line of stdout.trim().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem = "", total, used, available] = parts;
    const mount = parts.slice(5).join(" ");
    // Keep real block devices only: skip tmpfs/overlay/devfs, snap loop
    // mounts, boot partitions and bind mounts of an already listed device.
    if (!filesystem.startsWith("/dev/") || filesystem.startsWith("/dev/loop")) continue;
    if (mount.startsWith("/boot")) continue;
    if (
      process.platform === "darwin" &&
      mount.startsWith("/System/Volumes/") &&
      mount !== "/System/Volumes/Data"
    ) {
      continue;
    }
    if (readOnly.has(filesystem) || seen.has(filesystem)) continue;
    seen.add(filesystem);
    disks.push({
      mount,
      filesystem,
      totalBytes: Number(total) * 1024,
      usedBytes: Number(used) * 1024,
      availableBytes: Number(available) * 1024,
    });
  }
  // On macOS "/" is the sealed system snapshot; user data lives on the Data
  // volume, which shares the same container space.
  if (process.platform === "darwin" && disks.some((d) => d.mount === "/System/Volumes/Data")) {
    return disks.filter((disk) => disk.mount !== "/");
  }
  return disks;
}

export async function snapshot(signal: AbortSignal): Promise<MachineSnapshot> {
  const [usagePercent, availableBytes, disks] = await Promise.all([
    cpuUsagePercent(signal),
    availableMemoryBytes(signal),
    diskUsage(signal).catch(() => []),
  ]);
  const cpus = os.cpus();
  const totalBytes = os.totalmem();
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptimeSeconds: os.uptime(),
    sampledAt: Date.now(),
    cpu: {
      model: cpus[0]?.model.trim() ?? "Unknown CPU",
      cores: cpus.length,
      usagePercent,
      loadAverage: [load1, load5, load15],
    },
    memory: {
      totalBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
    },
    disks,
  };
}
