// Linear uploads need the API key, which only the plugin server holds, so
// Markdown shown in the UI routes them through the server's /upload proxy.
import { PLUGIN_ID } from "./plugin-id.ts";
const UPLOAD_URL = /https:\/\/uploads\.linear\.app\/[^\s)"'<>\]]+/g;
const PROXY_PATH = `/api/v1/plugins/${PLUGIN_ID}/http/upload`;

export function proxyLinearUploads(markdown: string): string {
  const base = `${window.location.origin}${PROXY_PATH}?url=`;
  return markdown.replace(UPLOAD_URL, (url) => base + encodeURIComponent(url));
}

/** The proxied URL for a link, if it points at a Linear upload (raw or proxied). */
export function uploadProxyUrl(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin && url.pathname === PROXY_PATH) return url.href;
    if (url.protocol === "https:" && url.hostname === "uploads.linear.app") {
      return `${window.location.origin}${PROXY_PATH}?url=${encodeURIComponent(url.href)}`;
    }
  } catch {
    // Not a URL we handle.
  }
  return null;
}
