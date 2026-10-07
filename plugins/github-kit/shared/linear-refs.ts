// Linear issue identifiers a PR mentions, in the order Linear's own GitHub
// integration reads them: title first, then the branch, then the body.

const IDENTIFIER = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})\b/g;
// Text in these is code or a URL path, not a ticket reference.
const NOISE = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g;
// Common tokens shaped like an identifier that are never tickets.
const NOT_TEAMS = new Set(["UTF", "ISO", "SHA", "RFC", "CVE", "TLS", "SSL", "HTTP", "ES", "V"]);

export function linearIdentifiers(pr: { title: string; headRefName: string; body: string }, limit = 5): string[] {
  const found: string[] = [];
  const add = (text: string, caseSensitive: boolean) => {
    for (const match of text.replace(NOISE, " ").matchAll(IDENTIFIER)) {
      const key = match[1]!;
      // Branches are lowercase (gig-123-fix); elsewhere a ticket is uppercase.
      if (caseSensitive && key !== key.toUpperCase()) continue;
      const team = key.toUpperCase();
      if (NOT_TEAMS.has(team) || /^\d/.test(team)) continue;
      const identifier = `${team}-${Number(match[2])}`;
      if (!found.includes(identifier)) found.push(identifier);
    }
  };
  add(pr.title, true);
  add(pr.headRefName, false);
  add(pr.body, true);
  return found.slice(0, limit);
}
