import { useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  type ExperimentalPluginBrowserToolbarActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@/components/ui/chrome-style-tokens";
import { COARSE_POINTER_HEADER_ICON_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { Camera, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { captureBrowserTab } from "./capture";
import { attachFileToComposer } from "./composer-attach";
import { MarkupEditor, type MarkupAction } from "./MarkupEditor";
import { MARKUP_MENTION_PROVIDER_ID } from "./shared";
import type { browserMarkupRpcContract } from "./server";

const PANEL_ACTION_ID = "markup";

// Captures handed from the toolbar button to the panel tab. Kept in memory on
// purpose: a capture is throwaway, and panel params must stay small JSON.
const captures = new Map<string, string>();

type PanelParams = { captureId: string; url: string };

function parsePanelParams(value: unknown): PanelParams | null {
  if (typeof value !== "object" || value === null) return null;
  const { captureId, url } = value as Record<string, unknown>;
  return typeof captureId === "string" && typeof url === "string"
    ? { captureId, url }
    : null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function pageHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  return createImageBitmap(blob).then((bitmap) => {
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  });
}

export function ScreenshotMarkupAction({
  threadId,
  tabId,
  url,
  experimental_page: page,
}: ExperimentalPluginBrowserToolbarActionProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The native Browser view paints above every DOM overlay, so the editor
  // opens as a panel tab instead: switching tabs hides the native view.
  const capture = () => {
    if (capturing) return;
    setCapturing(true);
    setError(null);
    captureBrowserTab(sdk, threadId, tabId)
      .then((dataUrl) => {
        const captureId = crypto.randomUUID();
        captures.set(captureId, dataUrl);
        const host = pageHost(url);
        const opened = navigate.openThreadPanel({
          actionId: PANEL_ACTION_ID,
          title: host === null ? "Screenshot" : `Screenshot ${host}`,
          params: { captureId, url },
        });
        if (!opened) {
          captures.delete(captureId);
          throw new Error("Could not open the markup editor in this panel");
        }
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setCapturing(false));
  };

  const label =
    page === null
      ? "Screenshot markup is available in the desktop app"
      : capturing
        ? "Capturing…"
        : "Screenshot and annotate";
  return (
    <button
      type="button"
      aria-label={label}
      disabled={page === null || capturing}
      onClick={capture}
      title={error ?? label}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-md transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        COARSE_POINTER_HEADER_ICON_BUTTON_CLASS,
        CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
        error !== null && "text-destructive",
      )}
    >
      {capturing ? (
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
      ) : (
        <Camera className="size-4" aria-hidden />
      )}
    </button>
  );
}

export function MarkupPanel({ threadId, params }: PluginThreadPanelProps) {
  const sdk = useSdk();
  const rpc = useRpc<typeof browserMarkupRpcContract>();
  const composer = useComposer();
  const parsed = parsePanelParams(params);
  const imageUrl = parsed === null ? undefined : captures.get(parsed.captureId);

  if (parsed === null || imageUrl === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        This screenshot is gone (captures are not kept across reloads). Use the camera button in a Browser tab to take a new one.
      </div>
    );
  }

  const transcribe = (file: File, signal: AbortSignal) =>
    sdk.system.transcribeVoice({ file, signal }).then((result) => result.text);

  const submit = async (action: MarkupAction, png: Blob): Promise<string | null> => {
    if (action === "copy") {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "Copied. Paste it into any composer with Ctrl+V (Cmd+V on macOS).";
    }
    const filename = `screenshot-${pageHost(parsed.url) ?? "page"}-${Date.now()}.png`;
    // composer.focus() moves focus into this thread's draft, which is the
    // composer the drop should land in.
    composer.focus();
    if (attachFileToComposer(new File([png], filename, { type: "image/png" }))) {
      return "Attached to the prompt. You can close this tab.";
    }
    // No single composer to drop on: fall back to a mention that resolves to
    // the image at send time. Uploading as a project attachment makes the
    // image readable on whichever machine runs the thread.
    const thread = await sdk.threads.get({ threadId });
    const upload = await sdk.projects.attachments.upload({
      projectId: thread.projectId,
      clientFile: png,
      filename,
      mimeType: "image/png",
    });
    const { id } = await rpc.call("save", {
      path: upload.path,
      url: parsed.url,
      ...(await imageSize(png)),
    });
    const host = pageHost(parsed.url);
    composer.insertMention({
      provider: MARKUP_MENTION_PROVIDER_ID,
      id,
      label: host === null ? "Screenshot" : `Screenshot ${host}`,
    });
    composer.focus();
    return "Added to the prompt. You can close this tab.";
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <MarkupEditor imageUrl={imageUrl} onSubmit={submit} transcribe={transcribe} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_browserToolbarAction({
    id: "screenshot-markup",
    title: "Screenshot markup",
    component: ScreenshotMarkupAction,
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Screenshot markup",
    layout: "flush",
    component: MarkupPanel,
  });
});
