import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { proxyLinearUploads, uploadProxyUrl } from "@/lib/uploads";
import { EmptyState } from "./shared";

type Attachment = { url: string; name: string };

/**
 * BB's Markdown for Linear text: uploads go through the plugin's proxy, and a
 * click on a link to one opens it here instead of in a browser tab, where it
 * would be a bare proxy URL (or a 401 from Linear).
 */
export function LinearMarkdown({ content }: { content: string }) {
  const [attachment, setAttachment] = useState<Attachment | null>(null);

  // Capture phase: runs before the link's own handler, which would route
  // the click to a browser.
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    const url = uploadProxyUrl(anchor.getAttribute("href") ?? "");
    if (url === null) return;
    event.preventDefault();
    event.stopPropagation();
    const text = anchor.textContent?.trim() || anchor.querySelector("img")?.getAttribute("alt") || "";
    setAttachment({ url, name: text || "Attachment" });
  };

  return (
    <div onClickCapture={onClickCapture}>
      <Markdown content={proxyLinearUploads(content)} />
      <AttachmentViewer attachment={attachment} onClose={() => setAttachment(null)} />
    </div>
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; objectUrl: string; type: string; size: number };

function AttachmentViewer({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!attachment) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoaded({ status: "loading" });
    // Fetched as a blob so we know its type (Linear URLs carry no extension)
    // and so PDFs render without the proxy's sandboxing headers.
    fetch(attachment.url, { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ status: "ready", objectUrl, type: blob.type, size: blob.size });
      })
      .catch((cause) => !cancelled && setLoaded({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  const kind =
    loaded.status !== "ready"
      ? null
      : loaded.type.startsWith("image/")
        ? "image"
        : loaded.type.startsWith("video/")
          ? "video"
          : loaded.type === "application/pdf"
            ? "pdf"
            : "file";

  return (
    <Dialog open={attachment !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="break-words pr-6">{attachment?.name ?? "Attachment"}</DialogTitle>
          <DialogDescription>
            {loaded.status === "ready" ? `${loaded.type || "unknown type"} · ${formatSize(loaded.size)}` : "Linear attachment"}
          </DialogDescription>
        </DialogHeader>
        {loaded.status === "loading" ? (
          <EmptyState>
            <span className="inline-flex items-center gap-2">
              <Icon name="Loading" className="size-4 animate-spin" />
              Loading from Linear…
            </span>
          </EmptyState>
        ) : loaded.status === "error" ? (
          <EmptyState>Couldn't load this attachment: {loaded.message}</EmptyState>
        ) : (
          <div className="flex max-h-[75vh] min-h-40 items-center justify-center overflow-auto rounded-md bg-muted/40">
            {kind === "image" ? (
              <img src={loaded.objectUrl} alt={attachment?.name ?? ""} className="max-h-[75vh] max-w-full object-contain" />
            ) : kind === "video" ? (
              <video src={loaded.objectUrl} controls className="max-h-[75vh] max-w-full" />
            ) : kind === "pdf" ? (
              <iframe src={loaded.objectUrl} title={attachment?.name ?? "PDF"} className="h-[75vh] w-full border-0" />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No preview for this file type. Download it to open it.</p>
            )}
          </div>
        )}
        {loaded.status === "ready" ? (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" asChild>
              <a href={loaded.objectUrl} download={attachment?.name ?? "attachment"}>
                <Icon name="Download" className="size-4" />
                Download
              </a>
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
