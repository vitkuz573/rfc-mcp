import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, type AppConfig } from "../src/core/config.js";
import { createLogger } from "../src/core/logger.js";
import { RfcService } from "../src/service/rfcService.js";

const RFC_TEXT = `Network Working Group                                   Example Editor
Request for Comments: 9999                                 Example Org
Category: Standards Track                                         June 2026


              Test Document For The Fixture Suite

Status of This Memo

   This document is a test fixture.  Distribution is unlimited.

Abstract

   A fixture that exercises parsing, requirement extraction and citations.

Table of Contents

   1.  Introduction ............................................. 1
   2.  Requirements ............................................. 1
   3.  References ............................................... 2
   3.1.  Normative References .................................... 2


1.  Introduction

   This document is a fixture.  The key words MUST, MUST NOT, SHOULD,
   SHOULD NOT and MAY are to be interpreted as described in [RFC2119].

2.  Requirements

   An implementation MUST emit the X-Trace header.

   A client SHOULD NOT retry a request after a 503 response.  A server MAY
   log the attempt.

3.  References

3.1.  Normative References

   [RFC2119]  Bradner, S., "Key words for use in RFCs to Indicate
              Requirement Levels", BCP 14, RFC 2119,
              DOI 10.17487/RFC2119, March 1997.

Author's Address

   Example Editor
   Example Org
`;

const COMMON_METADATA = {
  number: 9999,
  title: "Test Document For The Fixture Suite",
  abstract: "A fixture that exercises parsing, requirement extraction and citations.",
  published: "2026-06-01",
  pages: 3,
  status: { slug: "std", name: "standards track" },
  stream: { slug: "IETF", name: "IETF" },
  group: { acronym: "example", name: "Example WG", type: "wg" },
  area: { acronym: "gen", name: "General" },
  keywords: ["fixture", "testing"],
  authors: [{ titlepage_name: "Example Editor", is_editor: true, email: "editor@example.invalid" }],
  obsoletes: [9998],
  obsoleted_by: [],
  updates: [],
  updated_by: [],
  subseries: [{ type: "std", number: 99 }],
  identifiers: [{ type: "doi", value: "10.17487/RFC9999" }],
  formats: [{ format: "txt" }, { format: "html" }, { format: "xml" }],
};

function makeFetch(
  overrides: Record<string, () => { status?: number; body: string; etag?: string; type?: string }> = {},
): typeof fetch {
  const routes: Record<string, () => { status?: number; body: string; etag?: string; type?: string }> = {
    "https://www.rfc-editor.org/api/v1/rfc-common/9999.json": () => ({
      body: JSON.stringify(COMMON_METADATA),
      etag: '"common-9999"',
      type: "application/json",
    }),
    "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({ body: RFC_TEXT, etag: '"txt-9999"', type: "text/plain" }),
    "https://www.rfc-editor.org/api/v1/rfc-mini-index.json": () => ({
      body: JSON.stringify({
        miniIndex: [{ number: 9999, title: COMMON_METADATA.title, formats: [{ format: "txt" }] }],
      }),
      type: "application/json",
    }),
    "https://www.rfc-editor.org/api/v1/rfc-html/9999.json": () => ({
      body: JSON.stringify({
        rfc: {},
        errataList: [
          {
            errata_id: "7001",
            errata_status_code: "Verified",
            section: "2",
            orig_text: "MUST",
            correct_text: "MUST NOT",
          },
        ],
      }),
      type: "application/json",
    }),
    "https://datatracker.ietf.org/feed/document-changes/rfc9999/": () => ({
      body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Changed metadata</title><id>urn:x:1</id><published>2026-06-02T00:00:00Z</published><summary>keywords</summary></entry></feed>`,
      type: "application/atom+xml",
    }),
    ...overrides,
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    const result = route();
    const etag = result.etag ?? `"fixture:${url}"`;
    const headers = new Headers({
      etag,
      "content-type": result.type ?? "text/plain",
    });
    const conditional = init?.headers as Record<string, string> | undefined;
    if (conditional?.["if-none-match"] === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(result.body, { status: result.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

describe("RfcService end to end", () => {
  let dir: string;
  let config: AppConfig;
  let service: RfcService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-test-"));
    process.env.RFC_MCP_DATA_DIR = dir;
    process.env.RFC_MCP_LOG_LEVEL = "silent";
    config = loadConfig();
    service = RfcService.create(config, createLogger({ level: "silent" }), { fetchImpl: makeFetch() });
  });

  it("resolves, pins and analyses a document", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    expect(resolved.status).toBe("ok");
    expect(resolved.contract).toBe("ietf-rfc/1");
    expect(resolved.data.document.rfc).toBe(9999);
    expect(resolved.data.snapshot.id).toMatch(/^snp_[0-9a-f]{24}$/u);
    expect(resolved.data.snapshot.quality).toBe("complete");
    expect(resolved.provenance.freshness).toBe("current");

    const requirements = await service.requirements({ snapshot_id: resolved.data.snapshot.id });
    const cited = requirements.data.requirements as readonly { term: string; citation_id: string }[];
    const terms = cited.map((requirement) => requirement.term);
    expect(terms).toContain("MUST");
    expect(terms).toContain("SHOULD NOT");
    expect(terms).toContain("MAY");
    for (const requirement of cited) {
      expect(requirement.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
    }
  });

  it("never exposes author email addresses", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const serialized = JSON.stringify(resolved.data.document);
    expect(serialized).not.toContain("editor@example.invalid");
    expect((resolved.data.document.authors as { name: string }[])[0]?.name).toBe("Example Editor");
  });

  it("reads an exact section and returns verifiable source maps", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const read = await service.read({ snapshot_id: resolved.data.snapshot.id, section: "2" });
    expect(read.data.section?.title).toContain("Requirements");
    expect(read.data.text).toContain("X-Trace");
    const blocks = read.data.blocks as readonly { text: string; byte_start: number; byte_end: number }[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]!.byte_end).toBeGreaterThan(blocks[0]!.byte_start);
  });

  it("classifies references and attaches in-body citation sites", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const references = await service.references({ snapshot_id: resolved.data.snapshot.id });
    const normative = references.data.references as {
      label: string;
      relation: string;
      target_rfc: number | null;
      cited_by: unknown[];
    }[];
    const rfc2119 = normative.find((reference) => reference.label === "RFC2119");
    expect(rfc2119?.relation).toBe("normative");
    expect(rfc2119?.target_rfc).toBe(2119);
    expect((rfc2119?.cited_by ?? []).length).toBeGreaterThan(0);
  });

  it("verifies a citation against the stored bytes", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const requirements = await service.requirements({ snapshot_id: resolved.data.snapshot.id });
    const citation = (requirements.data.requirements as { citation_id: string }[])[0]!.citation_id;
    const verified = await service.verifyCitation({ snapshot_id: resolved.data.snapshot.id, citation_id: citation });
    expect(verified.data.verdict).toBe("verified");

    const unknown = await service.verifyCitation({
      snapshot_id: resolved.data.snapshot.id,
      quote_sha256: `sha256:${"0".repeat(64)}`,
    });
    expect(unknown.data.verdict).toBe("not_found");
  });

  it("is content addressed: identical bytes produce the same snapshot id", async () => {
    const first = await service.resolve({ rfc: 9999 });
    const second = await service.resolve({ rfc: 9999, refresh: true });
    expect(second.data.snapshot.id).toBe(first.data.snapshot.id);
    expect(service.storeRef.listSnapshots(9999)).toHaveLength(1);
  });

  it("rejects cursors from another query or generation", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const first = await service.search({ query: '"X-Trace"', scope: "text" });
    const cursor = first.next_cursor;
    if (cursor) {
      await expect(service.search({ query: "different", scope: "text", cursor })).rejects.toMatchObject({
        code: "INVALID_CURSOR",
      });
    }
    expect(resolved.data.snapshot.id).toMatch(/^snp_/u);
  });

  it("expands a punctuated phrase into an AND of its parts", async () => {
    const withHyphen = await service.search({ query: '"X-Trace"', scope: "text" });
    const asWords = await service.search({ query: '"X" "Trace"', scope: "text" });
    expect(withHyphen.data.total).toBe(asWords.data.total);
  });

  it("answers catalog search from the local index and text search from snapshots", async () => {
    await service.resolve({ rfc: 9999 });
    const catalog = await service.search({ query: "fixture", scope: "catalog" });
    expect(catalog.data.hits.length).toBeGreaterThan(0);
    const text = await service.search({ query: '"X-Trace"', scope: "text" });
    expect(text.data.hits.length).toBeGreaterThan(0);
    expect(text.data.hits[0]?.citation_id).toMatch(/^cit_/u);
  });

  it("keeps errata as an overlay and never patches the snapshot", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const errata = await service.errata({ snapshot_id: resolved.data.snapshot.id });
    expect(errata.data.errata[0]?.errata_id).toBe("7001");
    const read = await service.read({ snapshot_id: resolved.data.snapshot.id, section: "2" });
    expect(read.data.text).toContain("MUST emit the X-Trace header");
  });

  it("diffs two snapshots on the requirements axis", async () => {
    const left = await service.resolve({ rfc: 9999 });
    const rightService = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/api/v1/rfc-common/9998.json": () => ({
          body: JSON.stringify({
            ...COMMON_METADATA,
            number: 9998,
            obsoletes: [],
            doi: "10.17487/RFC9998",
            title: "Other fixture",
          }),
          type: "application/json",
        }),
        "https://www.rfc-editor.org/rfc/rfc9998.txt": () => ({
          body: RFC_TEXT.replace("MUST emit the X-Trace header", "SHOULD emit the X-Trace header").replace(
            "Request for Comments: 9999",
            "Request for Comments: 9998",
          ),
          type: "text/plain",
        }),
      }),
    });
    const right = await rightService.resolve({ rfc: 9998 });
    const diff = await service.diff({
      left: { snapshot_id: left.data.snapshot.id },
      right: { snapshot_id: right.data.snapshot.id },
      mode: "requirements",
    });
    const kinds = (diff.data.changes as unknown as readonly { kind: string }[]).map((change) => change.kind);
    expect(kinds).toContain("modality_changed");
  });

  it("isolates failures inside a batch and pins the generation", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const batch = await service.batch({
      operations: [
        { op: "status" },
        { op: "read", snapshot_id: resolved.data.snapshot.id, section: "1" },
        { op: "read", rfc: 4242 },
        { op: "batch" },
      ],
    });
    const results = batch.data.results as { op: string; status: string }[];
    expect(results).toHaveLength(4);
    expect(results[0]?.status).toBe("ok");
    expect(results[1]?.status).toBe("ok");
    expect(results[2]?.status).toBe("failed");
    expect(results[3]?.status).toBe("failed");
    expect(batch.data.complete).toBe(false);
  });

  it("refuses to fabricate data when offline and not cached", async () => {
    const offlineService = RfcService.create({ ...config, offline: true }, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch(),
    });
    await expect(offlineService.resolve({ rfc: 9999 })).rejects.toMatchObject({ code: "NOT_CACHED" });
    const status = await offlineService.status();
    expect(status.data.offline).toBe(true);
  });

  it("rejects non-numeric selectors and unknown sections", async () => {
    await expect(service.resolve({ rfc: "not-a-number" as never })).rejects.toMatchObject({ code: "INVALID_SELECTOR" });
    const resolved = await service.resolve({ rfc: 9999 });
    await expect(service.read({ snapshot_id: resolved.data.snapshot.id, section: "99.99" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("exposes a self-describing contract", async () => {
    const capabilities = await service.capabilities();
    expect(capabilities.data.tools).toContain("verify_citation");
    expect(capabilities.data.limits).toBeDefined();
    expect((capabilities.data.policy as { http: string }).http).toContain("allowlist");
  });

  afterEach(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
