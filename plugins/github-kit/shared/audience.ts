// Bot detection, same rules as Orca: GitHub's own Bot type, the "[bot]"
// suffix, then names of known review tools and automation accounts that post
// as regular users.

const KNOWN_BOT_SUBSTRINGS = [
  "chatgpt-codex-connector",
  "codex-connector",
  "qodo",
  "coderabbit",
  "codium",
  "sonarcloud",
  "sonarqube",
  "sourcery-ai",
  "deepsource",
  "snyk",
  "codecov",
  "greptile",
  "ellipsis",
  "graphite-app",
  "reviewer-gpt",
  "-reviewer",
];

const KNOWN_BOT_PATTERNS = [/bot$/i, /\bbot\b/i, /automation/i, /actions/i, /renovate/i, /dependabot/i];

export function isBotLogin(login: string, typename: string | null): boolean {
  if (typename === "Bot") return true;
  const lower = login.toLowerCase();
  if (lower.endsWith("[bot]")) return true;
  if (KNOWN_BOT_SUBSTRINGS.some((part) => lower.includes(part))) return true;
  return KNOWN_BOT_PATTERNS.some((pattern) => pattern.test(lower));
}

export type Audience = "all" | "humans" | "bots";
