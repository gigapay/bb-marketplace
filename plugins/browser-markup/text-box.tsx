import { useRef } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { isDictationSupported, useDictation } from "./dictation";
import type { MarkupPoint } from "./markup-model";
import { TEXT_LINE_HEIGHT, textFont } from "./markup-render";

export type Transcribe = (file: File, signal: AbortSignal) => Promise<string>;

export interface TextBoxProps {
  /** Top-left corner in CSS pixels of the stage. */
  css: MarkupPoint;
  /** Width left before the screenshot's right edge, in CSS px; text wraps there. */
  maxWidth: number | null;
  color: string;
  fontSize: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
  transcribe: Transcribe | null;
}

export function TextBox({
  css,
  maxWidth,
  color,
  fontSize,
  onCommit,
  onCancel,
  transcribe,
}: TextBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation({
    transcribe: transcribe ?? (() => Promise.reject(new Error("Voice input is unavailable"))),
    onTranscript: (text) => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      const before = textarea.value.slice(0, textarea.selectionStart);
      const separator = before.length > 0 && !/\s$/.test(before) ? " " : "";
      textarea.setRangeText(`${separator}${text}`, textarea.selectionStart, textarea.selectionEnd, "end");
      textarea.focus();
    },
  });
  const canDictate = transcribe !== null && isDictationSupported();

  return (
    <div className="absolute flex flex-col items-start gap-1" style={{ left: css.x, top: css.y }}>
      <textarea
        ref={textareaRef}
        autoFocus
        rows={1}
        className="min-w-32 resize-none overflow-hidden whitespace-pre-wrap break-words border border-dashed border-ring bg-transparent p-0 outline-none [field-sizing:content]"
        style={{
          color,
          font: textFont(fontSize),
          lineHeight: TEXT_LINE_HEIGHT,
          maxWidth: maxWidth ?? undefined,
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          // Enter places the text, Shift+Enter starts a new line.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onCommit(event.currentTarget.value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {canDictate ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={dictation.state === "recording" ? "Stop dictation" : "Dictate text"}
            title={dictation.state === "recording" ? "Stop dictation" : "Dictate text"}
            disabled={dictation.state === "transcribing"}
            // Keep focus in the textarea: its blur would place the text.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (dictation.state === "recording") dictation.stop();
              else void dictation.start();
            }}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground disabled:cursor-default",
              dictation.state === "recording" &&
                "animate-pulse border-destructive bg-destructive text-destructive-foreground hover:text-destructive-foreground",
            )}
          >
            {dictation.state === "transcribing" ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : dictation.state === "recording" ? (
              <Square className="size-3 fill-current" aria-hidden />
            ) : (
              <Mic className="size-4" aria-hidden />
            )}
          </button>
          {dictation.error !== null ? (
            <span className="max-w-48 rounded bg-background/90 px-1.5 py-0.5 text-xs text-destructive shadow-sm">
              {dictation.error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
