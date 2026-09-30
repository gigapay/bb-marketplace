export interface UsagePrefs {
  /** One line per provider instead of one line per window. */
  compact: boolean;
  /** Drop providers that report "unauthenticated" (tools you have but never signed in to). */
  hideSignedOut: boolean;
  hiddenProviders: string[];
  /** Keys from {@link windowKey}. */
  hiddenWindows: string[];
  /** Whose usage to show: {@link PRIMARY_MACHINE}, {@link THREAD_MACHINE}, or a host id. */
  machine: string;
}

export const PRIMARY_MACHINE = "primary";
/** Follow the machine of the thread currently open, falling back to the primary one. */
export const THREAD_MACHINE = "thread";

export const DEFAULT_PREFS: UsagePrefs = {
  compact: false,
  hideSignedOut: true,
  hiddenProviders: [],
  hiddenWindows: [],
  machine: PRIMARY_MACHINE,
};

/** Realtime channel; the payload is the new prefs. */
export const PREFS_CHANGED = "prefs-changed";

// The raw label is the only stable id a window has across refreshes.
export function windowKey(providerId: string, windowLabel: string): string {
  return `${providerId}::${windowLabel}`;
}
