import assert from "node:assert/strict";
import { test } from "node:test";

test("routes Linear uploads through the plugin proxy and leaves other URLs alone", async () => {
  (globalThis as any).window = { location: { origin: "https://bb.example" } };
  const { proxyLinearUploads } = await import("../lib/uploads.ts");
  const upload = "https://uploads.linear.app/7dac/fe54/shot.png";
  const out = proxyLinearUploads(`![Desktop](${upload})\n[spec](https://example.com/a.png) and ${upload}`);
  const proxied = `https://bb.example/api/v1/plugins/linear-issues/http/upload?url=${encodeURIComponent(upload)}`;
  assert.equal(out, `![Desktop](${proxied})\n[spec](https://example.com/a.png) and ${proxied}`);
  assert.equal(proxyLinearUploads("no images"), "no images");
});

test("recognizes upload links, raw or already proxied, and ignores others", async () => {
  (globalThis as any).window = { location: { origin: "https://bb.example", href: "https://bb.example/plugins/linear-issues/issues" } };
  const { uploadProxyUrl } = await import("../lib/uploads.ts");
  const raw = "https://uploads.linear.app/a/b/c";
  const proxied = `https://bb.example/api/v1/plugins/linear-issues/http/upload?url=${encodeURIComponent(raw)}`;
  assert.equal(uploadProxyUrl(raw), proxied);
  assert.equal(uploadProxyUrl(proxied), proxied);
  assert.equal(uploadProxyUrl("https://example.com/a.png"), null);
  assert.equal(uploadProxyUrl("https://bb.example/api/v1/plugins/other/http/upload"), null);
});
