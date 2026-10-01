import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const probeState = vi.hoisted(() => ({
  pnpmBin: "",
  executablePath: "",
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@get-bb/plugin-sdk/provider-bridge")>();
  return {
    ...original,
    experimental_commandOutput: vi.fn(async (command: string) =>
      command.startsWith("pnpm") ? probeState.pnpmBin : null,
    ),
    experimental_npmLatestVersion: vi.fn(async () => "0.85.0"),
    experimental_probeNpmGlobalPackage: vi.fn(async () => ({
      npmBin: path.join(path.sep, "npm", "bin"),
      npmGlobalPackageVersion: null,
    })),
    experimental_resolveExecutablePath: vi.fn(
      async () => probeState.executablePath,
    ),
  };
});

vi.mock("./rpc-child.js", () => ({
  resolvePiLaunch: () => ({ command: probeState.executablePath, args: [] }),
}));

import {
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
} from "./provider-maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function writePi(executablePath: string): Promise<void> {
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, "#!/bin/sh\nprintf '0.84.0\\n'\n", {
    mode: 0o755,
  });
}

describe("Pi provider maintenance with a pnpm-managed executable", () => {
  it("updates through pnpm when Pi lives in pnpm's global bin directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-pi-pnpm-update-"));
    temporaryDirectories.push(root);
    probeState.pnpmBin = path.join(root, ".local", "share", "pnpm", "bin");
    probeState.executablePath = path.join(probeState.pnpmBin, "pi");
    await writePi(probeState.executablePath);

    const status = await getPiProviderInstallationStatus();
    const run = await getPiProviderInstallationRun("update");

    expect(status.installAction?.command).toBe(
      "pnpm add -g @earendil-works/pi-coding-agent@latest",
    );
    expect(run).toMatchObject({
      available: true,
      command: {
        command: "pnpm",
        args: ["add", "-g", "@earendil-works/pi-coding-agent@latest"],
      },
    });
  });

  it("keeps npm when Pi is outside pnpm's global bin directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bb-pi-pnpm-update-"));
    temporaryDirectories.push(root);
    probeState.pnpmBin = path.join(root, ".local", "share", "pnpm", "bin");
    probeState.executablePath = path.join(root, "npm", "bin", "pi");
    await Promise.all([
      mkdir(probeState.pnpmBin, { recursive: true }),
      writePi(probeState.executablePath),
    ]);

    const status = await getPiProviderInstallationStatus();

    expect(status.installAction?.command).toBe(
      "npm install -g @earendil-works/pi-coding-agent@latest",
    );
  });
});
