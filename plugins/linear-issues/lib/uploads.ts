// Linear uploads need the API key, which only the plugin server holds, so
// Markdown shown in the UI routes them through the server's /upload proxy.
const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[^\s)"'<>\]]+/g;
const PROXY_PATH = "/api/v1/plugins/linear-issues/http/upload";

export function proxyLinearUploads(markdown: string): string {
  const base = `${window.location.origin}${PROXY_PATH}?url=`;
  return markdown.replace(UPLOAD_URL, (url) => base + encodeURIComponent(url));
}
