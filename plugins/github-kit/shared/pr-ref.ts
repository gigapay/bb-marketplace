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
