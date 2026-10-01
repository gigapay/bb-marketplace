import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, KeyboardEvent, PointerEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Highlighter,
  MessageSquarePlus,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  clearShapes,
  commitShape,
  createMarkupDocument,
  DEFAULT_MARKUP_FONT_SIZE,
  DEFAULT_MARKUP_WIDTH,
  MARKUP_COLORS,
  MARKUP_FONT_SIZES,
  MARKUP_WIDTHS,
  redoShape,
  stepFontSize,
  undoShape,
  type MarkupDocument,
  type MarkupPoint,
  type MarkupShape,
  type MarkupTool,
} from "./markup-model";
import { drawShapes, exportMarkupPng, wrapTextToWidth } from "./markup-render";
import { TextBox, type Transcribe } from "./text-box";

// BB's shared icon set has no drawing glyphs, so the editor bundles Lucide.
const ICON_CLASS = "size-4";

const TOOLS: { tool: MarkupTool; icon: ComponentType<{ className?: string }>; label: string }[] = [
  { tool: "pen", icon: Pencil, label: "Pen" },
  { tool: "highlight", icon: Highlighter, label: "Highlighter" },
  { tool: "arrow", icon: MoveUpRight, label: "Arrow" },
  { tool: "rect", icon: Square, label: "Rectangle" },
  { tool: "ellipse", icon: Circle, label: "Ellipse" },
  { tool: "text", icon: Type, label: "Text" },
];

type PendingText = { at: MarkupPoint; css: MarkupPoint; scale: number };

export type MarkupAction = "copy" | "prompt";

export interface MarkupEditorProps {
  imageUrl: string;
  /** Receives the flattened PNG; resolves to a status line to show. */
  onSubmit: (action: MarkupAction, png: Blob) => Promise<string | null>;
  /** BB's voice transcription; null hides the dictation button. */
  transcribe: Transcribe | null;
}

// Gap kept between wrapped text and the screenshot's right edge, in CSS px.
const TEXT_EDGE_MARGIN = 8;

// Largest box with the screenshot's aspect ratio that fits the stage.
function fitSize(
  natural: { width: number; height: number },
  stage: { width: number; height: number },
) {
  const scale = Math.min(stage.width / natural.width, stage.height / natural.height, 1);
  return {
    width: Math.max(1, Math.floor(natural.width * scale)),
    height: Math.max(1, Math.floor(natural.height * scale)),
  };
}

export function MarkupEditor({ imageUrl, onSubmit, transcribe }: MarkupEditorProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [doc, setDoc] = useState<MarkupDocument>(createMarkupDocument);
  const [inProgress, setInProgress] = useState<MarkupShape | null>(null);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [color, setColor] = useState<string>(MARKUP_COLORS[0]);
  const [width, setWidth] = useState<number>(DEFAULT_MARKUP_WIDTH);
  const [fontSize, setFontSize] = useState<number>(DEFAULT_MARKUP_FONT_SIZE);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const [busy, setBusy] = useState<MarkupAction | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setStage((previous) =>
        previous?.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Repaint once per frame; the screenshot itself is the <img> underneath.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size === null) return;
    const handle = requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawShapes(ctx, inProgress === null ? doc.shapes : [...doc.shapes, inProgress]);
    });
    return () => cancelAnimationFrame(handle);
  }, [doc.shapes, inProgress, size]);

  // Pointer positions in screenshot pixels, plus the CSS->image scale so stroke
  // widths and font sizes look the same whatever the zoom level.
  const locate = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return null;
    const scale = canvas.width / rect.width;
    const css = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { css, at: { x: css.x * scale, y: css.y * scale }, scale };
  }, []);

  const commitText = useCallback(
    (text: string) => {
      const pending = pendingText;
      setPendingText(null);
      // Keep inner line breaks; drop blank lines around the text.
      const trimmed = text.replace(/^\s*\n/, "").trimEnd();
      if (pending === null || trimmed.length === 0) return;
      const imageFontSize = fontSize * pending.scale;
      // Bake line breaks in at commit so the text stays inside the screenshot.
      const maxWidth =
        size === null
          ? Number.POSITIVE_INFINITY
          : Math.max(size.width - pending.at.x - TEXT_EDGE_MARGIN * pending.scale, imageFontSize * 4);
      setDoc((current) =>
        commitShape(current, {
          id: crypto.randomUUID(),
          kind: "text",
          color,
          at: pending.at,
          text: wrapTextToWidth(trimmed, imageFontSize, maxWidth),
          fontSize: imageFontSize,
        }),
      );
    },
    [color, fontSize, pendingText, size],
  );

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (busy !== null || event.button !== 0) return;
    const point = locate(event);
    if (point === null) return;
    if (tool === "text") {
      // A click while a text box is open only commits it, through its blur.
      if (pendingText !== null) return;
      event.preventDefault();
      setPendingText(point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const id = crypto.randomUUID();
    const strokeWidth = width * point.scale;
    setInProgress(
      tool === "pen" || tool === "highlight"
        ? { id, kind: tool, color, width: strokeWidth, points: [point.at] }
        : { id, kind: tool, color, width: strokeWidth, from: point.at, to: point.at },
    );
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (inProgress === null) return;
    const point = locate(event);
    if (point === null) return;
    setInProgress((current) => {
      if (current === null || current.kind === "text") return current;
      if (current.kind === "pen" || current.kind === "highlight") {
        return { ...current, points: [...current.points, point.at] };
      }
      return { ...current, to: point.at };
    });
  };

  // Committing outside the setInProgress updater keeps it pure under StrictMode.
  const onPointerUp = () => {
    if (inProgress !== null) setDoc((current) => commitShape(current, inProgress));
    setInProgress(null);
  };

  const undo = useCallback(() => setDoc(undoShape), []);
  const redo = useCallback(() => setDoc(redoShape), []);
  const clear = useCallback(() => {
    setPendingText(null);
    setInProgress(null);
    setDoc(clearShapes);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key === "y") {
      event.preventDefault();
      redo();
    }
  };

  const submit = async (action: MarkupAction) => {
    const image = imageRef.current;
    if (image === null || busy !== null) return;
    setBusy(action);
    setStatus(null);
    try {
      const png = await exportMarkupPng(image, doc.shapes);
      const message = await onSubmit(action, png);
      if (message !== null) setStatus({ text: message, error: false });
    } catch (cause) {
      setStatus({
        text: cause instanceof Error ? cause.message : String(cause),
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const isText = tool === "text";
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 outline-none" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-1">
        {TOOLS.map((entry) => (
          <Button
            key={entry.tool}
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={entry.label}
            aria-pressed={tool === entry.tool}
            onClick={() => setTool(entry.tool)}
          >
            <entry.icon className={ICON_CLASS} />
          </Button>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        {MARKUP_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Color ${swatch}`}
            aria-pressed={color === swatch}
            onClick={() => setColor(swatch)}
            className={cn(
              "h-5 w-5 cursor-pointer rounded-full border border-border",
              color === swatch && "ring-2 ring-ring ring-offset-1 ring-offset-background",
            )}
            style={{ backgroundColor: swatch }}
          />
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        {isText
          ? (
              <div className="flex items-center" role="group" aria-label="Font size">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Smaller text"
                  disabled={fontSize <= MARKUP_FONT_SIZES[0]}
                  onClick={() => setFontSize((value) => stepFontSize(value, -1))}
                >
                  <ChevronLeft className={ICON_CLASS} />
                </Button>
                <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">
                  {fontSize}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Larger text"
                  disabled={fontSize >= MARKUP_FONT_SIZES[MARKUP_FONT_SIZES.length - 1]}
                  onClick={() => setFontSize((value) => stepFontSize(value, 1))}
                >
                  <ChevronRight className={ICON_CLASS} />
                </Button>
              </div>
            )
          : MARKUP_WIDTHS.map((value) => (
              <Button
                key={value}
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={`Stroke ${value}px`}
                aria-pressed={width === value}
                onClick={() => setWidth(value)}
              >
                <span
                  className="rounded-full bg-foreground"
                  style={{ width: value + 4, height: value + 4 }}
                />
              </Button>
            ))}
        <div className="mx-2 h-5 w-px bg-border" />
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Undo" disabled={doc.past.length === 0} onClick={undo}>
          <Undo2 className={ICON_CLASS} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Redo" disabled={doc.future.length === 0} onClick={redo}>
          <Redo2 className={ICON_CLASS} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Clear" disabled={doc.shapes.length === 0} onClick={clear}>
          <Trash2 className={ICON_CLASS} />
        </Button>
      </div>

      <div
        ref={stageRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-muted/40"
      >
        <div
          className="relative"
          style={size !== null && stage !== null ? fitSize(size, stage) : undefined}
        >
          <img
            ref={imageRef}
            src={imageUrl}
            alt="Browser tab screenshot"
            draggable={false}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            className="block h-full w-full select-none"
          />
          {size !== null ? (
            <canvas
              ref={canvasRef}
              width={size.width}
              height={size.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className={cn(
                "absolute inset-0 h-full w-full touch-none",
                isText ? "cursor-text" : "cursor-crosshair",
              )}
            />
          ) : null}
          {pendingText !== null ? (
            <TextBox
              css={pendingText.css}
              maxWidth={
                size === null
                  ? null
                  : Math.max(size.width / pendingText.scale - pendingText.css.x - TEXT_EDGE_MARGIN, fontSize * 4)
              }
              color={color}
              fontSize={fontSize}
              onCommit={commitText}
              onCancel={() => setPendingText(null)}
              transcribe={transcribe}
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            status?.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {status?.text ?? "Draw on the screenshot, then copy it or add it to the prompt."}
        </span>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void submit("copy")}>
          <Copy className={ICON_CLASS} />
          {busy === "copy" ? "Copying…" : "Copy image"}
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => void submit("prompt")}>
          <MessageSquarePlus className={ICON_CLASS} />
          {busy === "prompt" ? "Adding…" : "Add to prompt"}
        </Button>
      </div>
    </div>
  );
}
