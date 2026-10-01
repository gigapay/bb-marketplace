import { useCallback, useEffect, useRef, useState } from "react";

export type DictationState = "idle" | "recording" | "transcribing";

function preferredMimeType(): string | null {
  for (const candidate of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

function recordingFile(blob: Blob, mimeType: string): File {
  const extension = mimeType.includes("ogg")
    ? "ogg"
    : mimeType.includes("mp4")
      ? "mp4"
      : "webm";
  return new File([blob], `recording.${extension}`, { type: mimeType });
}

export function isDictationSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/**
 * Records the microphone and hands the audio to `transcribe` (BB's voice
 * service, the same one behind the composer mic). Stops the mic on unmount.
 */
export function useDictation({
  transcribe,
  onTranscript,
}: {
  transcribe: (file: File, signal: AbortSignal) => Promise<string>;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ transcribe, onTranscript });
  callbacks.current = { transcribe, onTranscript };

  const release = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    recorder?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder !== null) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      release();
    },
    [release],
  );

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      const recorder =
        mimeType === null
          ? new MediaRecorder(stream)
          : new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        release();
        if (chunks.length === 0) {
          setState("idle");
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setState("transcribing");
        callbacks.current
          .transcribe(recordingFile(new Blob(chunks, { type }), type), controller.signal)
          .then(
            (text) => {
              if (!controller.signal.aborted && text.trim().length > 0) {
                callbacks.current.onTranscript(text.trim());
              }
            },
            (cause: unknown) => {
              if (!controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            },
          )
          .finally(() => {
            if (!controller.signal.aborted) setState("idle");
          });
      };
      recorderRef.current = recorder;
      recorder.start();
      setState("recording");
    } catch (cause) {
      release();
      setState("idle");
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied"
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  }, [release, state]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") recorder.stop();
  }, []);

  return { state, error, start, stop };
}
