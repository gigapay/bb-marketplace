// Pure drawing model for screenshot markup, ported from Orca's browser markup
// (MIT, github.com/stablyai/orca). Shapes live in screenshot pixel coordinates,
// so the same data drives the live canvas and the exported PNG.

export type MarkupTool = "pen" | "highlight" | "arrow" | "rect" | "ellipse" | "text";

export type MarkupPoint = { x: number; y: number };

type ShapeBase = { id: string; color: string };

export type StrokeShape = ShapeBase & {
  kind: "pen" | "highlight";
  points: MarkupPoint[];
  width: number;
};
export type BoxShape = ShapeBase & {
  kind: "arrow" | "rect" | "ellipse";
  from: MarkupPoint;
  to: MarkupPoint;
  width: number;
};
export type TextShape = ShapeBase & {
  kind: "text";
  at: MarkupPoint;
  text: string;
  fontSize: number;
};

export type MarkupShape = StrokeShape | BoxShape | TextShape;

// Ink colors are baked into the exported image, so they are content colors,
// not theme tokens.
export const MARKUP_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#111827",
  "#ffffff",
] as const;
export const MARKUP_WIDTHS = [2, 4, 8] as const;
export const MARKUP_FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64] as const;
export const DEFAULT_MARKUP_WIDTH = 4;
export const DEFAULT_MARKUP_FONT_SIZE = 18;

/** Next preset font size in `direction`, clamped to the preset range. */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const sizes: readonly number[] = MARKUP_FONT_SIZES;
  const next =
    direction > 0
      ? sizes.find((size) => size > current)
      : [...sizes].reverse().find((size) => size < current);
  return next ?? current;
}

export const HIGHLIGHT_WIDTH_MULTIPLIER = 4;
export const HIGHLIGHT_ALPHA = 0.35;

export type MarkupDocument = {
  shapes: MarkupShape[];
  past: MarkupShape[][];
  future: MarkupShape[][];
};

export function createMarkupDocument(): MarkupDocument {
  return { shapes: [], past: [], future: [] };
}

function setShapes(doc: MarkupDocument, shapes: MarkupShape[]): MarkupDocument {
  return { shapes, past: [...doc.past, doc.shapes], future: [] };
}

export function commitShape(doc: MarkupDocument, shape: MarkupShape): MarkupDocument {
  return setShapes(doc, [...doc.shapes, shape]);
}

export function undoShape(doc: MarkupDocument): MarkupDocument {
  const previous = doc.past.at(-1);
  if (previous === undefined) return doc;
  return {
    shapes: previous,
    past: doc.past.slice(0, -1),
    future: [doc.shapes, ...doc.future],
  };
}

export function redoShape(doc: MarkupDocument): MarkupDocument {
  const next = doc.future.at(0);
  if (next === undefined) return doc;
  return {
    shapes: next,
    past: [...doc.past, doc.shapes],
    future: doc.future.slice(1),
  };
}

export function clearShapes(doc: MarkupDocument): MarkupDocument {
  return doc.shapes.length === 0 ? doc : setShapes(doc, []);
}

export function normalizeRect(from: MarkupPoint, to: MarkupPoint) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

const ARROW_HEAD_ANGLE = 0.45;

// Wing points of an arrowhead at `to`, or null for a zero-length arrow.
export function arrowHead(from: MarkupPoint, to: MarkupPoint, width: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  const angle = Math.atan2(dy, dx);
  const size = Math.max(10, width * 3.5);
  const wing = (offset: number): MarkupPoint => ({
    x: to.x + size * Math.cos(angle + Math.PI + offset),
    y: to.y + size * Math.sin(angle + Math.PI + offset),
  });
  return { tip: to, left: wing(-ARROW_HEAD_ANGLE), right: wing(ARROW_HEAD_ANGLE) };
}
