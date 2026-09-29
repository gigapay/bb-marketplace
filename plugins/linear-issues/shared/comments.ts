// Groups Linear's flat comment list into discussions, the way Linear shows
// them: a root comment with its replies (Linear nests only one level).

export interface ThreadableComment {
  id: string;
  parentId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CommentThread<C extends ThreadableComment> {
  root: C;
  replies: C[];
  resolved: boolean;
}

export function groupCommentThreads<C extends ThreadableComment>(comments: readonly C[]): CommentThread<C>[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const replies = new Map<string, C[]>();
  const roots: C[] = [];
  for (const comment of comments) {
    // A reply whose parent is outside the page (or deleted) still shows,
    // as its own discussion, instead of disappearing.
    if (comment.parentId !== null && byId.has(comment.parentId)) {
      const list = replies.get(comment.parentId) ?? [];
      list.push(comment);
      replies.set(comment.parentId, list);
    } else {
      roots.push(comment);
    }
  }
  const oldestFirst = (a: C, b: C) => a.createdAt.localeCompare(b.createdAt);
  return roots.sort(oldestFirst).map((root) => ({
    root,
    replies: (replies.get(root.id) ?? []).sort(oldestFirst),
    resolved: root.resolvedAt !== null,
  }));
}
