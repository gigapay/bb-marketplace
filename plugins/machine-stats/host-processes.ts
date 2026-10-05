// Top processes by CPU and memory, read on the host entry's machine. Processes
// running inside a docker container are tagged with its compose project and
// service, so a busy staging slug is easy to spot.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProcessInfo, ProcessListing } from "./contract.js";

const run = promisify(execFile);
const SAMPLE_MS = 500;
// Linux reports CPU time in clock ticks, which is 100/s on every distro BB runs on.
const CLOCK_TICKS = 100;
const STAGING_PREFIX = "staging-";

type Raw = {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  command: string;
  containerId: string | null;
};

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

const readOrNull = (file: string) => readFile(file, "utf8").catch(() => null);

// utime + stime from /proc/<pid>/stat. The name sits in parentheses and can
// hold spaces, so split after the last ")".
function parseStat(stat: string): { name: string; ticks: number } | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open === -1 || close === -1) return null;
  const fields = stat.slice(close + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { name: stat.slice(open + 1, close), ticks: utime + stime };
}

async function sampleTicks(pids: number[]) {
  const ticks = new Map<number, { name: string; ticks: number }>();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readOrNull(`/proc/${pid}/stat`);
      const parsed = stat === null ? null : parseStat(stat);
      if (parsed !== null) ticks.set(pid, parsed);
    }),
  );
  return ticks;
}

async function linuxProcesses(signal: AbortSignal): Promise<Raw[]> {
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).map(Number);
  const before = await sampleTicks(pids);
  const startedAt = performance.now();
  await sleep(SAMPLE_MS, signal);
  const after = await sampleTicks([...before.keys()]);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;

  const processes = await Promise.all(
    [...after].map(async ([pid, sample]): Promise<Raw | null> => {
      const previous = before.get(pid);
      if (previous === undefined) return null;
      const status = await readOrNull(`/proc/${pid}/status`);
      // Kernel threads have no VmRSS line; they're never interesting here.
      const rssKb = status === null ? null : /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      if (rssKb === undefined || rssKb === null) return null;
      return {
        pid,
        name: sample.name,
        cpuPercent: ((sample.ticks - previous.ticks) / CLOCK_TICKS / elapsedSeconds) * 100,
        memoryBytes: Number(rssKb) * 1024,
        command: "",
        containerId: null,
      };
    }),
  );
  return processes.filter((p): p is Raw => p !== null);
}

// Only the processes we keep need their full command line and cgroup.
async function linuxDetails(processes: Raw[]): Promise<void> {
  await Promise.all(
    processes.map(async (proc) => {
      const [cmdline, cgroup] = await Promise.all([
        readOrNull(`/proc/${proc.pid}/cmdline`),
        readOrNull(`/proc/${proc.pid}/cgroup`),
      ]);
      proc.command = cmdline?.split("\0").filter(Boolean).join(" ") || proc.name;
      // cgroup v2 (docker-<id>.scope) and v1 (/docker/<id>).
      proc.containerId = /docker[-/]([0-9a-f]{64})/.exec(cgroup ?? "")?.[1] ?? null;
    }),
  );
}

// macOS has no /proc. Its ps %cpu is a short decaying average, close enough.
async function darwinProcesses(signal: AbortSignal): Promise<Raw[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,pcpu=,rss=,comm="], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  const processes: Raw[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const command = match[4] ?? "";
    processes.push({
      pid: Number(match[1]),
      name: path.basename(command),
      cpuPercent: Number(match[2]),
      memoryBytes: Number(match[3]) * 1024,
      command,
      containerId: null,
    });
  }
  return processes;
}

/** Container id -> "gig-6565 · django", from compose labels. */
async function containerLabels(signal: AbortSignal): Promise<Map<string, string>> {
  try {
    const { stdout } = await run(
      "docker",
      [
        "ps",
        "--no-trunc",
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      { timeout: 5_000, signal },
    );
    const labels = new Map<string, string>();
    for (const line of stdout.split("\n").filter(Boolean)) {
      const [id = "", name = "", project = "", service = ""] = line.split("\t");
      let owner = project;
      if (owner.startsWith(STAGING_PREFIX)) {
        owner = owner.slice(STAGING_PREFIX.length).replace(/-app$/, "");
      }
      labels.set(id, owner !== "" && service !== "" ? `${owner} · ${service}` : name);
    }
    return labels;
  } catch {
    return new Map();
  }
}

export async function listProcesses(limit: number, signal: AbortSignal): Promise<ProcessListing> {
  const all =
    process.platform === "linux" ? await linuxProcesses(signal) : await darwinProcesses(signal);
  // Keep the top of both rankings so the UI can sort either way.
  const byCpu = [...all].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, limit);
  const byMemory = [...all].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, limit);
  const kept = [...new Map([...byCpu, ...byMemory].map((p) => [p.pid, p])).values()];
  if (process.platform === "linux") await linuxDetails(kept);
  const containers = kept.some((p) => p.containerId !== null)
    ? await containerLabels(signal)
    : new Map<string, string>();

  const processes: ProcessInfo[] = kept.map((p) => ({
    pid: p.pid,
    name: p.name,
    command: p.command,
    cpuPercent: Math.max(0, p.cpuPercent),
    memoryBytes: p.memoryBytes,
    container: p.containerId === null ? null : (containers.get(p.containerId) ?? "container"),
  }));
  return {
    hostname: os.hostname(),
    sampledAt: Date.now(),
    cores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    processCount: all.length,
    processes,
  };
}
