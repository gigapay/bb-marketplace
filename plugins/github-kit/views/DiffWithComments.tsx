// Diff renderer that shows the thread PR's GitHub review threads inline,
// under the lines they're about. Resolved threads start collapsed. Files
// without comments (and diffs outside a thread) render with BB's own
// renderer, untouched.
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { experimental_useCodeTheme as useCodeTheme, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginDiffRendererProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { FeedItem } from "../detail";
import type { rpcContract } from "../server";
import { Discussion } from "./Discussion";
import { LineComposer, PendingComment } from "./LineComposer";
import { useDrafts, type Draft, type LineAnchor } from "./reviewDrafts";
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

type Annotation =
  | { kind: "thread"; item: FeedItem }
  | { kind: "draft"; draft: Draft }
  | { kind: "composer"; anchor: LineAnchor };

/**
 * A single-file patch with review threads under their lines. With `review`
 * set (the PR Diff tab), a "+" in the gutter opens a comment box, and
 * pending review comments show under their lines too.
 */
export function AnnotatedDiff({
  patch,
  view,
  overflow,
  showLineNumbers,
  threadId,
  prKey,
  threads,
  onChanged,
  review,
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
  review?: { path: string; agentThreadId: string | null };
}) {
  const codeTheme = useCodeTheme();
  const drafts = useDrafts(prKey);
  const [composer, setComposer] = useState<LineAnchor | null>(null);
  const reviewPath = review?.path ?? null;
  const fileDrafts = useMemo(
    () => (reviewPath === null ? [] : drafts.filter((draft) => draft.anchor.path === reviewPath)),
    [drafts, reviewPath],
  );

  const annotations = useMemo<DiffLineAnnotation<Annotation>[]>(() => {
    const side = (value: "LEFT" | "RIGHT") => (value === "LEFT" ? ("deletions" as const) : ("additions" as const));
    return [
      ...threads.map((item) => ({ side: side(item.side ?? "RIGHT"), lineNumber: item.line!, metadata: { kind: "thread" as const, item } })),
      ...fileDrafts.map((draft) => ({ side: side(draft.anchor.side), lineNumber: draft.anchor.line, metadata: { kind: "draft" as const, draft } })),
      ...(composer ? [{ side: side(composer.side), lineNumber: composer.line, metadata: { kind: "composer" as const, anchor: composer } }] : []),
    ];
  }, [threads, fileDrafts, composer]);

  const options = useMemo(
    () => ({
      diffStyle: view,
      overflow,
      disableLineNumbers: !showLineNumbers,
      disableFileHeader: true,
      themeType: codeTheme.mode,
      theme: codeTheme.name,
      ...(reviewPath !== null
        ? {
            enableGutterUtility: true,
            enableLineSelection: true,
            lineHoverHighlight: "number" as const,
            onGutterUtilityClick: (range: SelectedLineRange) => {
              // Drag-selecting lines comments on the whole range, like GitHub.
              const start = Math.min(range.start, range.end);
              const end = Math.max(range.start, range.end);
              setComposer({
                path: reviewPath,
                line: end,
                startLine: start === end ? null : start,
                side: (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT",
              });
            },
          }
        : {}),
    }),
    [view, overflow, showLineNumbers, codeTheme.mode, codeTheme.name, reviewPath],
  );

  return (
    <div className="overflow-x-auto">
      <div className="w-full max-w-full" style={DIFF_VIEW_STYLE}>
        <PatchDiff<Annotation>
          patch={patch}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={(annotation) => {
            const value = annotation.metadata;
            if (!value) return null;
            return (
              // The attribute scopes the plugin's CSS to this subtree inside BB's diff.
              <div data-bb-plugin="github-kit" className="px-3 py-2 font-sans">
                {value.kind === "thread" ? (
                  <Discussion
                    item={value.item}
                    prKey={prKey}
                    onChanged={onChanged}
                    showPath={false}
                    actions={value.item.isResolved || threadId === null ? null : <SendButton item={value.item} threadId={threadId} prKey={prKey} />}
                  />
                ) : value.kind === "draft" ? (
                  <PendingComment draft={value.draft} prKey={prKey} />
                ) : (
                  <LineComposer
                    anchor={value.anchor}
                    prKey={prKey}
                    agentThreadId={review?.agentThreadId ?? null}
                    onDone={() => setComposer(null)}
                    onPosted={onChanged}
                  />
                )}
              </div>
            );
          }}
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
