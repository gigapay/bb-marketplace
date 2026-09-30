import assert from "node:assert/strict";
import { test } from "node:test";
import { noul } from "@typesafe-ai/sdk";
import { openRouterJev } from "./linear.ts";

test("the TypeSafe SDK is routed to OpenRouter's decisions endpoint", async () => {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await openRouterJev("sk-or-test").systemOne({ state: { a: 1 }, questions: { ok: noul("Is it ok?") } });
    assert.equal((result.answers as any).ok.noul, 0.9);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer sk-or-test");
  assert.equal(calls[0]!.headers.get("x-openrouter-title"), "BB Linear Issues triage");
  assert.equal(calls[0]!.body.model, "typesafe/jev-1.13");
});
