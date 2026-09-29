// Inline glyphs for PR and check states. BB's built-in icon names aren't
// documented, so these don't depend on them. Stroke uses currentColor.
import type { ReactNode } from "react";

function Glyph({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4 shrink-0"
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

export type PrGlyph = "open" | "draft" | "merged" | "closed";

export function PrGlyphIcon({ kind, label }: { kind: PrGlyph; label: string }) {
  return (
    <Glyph label={label}>
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      {kind === "merged" ? (
        <>
          <path d="M4 5.25v5.5" />
          <circle cx="12" cy="8" r="1.75" />
          <path d="M4 5.25c0 2 2.5 2.75 6.25 2.75" />
        </>
      ) : (
        <>
          <path d="M4 5.25v5.5" />
          <circle cx="12" cy="12.5" r="1.75" />
          {kind === "closed" ? (
            <path d="M10.25 2l3.5 3.5M13.75 2l-3.5 3.5" />
          ) : kind === "draft" ? (
            <path d="M12 7v.5M12 9.5v1" />
          ) : (
            <path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
          )}
        </>
      )}
    </Glyph>
  );
}

export type CheckGlyph = "success" | "failure" | "pending";

export function CheckGlyphIcon({ kind, label }: { kind: CheckGlyph; label: string }) {
  return (
    <Glyph label={label}>
      <circle cx="8" cy="8" r="6.25" strokeDasharray={kind === "pending" ? "2.5 2" : undefined} />
      {kind === "success" ? <path d="M5.5 8.25l1.75 1.75 3.25-3.5" /> : null}
      {kind === "failure" ? <path d="M6 6l4 4M10 6l-4 4" /> : null}
    </Glyph>
  );
}
