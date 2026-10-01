// Tags plugin releases from the catalog: for every git-sourced plugin in
// marketplace.json, `<tagPrefix>v<version>` from its package.json. Missing
// tags are created on the current commit and pushed. Existing tags are never
// moved, since BB records the commit each tag points at and refuses a plugin
// whose tag changed.
//
// Usage: node .github/scripts/tag-releases.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const catalog = JSON.parse(readFileSync("marketplace.json", "utf8"));
// Ask the remote, not local refs: a fresh checkout may not have every tag.
const remoteTags = new Set(
  git("ls-remote", "--tags", "--refs", "origin")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1].replace(/^refs\/tags\//, "")),
);

const created = [];
const existing = [];
const problems = [];

for (const plugin of catalog.plugins ?? []) {
  const source = plugin.source?.git;
  if (!source?.subdir || !source?.tagPrefix) continue;
  let version;
  try {
    version = JSON.parse(readFileSync(join(source.subdir, "package.json"), "utf8")).version;
  } catch (error) {
    problems.push(`${plugin.id}: can't read ${source.subdir}/package.json (${error.message})`);
    continue;
  }
  if (typeof version !== "string" || !SEMVER.test(version)) {
    problems.push(`${plugin.id}: "${version}" isn't a semver version`);
    continue;
  }
  const tag = `${source.tagPrefix}v${version}`;
  if (remoteTags.has(tag)) {
    existing.push(tag);
    continue;
  }
  created.push(tag);
  if (!dryRun) {
    git("tag", tag);
    git("push", "origin", `refs/tags/${tag}`);
  }
}

const verb = dryRun ? "Would tag" : "Tagged";
const lines = [
  `### Plugin releases`,
  "",
  created.length > 0 ? created.map((tag) => `- ${verb} \`${tag}\``).join("\n") : "- No new versions to tag.",
  ...(problems.length > 0 ? ["", "Problems:", ...problems.map((problem) => `- ${problem}`)] : []),
  "",
  `${existing.length} version${existing.length === 1 ? " is" : "s are"} already tagged.`,
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
// A bad version would never get a tag; fail so it gets noticed.
if (problems.length > 0) process.exit(1);
