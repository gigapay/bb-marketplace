import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { dirNameForBranch, registerLinearWorktree } from "./provider.ts";

test("folder names use the last branch segment", () => {
  assert.equal(dirNameForBranch("yoann/gig-12-fix-login"), "gig-12-fix-login");
  assert.equal(dirNameForBranch("feature/Ünicode stuff!"), "nicode-stuff");
  assert.equal(dirNameForBranch("///"), "worktree");
});

function setup(
  taken: { branches?: string[]; folders?: string[]; checkedOut?: Record<string, { path: string; adoptable: boolean }> } = {},
) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE worktree_reservations (path_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, branch TEXT NOT NULL,
    source_path TEXT NOT NULL, placement TEXT, created_at INTEGER NOT NULL)`);
  const created: { branchName: string; placement: unknown; branchMode: string }[] = [];
  const calls: string[] = [];
  const host = {
    experimental_onSignal: () => () => {},
    call: async (method: string, input: any) => {
      calls.push(method);
      if (method === "inspectTarget") {
        const targetPath = input.placement ? `/wt/repo/${input.placement.dirName}` : `/data/${input.pathKey}/repo`;
        return {
          targetPath,
          targetExists: (taken.folders ?? []).includes(targetPath),
          branchExists: (taken.branches ?? []).includes(input.branchName),
          validBranchName: !input.branchName.includes(".."),
          branchWorktree: taken.checkedOut?.[input.branchName] ?? null,
        };
      }
      if (method === "resolveExistingWorktree") return { status: "resolved", path: input.path, branch: null };
      if (method === "remove") return { status: "removed" };
      if (method === "create") {
        created.push(input);
        return { status: "created", path: input.placement ? `/wt/repo/${input.placement.dirName}` : "/data/x", baseBranch: "origin/master" };
      }
      throw new Error(method);
    },
  };
  let provider: any;
  const bb = { experimental_environments: { register: (p: any) => (provider = p) } } as any;
  registerLinearWorktree(bb, {
    host: host as any,
    db,
    worktreesRoot: async () => "~/worktrees",
    linearBranchFor: async (thread) => (thread.title?.startsWith("GIG-12") ? "yoann/gig-12-fix-login" : null),
  });
  const context = (pathKey: string, title: string | null, inputs: any = { branch: { kind: "default" } }) => ({
    thread: { id: `thr_${pathKey}`, title, titleFallback: null },
    suggestedBranchName: `yoann/some-work-thr_${pathKey}`,
    attempt: 1,
    pathKey,
    host: { id: "host1" },
    projectCheckout: { path: "/src/repo" },
    inputs,
    report: { step() {}, log() {} },
    signal: new AbortController().signal,
    experimental_claimPath: async () => true,
  });
  return { provider, created, calls, context };
}

test("uses the Linear branch and a readable folder", async () => {
  const { provider, created, context } = setup();
  const result = await provider.create(context("pk1", "GIG-12: Fix login"));
  assert.equal(result.status, "created");
  assert.equal(created[0]!.branchName, "yoann/gig-12-fix-login");
  assert.deepEqual(created[0]!.placement, { worktreesRoot: "~/worktrees", dirName: "gig-12-fix-login" });
  assert.equal(created[0]!.branchMode, "reset");
});

test("'new' mode never reuses a branch or folder someone else has", async () => {
  const { provider, created, context } = setup({
    branches: ["yoann/gig-12-fix-login"],
    folders: ["/wt/repo/gig-12-fix-login-2"],
  });
  await provider.create(context("pk1", "GIG-12: Fix login", { kind: "new", branch: { kind: "default" } }));
  assert.equal(created[0]!.branchName, "yoann/gig-12-fix-login-3");
  assert.equal((created[0]!.placement as any).dirName, "gig-12-fix-login-3");
});

test("two threads on one ticket get distinct names, retries keep theirs", async () => {
  const { provider, created, context } = setup();
  await Promise.all([provider.create(context("pk1", "GIG-12: a")), provider.create(context("pk2", "GIG-12: b"))]);
  const names = created.map((c) => c.branchName).sort();
  assert.deepEqual(names, ["yoann/gig-12-fix-login", "yoann/gig-12-fix-login-2"]);
  await provider.create(context("pk1", "GIG-12: a"));
  assert.equal(created[2]!.branchName, created.find((c, i) => i < 2 && c.branchName === created[2]!.branchName)!.branchName);
});

test("threads without a ticket keep BB's name", async () => {
  const { provider, created, context } = setup();
  await provider.create(context("pk9", "Refactor stuff"));
  assert.equal(created[0]!.branchName, "yoann/some-work-thr_pk9");
});

test("auto mode adopts a worktree already on the ticket branch", async () => {
  const { provider, created, context } = setup({
    branches: ["yoann/gig-12-fix-login"],
    checkedOut: { "yoann/gig-12-fix-login": { path: "/orca/gig-12", adoptable: true } },
  });
  const result = await provider.create(context("pk1", "GIG-12: Fix login"));
  assert.deepEqual(result, { status: "created", path: "/orca/gig-12", ownsPath: false, resource: { adopted: true } });
  assert.equal(created.length, 0);
});

test("auto mode checks out an existing branch without resetting it", async () => {
  const { provider, created, context } = setup({ branches: ["yoann/gig-12-fix-login"] });
  await provider.create(context("pk1", "GIG-12: Fix login"));
  assert.equal(created[0]!.branchName, "yoann/gig-12-fix-login");
  assert.equal(created[0]!.branchMode, "reuse-existing");
});

test("auto mode starts fresh when the branch lives in a BB-managed worktree", async () => {
  const { provider, created, context } = setup({
    branches: ["yoann/gig-12-fix-login"],
    checkedOut: { "yoann/gig-12-fix-login": { path: "/wt/repo/gig-12-fix-login", adoptable: false } },
    folders: ["/wt/repo/gig-12-fix-login"],
  });
  await provider.create(context("pk1", "GIG-12: Fix login"));
  assert.equal(created[0]!.branchName, "yoann/gig-12-fix-login-2");
  assert.equal(created[0]!.branchMode, "reset");
});

test("an explicitly picked worktree is adopted, and detaching never deletes it", async () => {
  const { provider, calls, context } = setup();
  const result = await provider.create(context("pk1", "Anything", { kind: "existing", path: "/mine/wt" }));
  assert.equal(result.ownsPath, false);
  const before = calls.length;
  const removed = await provider.remove({
    hostId: "host1", path: "/mine/wt", pathKey: "pk1", resource: result.resource, attempt: 1,
    report: { step() {}, log() {} }, signal: new AbortController().signal,
  });
  assert.deepEqual(removed, { status: "removed" });
  assert.equal(calls.length, before);
});
