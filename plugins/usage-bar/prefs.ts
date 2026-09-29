export interface UsagePrefs {
  /** One line per provider instead of one line per window. */
  compact: boolean;
  /** Drop providers that report "unauthenticated" (tools you have but never signed in to). */
  hideSignedOut: boolean;
  hiddenProviders: string[];
  /** Keys from {@link windowKey}. */
  hiddenWindows: string[];
}

export const DEFAULT_PREFS: UsagePrefs = {
  compact: false,
  hideSignedOut: true,
  hiddenProviders: [],
  hiddenWindows: [],
};

/** Realtime channel; the payload is the new prefs. */
export const PREFS_CHANGED = "prefs-changed";

// The raw label is the only stable id a window has across refreshes.
export function windowKey(providerId: string, windowLabel: string): string {
  return `${providerId}::${windowLabel}`;
}
