// Pending review comments, kept per PR until the review is submitted. They
// live in localStorage so a reload or a closed tab doesn't lose them.
import { useSyncExternalStore } from "react";

export type LineAnchor = { path: string; line: number; startLine: number | null; side: "LEFT" | "RIGHT" };
export type Draft = { id: string; anchor: LineAnchor; body: string; createdAt: string };

const listeners = new Set<() => void>();
const cache = new Map<string, Draft[]>();
const EMPTY: Draft[] = [];

function storageKey(prKey: string): string {
  return `github-kit.review-drafts.${prKey}`;
}

function read(prKey: string): Draft[] {
  const cached = cache.get(prKey);
  if (cached !== undefined) return cached;
  let drafts: Draft[] = EMPTY;
  try {
    const raw = localStorage.getItem(storageKey(prKey));
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    // Stored values are untrusted: keep only well-formed drafts.
    if (Array.isArray(parsed)) {
      drafts = parsed.filter(
        (draft): draft is Draft =>
          typeof draft?.id === "string" &&
          typeof draft?.body === "string" &&
          typeof draft?.anchor?.path === "string" &&
          Number.isInteger(draft?.anchor?.line) &&
          (draft.anchor.side === "LEFT" || draft.anchor.side === "RIGHT"),
      );
    }
  } catch {
    drafts = EMPTY;
  }
  cache.set(prKey, drafts);
  return drafts;
}

function write(prKey: string, drafts: Draft[]) {
  cache.set(prKey, drafts);
  try {
    if (drafts.length === 0) localStorage.removeItem(storageKey(prKey));
    else localStorage.setItem(storageKey(prKey), JSON.stringify(drafts));
  } catch {
    // Quota or private mode: drafts still work for this session.
  }
  for (const listener of listeners) listener();
}

export function addDraft(prKey: string, anchor: LineAnchor, body: string) {
  write(prKey, [...read(prKey), { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, anchor, body, createdAt: new Date().toISOString() }]);
}

export function removeDraft(prKey: string, id: string) {
  write(prKey, read(prKey).filter((draft) => draft.id !== id));
}

export function clearDrafts(prKey: string) {
  write(prKey, []);
}

export function useDrafts(prKey: string): Draft[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(prKey),
  );
}
