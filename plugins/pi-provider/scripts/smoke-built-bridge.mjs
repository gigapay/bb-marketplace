#!/usr/bin/env node
// Smoke test for the BUILT artifact (run `bb plugin build .` first): spawns
// dist/host.js the way bb's runtime does, against the scripted fake pi and the
// fake pi-toolbox subagents extension, and checks one native subagent task,
// its settlement, and a /reload. No bb server, no real pi, no network.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_resolveProviderBridgeLaunch as resolveLaunch } from "@get-bb/plugin-sdk/provider-bridge/testing";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(tmpdir(), "bb-pi-smoke-"));
const launch = resolveLaunch({
  modulePath: path.join(root, "dist/host.js"),
  pluginId: "pi-provider",
  cwd: work,
  dataDir: path.join(work, "data"),
});
const child = spawn(launch.command, launch.args, {
  cwd: launch.cwd,
  env: {
    ...launch.env,
    PATH: process.env.PATH ?? "",
    BB_PI_BRIDGE_COMMAND: process.execPath,
    BB_PI_BRIDGE_ARGS: JSON.stringify([path.join(root, "src/bridge/fake-pi-rpc.mjs")]),
    BB_PI_BRIDGE_SESSION_DIR: path.join(work, "sessions"),
    BB_PI_PROVIDER_STATE_DIR: path.join(work, "state"),
    FAKE_PI_EXTRA_EXTENSIONS: JSON.stringify([
      path.join(root, "src/subagents/fake-subagents-extension.mjs"),
    ]),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

const messages = [];
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) messages.push(JSON.parse(line));
  }
});
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const deltas = () =>
  messages.filter((m) => m.method === "thread/delta").flatMap((m) => m.params.deltas);
async function until(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const reply = (id) => until(() => messages.some((m) => m.id === id), `reply ${id}`).then(() => messages.find((m) => m.id === id));
const options = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };

let failed = false;
try {
  send({ id: 1, method: "initialize", params: { protocolVersion: 2, client: { name: "smoke", version: "0" }, grammarVersions: [3, 3] } });
  await reply(1);
  send({ id: 2, method: "thread/start", params: { threadId: "thr_smoke", cwd: work, instructionMode: "append", options } });
  const started = await reply(2);
  const providerThreadId = started.result.providerThreadId;
  const turn = (id, text, creq) =>
    send({ id, method: "turn/start", params: { threadId: "thr_smoke", providerThreadId, clientRequestId: creq, input: [{ type: "text", text, mentions: [] }], options } });
  turn(3, '/tool subagent_spawn {"name":"smoke","durationMs":100}', "creq_2222222222");
  await until(
    () => deltas().some((d) => d.kind === "item.close" && d.item?.type === "backgroundTask" && d.item.taskStatus === "completed"),
    "the subagent task to complete",
  );
  const open = deltas().find((d) => d.kind === "item.open" && d.item?.type === "backgroundTask");
  if (open?.key?.parentRef !== "call-1" || open.item.taskType !== "local_agent") {
    throw new Error(`unexpected task row ${JSON.stringify(open)}`);
  }
  turn(4, "/reload", "creq_2222222223");
  await until(
    () => deltas().some((d) => d.kind === "item.close" && d.item?.tool === "pi_reload" && d.status === "completed"),
    "/reload to complete",
  );
  console.log("smoke: native subagent task and /reload OK through dist/host.js");
} catch (error) {
  failed = true;
  console.error(`smoke: FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
