import { describe, expect, it } from "vitest";

import { ALLOWED_HOSTS, assertAllowedUrl, HttpClient } from "../src/upstream/http.js";
import { CorpusStore } from "../src/store/database.js";
import { createLogger } from "../src/core/logger.js";

function client(fetchImpl: typeof fetch, store = new CorpusStore(":memory:")): HttpClient {
  return new HttpClient({
    userAgent: "rfc-mcp-test",
    timeoutMs: 2000,
    maxBytes: 4096,
    maxConcurrency: 2,
    defaultTtlMs: 60_000,
    negativeTtlMs: 60_000,
    logger: createLogger({ level: "silent" }),
    cache: store,
    fetchImpl,
  });
}

describe("HttpClient policy", () => {
  it("allowlists exactly the IETF primary sources over https", () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual(["datatracker.ietf.org", "errata.rfc-editor.org", "www.rfc-editor.org"]);
    expect(assertAllowedUrl("https://www.rfc-editor.org/rfc/rfc2119.txt").hostname).toBe("www.rfc-editor.org");
  });

  it("refuses http, other hosts and malformed URLs", () => {
    expect(() => assertAllowedUrl("http://www.rfc-editor.org/rfc/rfc2119.txt")).toThrowError(/https/u);
    expect(() => assertAllowedUrl("https://evil.example/rfc2119.txt")).toThrowError(/allowlist/u);
    expect(() => assertAllowedUrl("https://169.254.169.254/latest/meta-data")).toThrowError(/allowlist/u);
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrowError(/https/u);
    expect(() => assertAllowedUrl("not a url")).toThrowError(/Malformed/u);
  });

  it("caches a response and revalidates with ETag", async () => {
    let calls = 0;
    const store = new CorpusStore(":memory:");
    const http = client(
      (async (_input: unknown, init?: RequestInit) => {
        calls += 1;
        const headers = new Headers({ etag: '"v1"', "content-type": "text/plain" });
        if ((init?.headers as Record<string, string> | undefined)?.["if-none-match"] === '"v1"') {
          return new Response(null, { status: 304, headers });
        }
        return new Response("hello", { status: 200, headers });
      }) as unknown as typeof fetch,
      store,
    );

    const first = await http.get({
      url: "https://www.rfc-editor.org/rfc/rfc2119.txt",
      label: "t",
      accept: ["text/plain"],
    });
    expect(first.body.toString("utf8")).toBe("hello");
    expect(calls).toBe(1);

    const cached = await http.get({
      url: "https://www.rfc-editor.org/rfc/rfc2119.txt",
      label: "t",
      accept: ["text/plain"],
    });
    expect(cached.fromCache).toBe(true);
    expect(calls).toBe(1);

    const revalidated = await http.get({
      url: "https://www.rfc-editor.org/rfc/rfc2119.txt",
      label: "t",
      accept: ["text/plain"],
      revalidate: true,
    });
    expect(revalidated.fromCache).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries 5xx and succeeds", async () => {
    let calls = 0;
    const http = client((async () => {
      calls += 1;
      if (calls < 3) return new Response("busy", { status: 503 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch);
    const result = await http.get({
      url: "https://datatracker.ietf.org/doc/rfc2119/doc.json",
      label: "t",
      accept: ["application/json"],
    });
    expect(result.body.toString("utf8")).toBe("ok");
    expect(calls).toBe(3);
  });

  it("serves a stale copy when the upstream fails", async () => {
    const store = new CorpusStore(":memory:");
    let fail = false;
    const http = client(
      (async () => {
        if (fail) return new Response("down", { status: 500 });
        return new Response("cached", { status: 200, headers: { etag: '"v1"' } });
      }) as unknown as typeof fetch,
      store,
    );

    await http.get({ url: "https://www.rfc-editor.org/rfc/rfc9110.txt", label: "t", accept: ["text/plain"], ttlMs: 0 });
    fail = true;
    const stale = await http.get({
      url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
      label: "t",
      accept: ["text/plain"],
    });
    expect(stale.body.toString("utf8")).toBe("cached");
    expect(stale.warnings).toContain("stale_cache_served_after_upstream_failure");
  });

  it("enforces the response size limit", async () => {
    const http = client((async () => new Response("x".repeat(10_000), { status: 200 })) as unknown as typeof fetch);
    await expect(
      http.get({ url: "https://www.rfc-editor.org/rfc/rfc9110.pdf", label: "t", accept: ["application/pdf"] }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TOO_LARGE" });
  });

  it("reports a missing upstream document as NOT_FOUND", async () => {
    const http = client((async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
    await expect(
      http.get({ url: "https://www.rfc-editor.org/rfc/rfc99999.txt", label: "t", accept: ["text/plain"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const http = client((async (_input: unknown, init?: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 50);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return new Response("late", { status: 200 });
    }) as unknown as typeof fetch);
    const promise = http.get({
      url: "https://www.rfc-editor.org/rfc/rfc2119.txt",
      label: "t",
      accept: ["text/plain"],
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
