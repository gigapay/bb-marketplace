// GitHub's REST patches are bare hunks; the diff renderer wants a complete
// single-file git patch, so add the header back.
export function toGitPatch(file: { path: string; previousPath: string | null; status: string; patch: string }): string {
  const oldPath = file.previousPath ?? file.path;
  const from = file.status === "added" ? "/dev/null" : `a/${oldPath}`;
  const to = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  const lines = [`diff --git a/${oldPath} b/${file.path}`];
  if (file.status === "added") lines.push("new file mode 100644");
  if (file.status === "removed") lines.push("deleted file mode 100644");
  if (file.previousPath !== null && file.previousPath !== file.path) lines.push(`rename from ${oldPath}`, `rename to ${file.path}`);
  lines.push(`--- ${from}`, `+++ ${to}`, file.patch);
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}
