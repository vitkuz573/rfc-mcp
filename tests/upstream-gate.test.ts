import { describe, expect, it } from "vitest";
import { RfcEditorSource } from "../src/upstream/sources.js";
import { HttpClient } from "../src/upstream/http.js";
import { RfcMcpError } from "../src/core/errors.js";

/**
 * A 200 carrying the wrong body must not become a document.
 *
 * Measured, before this gate existed: an HTML 503 error page saved as a document produced
 * `status: "ok"`, 2 requirements at `parse_status: "complete"`, and `verify_citation`
 * returning "verified" - quoting `<p>The server MUST be restarted.` No adversary is needed
 * for that; any upstream hiccup during a sync does it, and every other guarantee in this
 * tool is downstream of a citation resolving to the right bytes.
 */
function httpReturning(status: number, contentType: string | null, body: string) {
  const http = {
    get: async () => ({
      body: new TextEncoder().encode(body),
      contentType,
      retrievedAt: "2026-09-26T00:00:00.000Z",
      url: "https://www.rfc-editor.org/rfc/rfc1000.txt",
      etag: null,
      lastModified: null,
      warnings: [],
      status,
    }),
  };
  return http as unknown as HttpClient;
}

const ERROR_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>503 Service Unavailable</title></head>
<body>
<h1>Service Unavailable</h1>
<p>The server MUST be restarted before the corpus can be rebuilt.</p>
</body>
</html>`;

const PROXY_PAGE = `<html><body><p>The server MUST be restarted.</p></body></html>`;

const REAL_TXT_HEAD = [
  "Network Working Group                                          L. Masinter",
  "Request for Comments: 1000                                       1 April 1990",
  "",
  "              A Real Enough Document",
  "",
  "",
  "Status of This Memo",
  "",
  "",
  "   This memo is a plausible document body.  It opens the way a real",
  "   txt rendition opens, and it is here to prove the gate does not eat it.",
  "",
].join("\n");

describe("a non-document body never becomes a document", () => {
  it("refuses an HTML error page served as text/plain", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", ERROR_PAGE));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(RfcMcpError);
  });

  it("names the real reason rather than a generic failure", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", ERROR_PAGE));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(/web page rather than the document/);
  });

  it("refuses markup even when the content type is correct, because a proxy can rewrite the header", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", PROXY_PAGE));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(/web page rather than the document/);
  });

  it("refuses a body whose declared type is not the rendition that was requested", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/html", REAL_TXT_HEAD));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(/not the rendition that was requested/);
  });

  it("tolerates a missing content type when the bytes are the document, because a proxy may strip it", async () => {
    const sources = new RfcEditorSource(httpReturning(200, null, REAL_TXT_HEAD));
    await expect(sources.fetchPublication(1000, "txt")).resolves.toBeTruthy();
  });

  it("still refuses a missing content type when the bytes are markup, because the bytes are the gate", async () => {
    const sources = new RfcEditorSource(httpReturning(200, null, ERROR_PAGE));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(/web page rather than the document/);
  });

  it("refuses a body containing a NUL, whatever the header says", async () => {
    const withNul = `${REAL_TXT_HEAD}\u0000\u0000binary tail`;
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", withNul));
    await expect(sources.fetchPublication(1000, "txt")).rejects.toThrow(/binary/);
  });

  it("is retryable, because an upstream hiccup is retryable and a caller may try again", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", ERROR_PAGE));
    await sources.fetchPublication(1000, "txt").catch((error: unknown) => {
      expect(error).toBeInstanceOf(RfcMcpError);
      expect((error as RfcMcpError).retryable).toBe(true);
      expect((error as RfcMcpError).code).toBe("UPSTREAM_CONTRACT");
    });
    expect.assertions(3);
  });
});

describe("a real document is not refused", () => {
  it("accepts a plausible txt rendition with the declared type", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", REAL_TXT_HEAD));
    const asset = await sources.fetchPublication(1000, "txt");
    expect(asset.bytes).toBe(new TextEncoder().encode(REAL_TXT_HEAD).byteLength);
    expect(asset.contentType).toBe("text/plain");
  });

  it("accepts a txt rendition with a charset parameter", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain; charset=us-ascii", REAL_TXT_HEAD));
    await expect(sources.fetchPublication(1000, "txt")).resolves.toBeTruthy();
  });

  it("accepts a body opening with a form feed, which a real txt rendition can", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", `\f\n${REAL_TXT_HEAD}`));
    await expect(sources.fetchPublication(1000, "txt")).resolves.toBeTruthy();
  });

  it("accepts a body opening with a UTF-8 BOM", async () => {
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", `\uFEFF${REAL_TXT_HEAD}`));
    await expect(sources.fetchPublication(1000, "txt")).resolves.toBeTruthy();
  });

  it("accepts the xml rendition with its own types", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rfc><front/></rfc>`;
    const sources = new RfcEditorSource(httpReturning(200, "application/rfc+xml", xml));
    await expect(sources.fetchPublication(1000, "xml")).resolves.toBeTruthy();
  });

  it("accepts a txt rendition that contains angle brackets later on, because only the head is sniffed", async () => {
    const withExample = `${REAL_TXT_HEAD}\n   The example <length> is a field name in angle brackets.\n`;
    const sources = new RfcEditorSource(httpReturning(200, "text/plain", withExample));
    await expect(sources.fetchPublication(1000, "txt")).resolves.toBeTruthy();
  });
});
