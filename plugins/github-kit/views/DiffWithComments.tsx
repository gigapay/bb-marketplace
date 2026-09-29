// Diff renderer that shows the thread PR's unresolved GitHub review threads
// inline, under the lines they're about. Files without comments (and diffs
// outside a thread) render with BB's own renderer, untouched.
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { toast } from "sonner";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { Markdown, UrlLink, experimental_useCodeTheme as useCodeTheme, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginDiffRendererProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { FeedItem } from "../detail";
import type { rpcContract } from "../server";
import { errorText, relativeTime } from "./shared";
import { usePrDetail, useThreadPrKey } from "./useThreadPr";

// Same metrics as BB's diff view.
const DIFF_VIEW_STYLE = { "--diffs-font-size": "12px", "--diffs-line-height": "18px" } as CSSProperties;

export function DiffWithComments(props: PluginDiffRendererProps) {
  const { threadId } = useBbContext();
  const pr = useThreadPrKey(threadId);
  const prKey = pr.status === "found" ? pr.key : null;
  const detail = usePrDetail(prKey);

  const threads = useMemo(
    () =>
      (detail?.feed ?? []).filter(
        (item) => item.kind === "thread" && !item.isResolved && !item.isOutdated && item.line !== null && item.path === props.path,
      ),
    [detail, props.path],
  );

  if (threadId === null || prKey === null || threads.length === 0) return <props.Original />;
  return <AnnotatedDiff {...props} threadId={threadId} prKey={prKey} threads={threads} />;
}

function AnnotatedDiff({
  patch,
  view,
  overflow,
  showLineNumbers,
  threadId,
  prKey,
  threads,
}: PluginDiffRendererProps & { threadId: string; prKey: string; threads: FeedItem[] }) {
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
            annotation.metadata ? <InlineComment item={annotation.metadata} threadId={threadId} prKey={prKey} /> : null
          }
        />
      </div>
    </div>
  );
}

function InlineComment({ item, threadId, prKey }: { item: FeedItem; threadId: string; prKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [expanded, setExpanded] = useState(true);
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
    // The attribute scopes the plugin's CSS to this subtree inside BB's diff.
    <div data-bb-plugin="github-kit" className="px-3 py-2 font-sans">
      <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          {item.author ? <img src={item.author.avatarUrl} alt="" className="size-5 rounded-full" /> : null}
          <span className="font-medium">{item.author?.login ?? "ghost"}</span>
          {item.author?.isBot ? (
            <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wide">bot</span>
          ) : null}
          <span className="text-muted-foreground">{relativeTime(item.createdAt)}</span>
          {item.replies.length > 0 ? (
            <span className="text-muted-foreground">
              · {item.replies.length} {item.replies.length === 1 ? "reply" : "replies"}
            </span>
          ) : null}
          <span className="flex-1" />
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={send} disabled={sending}>
            <Icon name="Send" className="size-3.5" />
            Send to thread
          </Button>
          <UrlLink href={item.url} target="_blank" aria-label="Open on GitHub" className="text-muted-foreground hover:text-foreground">
            <Icon name="ExternalLink" className="size-3.5" />
          </UrlLink>
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="text-muted-foreground hover:text-foreground"
          >
            <Icon name="ChevronRight" className={expanded ? "size-3.5 rotate-90 transition-transform" : "size-3.5 transition-transform"} />
          </button>
        </div>
        {expanded ? (
          <div className="space-y-3 border-t border-border px-3 py-2">
            <Markdown content={item.body} className="text-sm" />
            {item.replies.map((reply) => (
              <div key={reply.id} className="border-l-2 border-border pl-3">
                <div className="mb-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{reply.author?.login ?? "ghost"}</span> ·{" "}
                  {relativeTime(reply.createdAt)}
                </div>
                <Markdown content={reply.body} className="text-sm" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
