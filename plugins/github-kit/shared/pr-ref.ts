// Parses and formats the owner/repo#number reference used across the RPCs
// and panel params.

export type PrRef = { owner: string; name: string; number: number };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function parsePrUrl(url: string): PrRef | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match) return null;
  return toRef(match[1]!, match[2]!, match[3]!);
}

export function parsePrKey(key: string): PrRef | null {
  const match = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(key.trim());
  if (!match) return null;
  return toRef(match[1]!, match[2]!, match[3]!);
}

export function prKey(ref: PrRef): string {
  return `${ref.owner}/${ref.name}#${ref.number}`;
}

function toRef(owner: string, name: string, number: string): PrRef | null {
  const parsed = Number(number);
  if (!NAME.test(owner) || !NAME.test(name) || !Number.isSafeInteger(parsed) || parsed < 1) return null;
  return { owner, name, number: parsed };
}

/**
 * What a user types to name a PR: a URL, owner/repo#123, or just #123 / 123
 * (the repo then comes from context). null when it's none of those.
 */
export function parsePrReference(input: string): PrRef | { number: number } | null {
  const value = input.trim();
  const fromUrl = parsePrUrl(value);
  if (fromUrl) return fromUrl;
  const fromKey = parsePrKey(value);
  if (fromKey) return fromKey;
  const bare = /^#?(\d{1,9})$/.exec(value);
  if (bare) {
    const number = Number(bare[1]);
    return number >= 1 ? { number } : null;
  }
  return null;
}

export const LINKS_CHANGED = "links-changed";
