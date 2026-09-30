// Diff renderer that shows the thread PR's GitHub review threads inline,
// under the lines they're about. Resolved threads start collapsed. Files
// without comments (and diffs outside a thread) render with BB's own
// renderer, untouched.
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { experimental_useCodeTheme as useCodeTheme, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginDiffRendererProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { FeedItem } from "../detail";
import type { rpcContract } from "../server";
import { Discussion } from "./Discussion";
import { errorText } from "./shared";
import { usePrDetail, useThreadPrKey } from "./useThreadPr";

// Same metrics as BB's diff view.
const DIFF_VIEW_STYLE = { "--diffs-font-size": "12px", "--diffs-line-height": "18px" } as CSSProperties;

export function DiffWithComments(props: PluginDiffRendererProps) {
  const { threadId } = useBbContext();
  const pr = useThreadPrKey(threadId);
  const prKey = pr.status === "found" ? pr.key : null;
  const { detail, refresh } = usePrDetail(prKey);

  // Outdated threads point at lines that moved, so they stay in the tab only.
  const threads = useMemo(
    () =>
      (detail?.feed ?? []).filter(
        (item) => item.kind === "thread" && !item.isOutdated && item.line !== null && item.path === props.path,
      ),
    [detail, props.path],
  );

  if (threadId === null || prKey === null || threads.length === 0) return <props.Original />;
  return <AnnotatedDiff {...props} threadId={threadId} prKey={prKey} threads={threads} onChanged={refresh} />;
}

/** A single-file patch with review threads under their lines. Also used by the PR Diff tab. */
export function AnnotatedDiff({
  patch,
  view,
  overflow,
  showLineNumbers,
  threadId,
  prKey,
  threads,
  onChanged,
}: {
  patch: string;
  view: PluginDiffRendererProps["view"];
  overflow: PluginDiffRendererProps["overflow"];
  showLineNumbers: boolean;
  /** null outside a thread: no "Send to thread" button then. */
  threadId: string | null;
  prKey: string;
  threads: FeedItem[];
  onChanged: () => Promise<void>;
}) {
  const codeTheme = useCodeTheme();
  const annotations = useMemo<DiffLineAnnotation<FeedItem>[]>(
    () =>
      threads.map((item) => ({
        side: item.side === "LEFT" ? "deletions" : "additions",
        lineNumber: item.line!,
        metadata: item,
      })),
    [threads],
  );
  const options = useMemo(
    () => ({
      diffStyle: view,
      overflow,
      disableLineNumbers: !showLineNumbers,
      disableFileHeader: true,
      themeType: codeTheme.mode,
      theme: codeTheme.name,
    }),
    [view, overflow, showLineNumbers, codeTheme.mode, codeTheme.name],
  );

  return (
    <div className="overflow-x-auto">
      <div className="w-full max-w-full" style={DIFF_VIEW_STYLE}>
        <PatchDiff<FeedItem>
          patch={patch}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={(annotation) =>
            annotation.metadata ? (
              // The attribute scopes the plugin's CSS to this subtree inside BB's diff.
              <div data-bb-plugin="github-kit" className="px-3 py-2 font-sans">
                <Discussion
                  item={annotation.metadata}
                  prKey={prKey}
                  onChanged={onChanged}
                  showPath={false}
                  actions={annotation.metadata.isResolved || threadId === null ? null : <SendButton item={annotation.metadata} threadId={threadId} prKey={prKey} />}
                />
              </div>
            ) : null
          }
        />
      </div>
    </div>
  );
}

function SendButton({ item, threadId, prKey }: { item: FeedItem; threadId: string; prKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [sending, setSending] = useState(false);
  const send = () => {
    setSending(true);
    rpc.call("comments_send", { threadId, key: prKey, itemIds: [item.id], note: "" }).then(
      () => {
        toast.success("Queued the comment on this thread");
        setSending(false);
      },
      (cause) => {
        toast.error(errorText(cause));
        setSending(false);
      },
    );
  };
  return (
    <button
      type="button"
      onClick={send}
      disabled={sending}
      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <Icon name="ArrowUpRight" className="size-3.5" />
      Send to thread
    </button>
  );
}
