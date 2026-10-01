// Canvas rendering shared by the live editor and the exported PNG, so the
// preview and the delivered image are pixel-identical.

import {
  arrowHead,
  HIGHLIGHT_ALPHA,
  HIGHLIGHT_WIDTH_MULTIPLIER,
  normalizeRect,
  type MarkupPoint,
  type MarkupShape,
} from "./markup-model";

export const TEXT_FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** Line height as a multiple of the font size, shared with the text box. */
export const TEXT_LINE_HEIGHT = 1.25;

export function textFont(fontSize: number): string {
  return `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
}

export function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: readonly MarkupShape[],
): void {
  for (const shape of shapes) drawShape(ctx, shape);
}

function drawShape(ctx: CanvasRenderingContext2D, shape: MarkupShape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  switch (shape.kind) {
    case "pen":
      ctx.lineWidth = shape.width;
      strokePolyline(ctx, shape.points, shape.width);
      break;
    case "highlight": {
      // Fat and translucent so it reads as a marker pass over the pixels.
      const width = shape.width * HIGHLIGHT_WIDTH_MULTIPLIER;
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.lineWidth = width;
      strokePolyline(ctx, shape.points, width);
      break;
    }
    case "arrow": {
      ctx.lineWidth = shape.width;
      strokePolyline(ctx, [shape.from, shape.to], shape.width);
      const head = arrowHead(shape.from, shape.to, shape.width);
      if (head !== null) strokePolyline(ctx, [head.left, head.tip, head.right], shape.width);
      break;
    }
    case "rect": {
      const rect = normalizeRect(shape.from, shape.to);
      ctx.lineWidth = shape.width;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      break;
    }
    case "ellipse": {
      const rect = normalizeRect(shape.from, shape.to);
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case "text":
      ctx.font = textFont(shape.fontSize);
      ctx.textBaseline = "top";
      // A contrasting halo keeps text legible over busy screenshots.
      ctx.lineWidth = Math.max(shape.fontSize / 6, 2);
      ctx.strokeStyle =
        shape.color.toLowerCase() === "#ffffff"
          ? "rgba(0,0,0,0.65)"
          : "rgba(255,255,255,0.85)";
      shape.text.split("\n").forEach((line, index) => {
        const y = shape.at.y + index * shape.fontSize * TEXT_LINE_HEIGHT;
        ctx.strokeText(line, shape.at.x, y);
        ctx.fillText(line, shape.at.x, y);
      });
      break;
  }
  ctx.restore();
}

/**
 * Greedy word wrap so text never runs past `maxWidth`. Explicit line breaks
 * are kept; a word wider than a whole line is split by characters.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  const fits = (value: string) => ctx.measureText(value).width <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line.length > 0) lines.push(line);
      line = "";
      for (const char of word) {
        if (line.length > 0 && !fits(line + char)) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Wraps `text` at `fontSize` to fit `maxWidth`, measured offscreen. */
export function wrapTextToWidth(text: string, fontSize: number, maxWidth: number): string {
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) return text;
  ctx.font = textFont(fontSize);
  return wrapText(ctx, text, maxWidth);
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly MarkupPoint[],
  width: number,
): void {
  const [first, ...rest] = points;
  if (first === undefined) return;
  if (rest.length === 0) {
    // A tap still leaves a visible dot.
    ctx.beginPath();
    ctx.arc(first.x, first.y, Math.max(width / 2, 1), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}

/** Flattens the screenshot and its markup into one PNG at native resolution. */
export async function exportMarkupPng(
  image: HTMLImageElement,
  shapes: readonly MarkupShape[],
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D is unavailable");
  ctx.drawImage(image, 0, 0);
  drawShapes(ctx, shapes);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("PNG export failed")) : resolve(blob)),
      "image/png",
    );
  });
}
