import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, type AppConfig } from "../src/core/config.js";
import { createLogger } from "../src/core/logger.js";
import { RfcService } from "../src/service/rfcService.js";
import { SearchInputSchema, RequirementsInputSchema, describeIssues } from "../src/service/inputSchemas.js";

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

   An implementation MUST emit the X-Trace header.  The header format is
   specified in [FIPS197].

   A client SHOULD NOT retry a request after a 503 response.  A server MAY
   log the attempt.

3.  References

3.1.  Normative References

   [RFC2119]  Bradner, S., "Key words for use in RFCs to Indicate
              Requirement Levels", BCP 14, RFC 2119,
              DOI 10.17487/RFC2119, March 1997.

  [FIPS197]  National Institute of Standards and Technology, "Specification
              for the Advanced Encryption Standard (AES)", FIPS PUB 197,
              November 2001.

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

/**
 * A document with nothing in it the extractor refuses to read on kind alone.
 *
 * The masthead, the centred title and the table of contents of an RFC are typed `table` and
 * `preformatted` by the block classifier - the masthead because its two columns are three
 * spaces apart, the title because it is indented - so the ordinary test fixture has two
 * skipped blocks that could hold a rule and can never be `complete`. That is the honest
 * answer for a real RFC and it is measured in `eval/`, but it makes the `complete` branch
 * untestable, so this fixture exists to reach it: no column alignment, no indentation, no
 * table. Every assertion about the verdict is made against this one and against the same
 * document with a table added, so each test says which fact moved the verdict.
 */
const CLEAN_TEXT = `Network Working Group
Request for Comments: 9999
Category: Standards Track
Date: June 2026

Clean Fixture

Abstract

A fixture with no tables, no preformatted blocks and no indented title.

1.  Requirements

An implementation MUST emit the X-Trace header.

A server MAY log the attempt.

The maximum total length of a command line is 512 octets.

Author's Address

Example Editor
`;

/** A pipe table, which the classifier types `table` and the extractor therefore never reads. */
const PIPE_TABLE = `
2.  Field Table

| Field   | Value |
| X-Trace | 512   |
`;

/** The same table with a lower-case modal in it, which is the loss the counter missed. */
const PIPE_TABLE_WITH_MODAL = `
2.  Field Table

| Field        | Value       |
| X-Trace      | must be set |
| Retry budget | 512         |
`;

/** A sentence cut in half by a page break, so the candidate pass sees a fragment. */
const PAGE_BREAK_FRAGMENT = `
3.  Retries

   A receiver must discard every datagram whose checksum does not
   verify, and it
Mockapetris                                                    [Page 4]

RFC 9999        Clean Fixture                                   June 2026
`;

function cleanMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 9999,
    title: "Clean Fixture",
    abstract: "A fixture with no tables, no preformatted blocks and no indented title.",
    published: "2026-06-01",
    pages: 2,
    status: { slug: "std", name: "standards track" },
    stream: { slug: "IETF", name: "IETF" },
    keywords: [],
    authors: [],
    obsoletes: [],
    obsoleted_by: [],
    updates: [],
    updated_by: [],
    subseries: [],
    identifiers: [],
    formats: [{ format: "txt" }],
    ...overrides,
  };
}

/** A document long enough that a per-side line diff cannot run over it. */
function longText(items: number, tail = ""): string {
  const body = Array.from({ length: items }, (_, index) => `\n   Item ${index} is described in this sentence.\n`).join(
    "",
  );
  return `Network Working Group
Request for Comments: 9999
Category: Standards Track
Date: June 2026

Long Fixture

Abstract

A fixture with enough lines that a line diff cannot run over it.

1.  Items
${body}${tail}`;
}

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
    "https://www.rfc-editor.org/rfc/rfc9999.xml": () => ({
      body: `<?xml version="1.0" encoding="UTF-8"?>
<rfc xmlns:xi="http://www.w3.org/2001/XInclude" docName="rfc9999" number="9999" version="3">
  <front>
    <seriesInfo name="Internet Standard" value="STD 99" stream="IETF"/>
  </front>
  <middle>
    <section anchor="introduction" number="1">
      <name>Introduction</name>
      <title>Introduction</title>
      <t>Fixture in RFCXML. The key words MUST and MUST NOT are defined in <xref target="RFC2119"/>.</t>
      <section anchor="requirements" number="1.1">
        <title>Requirements</title>
        <t>An implementation MUST emit the X-Trace header.</t>
      </section>
    </section>
  </middle>
  <back>
    <references anchor="references">
      <name>References</name>
      <title>References</title>
      <reference anchor="RFC2119" target="https://www.rfc-editor.org/info/rfc2119"/>
    </references>
  </back>
</rfc>`,
      etag: '"xml-9999"',
      type: "application/rfc+xml",
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

  it("gives a cited non-IETF document its own identity instead of calling it unresolved", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const all = await service.references({ snapshot_id: resolved.data.snapshot.id, max_results: 50 });
    const references = all.data.references as {
      label: string;
      target_kind: string;
      target: string | null;
      resolution: string;
      external: { kind: string; id: string; publisher: string | null; year: number | null } | null;
      cited_by: unknown[];
    }[];

    const fips = references.find((reference) => reference.label === "FIPS197");
    expect(fips?.target_kind).toBe("external");
    expect(fips?.resolution).toBe("external");
    expect(fips?.target).toBe("FIPS 197");
    expect(fips?.external).toEqual({ kind: "standard", id: "FIPS 197", publisher: "NIST", year: null });
    // It is a real citation, so it keeps its in-body site.
    expect((fips?.cited_by ?? []).length).toBeGreaterThan(0);

    // An IETF reference is unaffected.
    const rfc2119 = references.find((reference) => reference.label === "RFC2119");
    expect(rfc2119?.target_kind).toBe("rfc");
    expect(rfc2119?.external).toBeNull();

    // The filter can now select exactly these.
    const externalOnly = await service.references({
      snapshot_id: resolved.data.snapshot.id,
      resolution: "external",
      max_results: 50,
    });
    expect((externalOnly.data.references as { label: string }[]).map((r) => r.label)).toEqual(["FIPS197"]);

    // And they appear in the graph as external citations, not as unknown labels.
    const graph = await service.dependencies({ snapshot_id: resolved.data.snapshot.id, max_edges: 50 });
    const edges = graph.data.edges as readonly { type: string; to: string }[];
    const externalEdge = edges.find((e) => e.type === "cites_external");
    expect(externalEdge?.to).toContain("FIPS 197");
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

  it("combines a phrase with a section filter and reports a total that matches the hits", async () => {
    await service.resolve({ rfc: 9999 });
    const unfiltered = await service.search({ query: '"X-Trace"', scope: "text" });
    const filtered = await service.search({ query: '"X-Trace" section:2', scope: "text" });
    expect(filtered.data.hits.length).toBeGreaterThan(0);
    expect(filtered.data.total).toBe(filtered.data.hits.length);
    expect(filtered.data.total).toBeLessThanOrEqual(unfiltered.data.total);
    for (const hit of filtered.data.hits) {
      expect(hit.section_path).toContain("2");
    }
    expect(filtered.next_cursor).toBeNull();
  });

  it("keeps pinned evidence when the catalog index is re-synced", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const snapshotId = resolved.data.snapshot.id as string;
    const before = await service.requirements({ snapshot_id: snapshotId });

    // snapshots.rfc references catalog(rfc) with ON DELETE CASCADE, so a catalog
    // refresh implemented as delete + insert destroys every ingested document.
    await service.syncIndex();

    const after = await service.requirements({ snapshot_id: snapshotId });
    expect(after.status).toBe("ok");
    expect(after.data.total).toBe(before.data.total);
    const search = await service.search({ query: '"X-Trace"', scope: "text" });
    expect(search.data.total).toBeGreaterThan(0);
    for (const hit of search.data.hits as readonly { snapshot_id: string }[]) {
      expect(hit.snapshot_id).toBe(snapshotId);
    }
  });

  it("does not leak search-index rows when a snapshot is replaced", async () => {
    const first = await service.resolve({ rfc: 9999 });
    const firstId = first.data.snapshot.id as string;

    const revised = RFC_TEXT.replace("X-Trace", "X-Trace-Revised");
    const second = RfcService.create(config, createLogger({ level: "silent" }), {
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({
          body: revised,
          etag: '"txt-9999-v2"',
          type: "text/plain",
        }),
      }),
    });
    const reingested = await second.resolve({ rfc: 9999, refresh: true });
    const secondId = reingested.data.snapshot.id as string;
    expect(secondId).not.toBe(firstId);

    // A replaced snapshot must take its text index with it: FTS5 does not honour
    // foreign keys, so the cascade alone leaves the whole index behind.
    expect(second.storeRef.purgeOrphanIndexRows()).toBe(0);

    const search = await second.search({ query: '"X-Trace-Revised"', scope: "text" });
    expect(search.data.total).toBeGreaterThan(0);
    for (const hit of search.data.hits as readonly { snapshot_id: string }[]) {
      expect(hit.snapshot_id).toBe(secondId);
    }
  });

  it("verifies a citation returned by text search", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const search = await service.search({ query: '"X-Trace"', scope: "text" });
    const hit = (search.data.hits as readonly { citation_id: string; snapshot_id: string }[])[0]!;
    const verified = await service.verifyCitation({
      snapshot_id: resolved.data.snapshot.id,
      citation_id: hit.citation_id,
    });
    expect(verified.data.verdict).toBe("verified");
    expect(verified.data.matches[0]?.citation_id).toBe(hit.citation_id);
  });

  it("reports not_found for an unknown citation id instead of guessing", async () => {
    const resolved = await service.resolve({ rfc: 9999 });
    const verified = await service.verifyCitation({
      snapshot_id: resolved.data.snapshot.id,
      citation_id: "cit_000000000000000000000000",
    });
    expect(verified.data.verdict).toBe("not_found");
  });

  it("rejects an unknown argument instead of silently dropping it", () => {
    // `section` is a search-grammar filter, not a tool argument; the tool argument
    // is `scope`. Silently ignoring it would return unfiltered results while
    // looking like a filtered search, so the strict schema must reject it.
    const parsed = SearchInputSchema.safeParse({ query: '"X-Trace"', scope: "text", section: "2" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const described = describeIssues(parsed.error, SearchInputSchema);
      expect(described.unknown_keys).toEqual(["section"]);
      expect(described.message).toContain("unknown argument: section");
    }
    expect(SearchInputSchema.safeParse({ query: '"X-Trace"', scope: "text" }).success).toBe(true);
  });

  it("validates every batch operation against the schema of the tool it names", async () => {
    await service.resolve({ rfc: 9999 });
    const resultsOf = (envelope: { data: unknown }): readonly { status: string; error?: { code: string } }[] =>
      (envelope.data as { results: readonly { status: string; error?: { code: string } }[] }).results;

    const good = await service.batch({
      operations: [{ op: "search", query: '"X-Trace"', scope: "text" }],
    });
    expect(resultsOf(good)[0]?.status).toBe("ok");

    const bad = await service.batch({
      operations: [{ op: "search", query: '"X-Trace"', section: "2" } as never],
    });
    expect(resultsOf(bad)[0]?.status).toBe("failed");
    expect(resultsOf(bad)[0]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("re-derives the snapshot when the rule versions change", async () => {
    const first = await service.resolve({ rfc: 9999 });
    const firstId = first.data.snapshot.id as string;
    const firstRequirements = (await service.requirements({ snapshot_id: firstId })).data.total;

    // Same bytes, same metadata, new rules. The version is part of the snapshot
    // identity, so this must produce a new snapshot rather than reuse the old
    // analysis under new rules.
    const bumped = RfcService.create(
      { ...config, extractorVersion: "normative-2119-8174-test.2" },
      createLogger({ level: "silent" }),
      { fetchImpl: makeFetch() },
    );
    const result = await bumped.reanalyze(9999);
    expect(result.changed).toBe(true);
    expect(result.to).not.toBe(firstId);

    // The reported id must exist in the store, with the new version recorded.
    const stored = bumped.storeRef.getLatestSnapshot(9999, "txt");
    expect(stored?.id).toBe(result.to);
    expect(stored?.extractor_version).toBe("normative-2119-8174-test.2");
    expect(bumped.storeRef.listSnapshots(9999)).toHaveLength(1);

    // Analysis is readable under the new id and its citations verify.
    const reread = await bumped.requirements({ snapshot_id: result.to });
    expect(reread.data.total).toBe(firstRequirements);
    const cited = (reread.data.requirements as readonly { citation_id: string }[])[0]!;
    const verified = await bumped.verifyCitation({ snapshot_id: result.to, citation_id: cited.citation_id });
    expect(verified.data.verdict).toBe("verified");

    // A second run with the same rules is a no-op.
    expect((await bumped.reanalyze(9999)).changed).toBe(false);
  });

  it("returns the RFCXML structure and its warnings for an xml_outline read", async () => {
    const resolved = await service.resolve({ rfc: 9999, with_xml: true });
    const read = await service.read({ snapshot_id: resolved.data.snapshot.id, target: "xml_outline" });
    expect(read.status).toBe("ok");
    expect(read.data.target.kind).toBe("xml_outline");
    // The plain-text outline is a different structure and must stay separate.
    expect(read.data.outline).toBeNull();

    const outline = read.data.xml_outline!;
    expect(outline.number).toBe(9999);
    expect(outline.version).toBe("3");
    expect(outline.series[0]?.value).toBe("STD 99");
    // The body lives in <middle> and the references in <back>; both must be present,
    // in document order. Reading only the direct children of <rfc> returns back matter.
    expect(outline.sections.map((s) => s.anchor)).toEqual(["introduction", "references"]);

    const top = outline.sections[0]!;
    expect(top.number).toBe("1");
    expect(top.title).toBe("Introduction");
    expect(top.children[0]?.anchor).toBe("requirements");
    expect(top.normative_terms).toContain("MUST");
    // xref targets are machine-readable and must be captured, not just "[Label]" text.
    expect(top.references).toContain("RFC2119");
  });

  it("stores the XML asset when with_xml is asked for an already cached document", async () => {
    // Ingest without XML: the asset is not part of snapshot identity, so the document is
    // already cached and the request is answered from the store.
    const first = await service.resolve({ rfc: 9999 });
    await expect(service.read({ snapshot_id: first.data.snapshot.id, target: "xml_outline" })).rejects.toThrow(
      /NOT_CACHED|XML asset/u,
    );

    // Asking again with_xml must actually store it. Returning the cached snapshot without
    // the asset made the NOT_CACHED message advice that could not be followed.
    const second = await service.resolve({ rfc: 9999, with_xml: true });
    expect(second.data.snapshot.id).toBe(first.data.snapshot.id);
    expect(second.warnings).not.toContain("xml_unavailable:NOT_FOUND");
    const read = await service.read({ snapshot_id: second.data.snapshot.id, target: "xml_outline" });
    expect(read.status).toBe("ok");
    expect(read.data.xml_outline?.number).toBe(9999);
  });

  it("distinguishes a missing XML asset from a document that has no RFCXML", async () => {
    // The fixture document has an xml format, so the asset can be fetched on demand.
    const withXml = await service.resolve({ rfc: 9999, with_xml: true });
    const ok = await service.read({ snapshot_id: withXml.data.snapshot.id, target: "xml_outline" });
    expect(ok.data.xml_outline?.number).toBe(9999);

    // A document the RFC Editor publishes without RFCXML. Repeating "re-resolve with
    // with_xml" here would be advice that can never succeed.
    const noXmlDir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-noxml-"));
    process.env.RFC_MCP_DATA_DIR = noXmlDir;
    const noXml = RfcService.create(loadConfig(), createLogger({ level: "silent" }), {
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/api/v1/rfc-common/9999.json": () => ({
          body: JSON.stringify({ ...COMMON_METADATA, formats: [{ format: "txt" }, { format: "html" }] }),
          etag: '"common-9999-noxml"',
          type: "application/json",
        }),
      }),
    });
    const resolved = await noXml.resolve({ rfc: 9999, with_xml: true });
    expect(resolved.warnings).not.toContain("xml_unavailable:NOT_FOUND");
    let thrown: { code?: string; message?: string } | null = null;
    try {
      await noXml.read({ snapshot_id: resolved.data.snapshot.id, target: "xml_outline" });
    } catch (error) {
      thrown = error as { code?: string; message?: string };
    }
    expect(thrown?.code).toBe("NOT_FOUND");
    expect(thrown?.message).toMatch(/no RFCXML/iu);
    expect(thrown?.message).not.toMatch(/with_xml/u);
    rmSync(noXmlDir, { recursive: true, force: true });
  });

  it("restricts a text search to blocks citing a reference of one relation", async () => {
    await service.resolve({ rfc: 9999 });

    // The fixture cites [RFC2119] normatively in section 1. `relation:` is part of the
    // query grammar, not a tool argument.
    const normative = await service.search({ query: "interpreted relation:normative", scope: "text" });
    expect(normative.data.total).toBeGreaterThan(0);
    for (const hit of normative.data.hits as readonly { section_path: readonly string[] }[]) {
      expect(hit.section_path).toContain("1");
    }

    // A block that cites nothing must not appear.
    const informative = await service.search({ query: "interpreted relation:informative", scope: "text" });
    expect(informative.data.total).toBe(0);
    expect(normative.next_cursor).toBeNull();

    // The filter is honoured, so it must no longer be reported as unappliable.
    expect(normative.warnings).not.toContain("filters_not_applied_to_text:relation");
  });

  it("rejects an unsupported relation filter value", async () => {
    await expect(service.search({ query: "interpreted relation:sideways", scope: "text" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a field filter with no value instead of searching for the word", async () => {
    // `status:` is a malformed filter. Treating it as free text would silently answer
    // a different question than the one asked.
    for (const field of ["rfc", "section", "keyword", "status", "stream", "author", "relation", "term"]) {
      await expect(service.search({ query: `MUST ${field}:`, scope: "text" })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    // A non-field token that merely contains a colon is still ordinary text.
    await expect(service.search({ query: "MUST urn:example", scope: "text" })).resolves.toBeDefined();
  });

  it("applies catalog facets to a catalog search and reports inapplicable ones", async () => {
    await service.resolve({ rfc: 9999 });
    const all = await service.search({ query: "fixture", scope: "catalog" });
    expect(all.data.total).toBeGreaterThan(0);

    // status:/stream: are facets of the catalog and must narrow the result set.
    const byStream = await service.search({ query: "fixture stream:IETF", scope: "catalog" });
    expect(byStream.data.total).toBeGreaterThan(0);
    const wrongStream = await service.search({ query: "fixture stream:3GPP", scope: "catalog" });
    expect(wrongStream.data.total).toBe(0);
    const byStatus = await service.search({ query: "fixture status:std", scope: "catalog" });
    expect(byStatus.data.total).toBeGreaterThan(0);
    const wrongStatus = await service.search({ query: "fixture status:bogus", scope: "catalog" });
    expect(wrongStatus.data.total).toBe(0);

    // rfc: narrows the catalog too.
    const byRfc = await service.search({ query: "fixture rfc:9999", scope: "catalog" });
    expect(byRfc.data.total).toBe(1);
    const wrongRfc = await service.search({ query: "fixture rfc:9998", scope: "catalog" });
    expect(wrongRfc.data.total).toBe(0);

    // section: cannot apply to a catalog title search, and that is reported.
    const sectionScoped = await service.search({ query: "fixture section:2", scope: "catalog" });
    expect(sectionScoped.warnings).toContain("filters_not_applied_to_catalog:section");

    // status:/stream: are catalog facets, so a text search cannot honour them and says so.
    const textScoped = await service.search({ query: '"X-Trace" status:std', scope: "text" });
    expect(textScoped.warnings).toContain("filters_not_applied_to_text:status");

    // A facet-only query is answered from the catalog instead of failing.
    const facetsOnly = await service.search({ query: "status:std stream:IETF", scope: "text" });
    expect(facetsOnly.status).toBe("ok");
    expect(facetsOnly.data.scope).toBe("catalog");
    expect(facetsOnly.warnings).toContain("catalog_facets_only_scope_relaxed_to_catalog");
    expect(facetsOnly.data.hits.length).toBeGreaterThan(0);
  });

  it("applies a block kind filter to a text search", async () => {
    await service.resolve({ rfc: 9999 });
    const paragraphs = await service.search({ query: '"X-Trace"', scope: "text", block_kinds: ["paragraph"] });
    expect(paragraphs.data.total).toBeGreaterThan(0);
    const headings = await service.search({ query: '"X-Trace"', scope: "text", block_kinds: ["heading"] });
    expect(headings.data.total).toBe(0);
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

  it("hands out the section content free of printing artefacts, and the exact slice beside it", async () => {
    // `text` used to be the verbatim slice, so on a pre-1990 RFC the field a caller
    // would copy from carried the printed page's running head and a raw form feed.
    // Five review rounds reported that. The safe rendering now takes the plain name
    // and the byte-exact one takes the explicit name; nothing is dropped.
    // The furniture has to be *inside* the section, between two content lines: a
    // section's span starts at its first content line, so furniture before it is
    // already outside the verbatim slice.
    const printed = RFC_TEXT.replace(
      "   An implementation MUST emit the X-Trace header.",
      "   An implementation MUST emit the X-Trace header.\n\nMockapetris                                                    [Page 1]\n\f\nRFC 9999        Example Document                            January 2026\n",
    );
    const printedService = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({
          body: printed,
          etag: '"printed-9999"',
          type: "text/plain",
        }),
      }),
    });
    const resolved = await printedService.resolve({ rfc: 9999, refresh: true });
    const read = (
      await printedService.read({
        snapshot_id: resolved.data.snapshot.id,
        section: "2",
        include: ["text", "source_map"],
      })
    ).data;
    expect(read.page_furniture_lines?.length ?? 0).toBeGreaterThan(0);
    expect(read.text).not.toMatch(/\[Page \d+\]/u);
    expect(read.text).not.toContain("\f");
    expect(read.text).toContain("MUST emit the X-Trace header");
    // The exact slice is still there, and it still carries the artefacts.
    expect(read.text_verbatim).toMatch(/\[Page \d+\]/u);
    expect(read.text_sha256_verbatim).toMatch(/^[0-9a-f]{64}$/u);
    // Equal line counts, so the two compare line for line.
    expect(read.text?.split("\n")).toHaveLength(read.text_verbatim?.split("\n").length ?? -1);
    // 0.2.0 callers reading text_clean still get the same string.
    expect(read.text_clean).toBe(read.text);
    // And the section object with a source map keeps the verbatim text.
    expect(read.section?.text).toBe(read.text_verbatim);
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

  it("names the loss counters in the contract so a low requirement count is explicable", async () => {
    // A caller reading the contract has to be able to learn that a low
    // total_requirements has a knowable cause. `coverage.keyword_bearing_blocks_skipped`
    // and the `normative_text_in_unscanned_blocks:N` warning existed on the response and
    // nowhere in the self-describing contract, so the only way to find them was to
    // already know they were there - which is the definition of a hole in the contract.
    const capabilities = await service.capabilities();
    const notes = capabilities.data.limits_notes as Record<string, string>;
    expect(notes.keywordBearingBlocksSkipped).toContain("coverage.keyword_bearing_blocks_skipped");
    expect(notes.normativeTextInUnscannedBlocks).toContain("normative_text_in_unscanned_blocks:N");

    // A warning template a contract never mentions is a warning a caller treats as
    // noise, or as a failure. Both readings are wrong and neither is recoverable.
    const rules = capabilities.data.reading_rules as string[];
    expect(rules.join("\n")).toContain("keyword_bearing_blocks_skipped");
    expect(rules.join("\n")).toContain("normative_text_in_unscanned_blocks:N");
  });

  it("documents both citation id kinds in the contract", async () => {
    const capabilities = await service.capabilities();
    const rules = (capabilities.data.reading_rules as string[]).join("\n");
    expect(rules).toContain("stable_citation_id");
    expect(rules).toContain("citation_id_kind");
    expect(rules).toContain("stale");
  });

  it("ships the candidate rows on page 1 and a located stub on every page after", async () => {
    // A document that has candidates, so the stub is a statement about rows rather than
    // about an empty list. The lower-case "must" is a candidate and not a requirement:
    // that is the whole reason the list exists.
    const withCandidates = RFC_TEXT.replace(
      "   A client SHOULD NOT retry a request after a 503 response.",
      "   A receiver must discard a datagram that fails the checksum.\n\n   A client SHOULD NOT retry a request after a 503 response.",
    );
    const paged = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({
          body: withCandidates,
          etag: '"txt-9999-candidates"',
          type: "text/plain",
        }),
      }),
    });
    const resolved = await paged.resolve({ rfc: 9999, refresh: true });
    const snapshotId = resolved.data.snapshot.id as string;

    const first = await paged.requirements({ snapshot_id: snapshotId, max_results: 1 });
    const firstCandidates = first.data.non_strict_candidates as Record<string, unknown>;
    expect((firstCandidates.candidates as unknown[]).length).toBeGreaterThan(0);
    // Page 1 is the page that carries them, and it says so with the same field.
    expect(firstCandidates.omitted_on_page).toBe(0);
    expect(first.next_cursor).not.toBeNull();

    const second = await paged.requirements({
      snapshot_id: snapshotId,
      max_results: 1,
      cursor: first.next_cursor!,
    });
    const stub = second.data.non_strict_candidates as Record<string, unknown>;
    // The rows are gone and nothing says where they went unless the stub says it, so the
    // stub is the whole point: omitted_on_page, the counts, and a way back.
    expect(stub.candidates).toEqual([]);
    expect(stub.omitted_on_page).toBe(2);
    expect(stub.total).toBe(firstCandidates.total);
    expect(stub.returned).toBe(firstCandidates.returned);
    for (const key of ["by_keyword_case", "by_shape", "by_role", "by_reason"]) {
      expect(stub[key], key).toEqual(firstCandidates[key]);
    }
    expect(stub.sentence_fragments).toBe(firstCandidates.sentence_fragments);
    expect(String(stub.note)).toContain("page 1");
    expect(String(stub.note)).toContain("no cursor");
    // A caller that pages and finds no candidates can tell "there are none" from "they
    // were on the page before", and the warning says the same thing outside the object.
    expect(stub.total).toBeGreaterThan(0);
    expect(second.warnings.join(" ")).toContain("non_strict_candidate_rows_omitted_on_page_2");

    // And the bytes actually went down, which is the measurement the change was made for.
    expect(JSON.stringify(second.data).length).toBeLessThan(JSON.stringify(first.data).length);
  });

  it("keeps the candidate rows reachable again by dropping the cursor", async () => {
    const withCandidates = RFC_TEXT.replace(
      "   A client SHOULD NOT retry a request after a 503 response.",
      "   A receiver must discard a datagram that fails the checksum.\n\n   A client SHOULD NOT retry a request after a 503 response.",
    );
    const paged = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({
          body: withCandidates,
          etag: '"txt-9999-candidates-2"',
          type: "text/plain",
        }),
      }),
    });
    const resolved = await paged.resolve({ rfc: 9999, refresh: true });
    const snapshotId = resolved.data.snapshot.id as string;
    const page2 = await paged.requirements({ snapshot_id: snapshotId, max_results: 1 });
    const again = await paged.requirements({
      snapshot_id: snapshotId,
      max_results: 1,
      cursor: (await paged.requirements({ snapshot_id: snapshotId, max_results: 1 })).next_cursor!,
    });
    expect((again.data.non_strict_candidates as Record<string, unknown>).candidates).toEqual([]);
    const back = await paged.requirements({ snapshot_id: snapshotId, max_results: 1 });
    expect((back.data.non_strict_candidates as Record<string, unknown>).candidates).toEqual(
      (page2.data.non_strict_candidates as Record<string, unknown>).candidates,
    );
  });

  it("carries a stable_citation_id on every requirement and candidate it returns", async () => {
    const withCandidates = RFC_TEXT.replace(
      "   A client SHOULD NOT retry a request after a 503 response.",
      "   A receiver must discard a datagram that fails the checksum.\n\n   A client SHOULD NOT retry a request after a 503 response.",
    );
    const cited = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({
          body: withCandidates,
          etag: '"txt-9999-candidates-3"',
          type: "text/plain",
        }),
      }),
    });
    const resolved = await cited.resolve({ rfc: 9999, refresh: true });
    const page = await cited.requirements({ snapshot_id: resolved.data.snapshot.id });
    const requirements = page.data.requirements as readonly { stable_citation_id: string }[];
    expect(requirements.length).toBeGreaterThan(0);
    for (const requirement of requirements) expect(requirement.stable_citation_id).toMatch(/^scit_[0-9a-f]{24}$/u);
    const candidates = (page.data.non_strict_candidates as { candidates: readonly { stable_citation_id: string }[] })
      .candidates;
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) expect(candidate.stable_citation_id).toMatch(/^scit_[0-9a-f]{24}$/u);
  });

  /* ---------------------------------------------------------------------- */
  /* coverage.completeness: the verdict a caller can branch on              */
  /* ---------------------------------------------------------------------- */

  /** `key:value` pairs, in the order the response emits them. */
  function basis(coverage: Record<string, unknown>): Map<string, string> {
    const out = new Map<string, string>();
    for (const pair of String(coverage.completeness_basis).split(" ")) {
      const index = pair.indexOf(":");
      out.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return out;
  }

  function coverageOf(data: Record<string, unknown>): Record<string, unknown> {
    return data.coverage as Record<string, unknown>;
  }

  /** A service serving one document from one text, over the fixture's store. */
  function serving(text: string, etag: string, metadata: Record<string, unknown> = cleanMetadata()): RfcService {
    return RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/api/v1/rfc-common/9999.json": () => ({
          body: JSON.stringify(metadata),
          type: "application/json",
        }),
        "https://www.rfc-editor.org/rfc/rfc9999.txt": () => ({ body: text, etag, type: "text/plain" }),
      }),
    });
  }

  it("answers whether the count may be read as the document's normative content", async () => {
    // The field this whole exercise is for. A caller writing a compliance contract wants to
    // assert something about total_requirements, and before this the only thing on the
    // response to assert on was a number and a list of warnings.
    const clean = serving(CLEAN_TEXT, '"clean"');
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const coverage = coverageOf((await clean.requirements({ snapshot_id: resolved.data.snapshot.id })).data);

    expect(coverage.completeness).toBe("complete");
    // A complete verdict names no reasons, and the reasons are the warning keys, so an
    // empty list here is the assertion that nothing contributed.
    expect(coverage.completeness_warnings).toEqual([]);
    // The basis is falsifiable by changing the document: every value is a number or a name.
    const facts = basis(coverage);
    expect(facts.get("scope")).toBe("document");
    expect(Number(facts.get("prose_blocks"))).toBeGreaterThan(0);
    expect(Number(facts.get("scanned"))).toBe(Number(facts.get("prose_blocks")) - Number(facts.get("skipped")));
    expect(facts.get("may_hold_normative")).toBe("0");
    expect(facts.get("keyword_bearing_skipped")).toBe("0");
    expect(facts.get("fragment_rows")).toBe("0");
    expect(facts.get("total_requirements")).toBe("2");
    expect(facts.get("keyword_usage")).toBe("absent");
  });

  it("flips the verdict to partial when one block the extractor refuses to read is added", async () => {
    // The same document plus a pipe table. Nothing else changes, so the verdict can only
    // have moved because of the block the extractor will not read on its kind alone.
    const tabulated = serving(CLEAN_TEXT.replace("\n1.  Requirements", `${PIPE_TABLE}\n1.  Requirements`), '"tabbed"');
    const resolved = await tabulated.resolve({ rfc: 9999, refresh: true });
    const response = await tabulated.requirements({ snapshot_id: resolved.data.snapshot.id });
    const coverage = coverageOf(response.data);

    expect(coverage.completeness).toBe("partial");
    expect(coverage.completeness_warnings).toContain("unscanned_blocks_may_contain_normative_text");
    expect(basis(coverage).get("may_hold_normative")).toBe("1");
    // The table carries no keyword, so the keyword counter is blind to it. That is the
    // whole reason the verdict is not derived from keyword_bearing_blocks_skipped alone:
    // a specification that states its rules in a table has no keyword to count.
    expect(coverage.keyword_bearing_blocks_skipped).toBe(0);
    expect(coverage.may_contain_normative_blocks_skipped).toBe(1);
  });

  it("puts every reason in the response's own warnings, so the two cannot drift", async () => {
    const fragmented = serving(
      CLEAN_TEXT.replace("\n1.  Requirements", `${PIPE_TABLE_WITH_MODAL}\n1.  Requirements`) + PAGE_BREAK_FRAGMENT,
      '"fragmented"',
    );
    const resolved = await fragmented.resolve({ rfc: 9999, refresh: true });
    const response = await fragmented.requirements({ snapshot_id: resolved.data.snapshot.id });
    const coverage = coverageOf(response.data);
    const keys = new Set(response.warnings.map((warning) => warning.split(":")[0]!));

    expect(coverage.completeness).toBe("partial");
    const reasons = coverage.completeness_warnings as string[];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(keys, reason).toContain(reason);
    // A caller that sees partial can find the why in one place, and every reason here is
    // also a reason the response raised.
    expect(reasons).toContain("unscanned_blocks_may_contain_normative_text");
    expect(reasons).toContain("normative_text_in_unscanned_blocks");
  });

  it("does not change the verdict when the caller suppresses the candidate lists", async () => {
    // A verdict that moved with include_candidates would be a verdict about the request,
    // not about the document, and two callers would get two different answers about the
    // same RFC.
    const clean = serving(CLEAN_TEXT, '"clean-independent"');
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const withCandidates = coverageOf((await clean.requirements({ snapshot_id: resolved.data.snapshot.id })).data);
    const without = coverageOf(
      (await clean.requirements({ snapshot_id: resolved.data.snapshot.id, include_candidates: false })).data,
    );

    expect(["complete", "partial", "unknown"]).toContain(withCandidates.completeness);
    expect(without.completeness).toBe(withCandidates.completeness);
    expect(without.completeness_basis).toBe(withCandidates.completeness_basis);
  });

  it("reports unknown when the counters that would answer the question were never recorded", async () => {
    // `unknown` has to be reachable, because a verdict that is always one of two values is
    // not a verdict. This is the real state it describes: a corpus derived before the loss
    // counters were recorded reports zeros, and a caller reading those zeros as "nothing
    // was skipped" would be reading an absence of measurement as a measurement of absence.
    const clean = serving(CLEAN_TEXT, '"clean-unknown"');
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const database = (clean.storeRef as unknown as { db: { prepare: (s: string) => { run: (a: unknown) => unknown } } })
      .db;
    database.prepare("UPDATE snapshots SET prose_block_count = 0 WHERE id = ?").run(resolved.data.snapshot.id);

    const response = await clean.requirements({ snapshot_id: resolved.data.snapshot.id });
    const coverage = coverageOf(response.data);
    expect(coverage.completeness).toBe("unknown");
    expect(coverage.completeness_warnings).toEqual(["coverage_counters_not_reconcilable"]);
    expect(basis(coverage).get("scanned")).toBe("0");
    expect(response.warnings).toContain("coverage_counters_not_reconcilable");
  });

  it("will not call a zero complete without a keyword-usage notice to explain it", async () => {
    // The certificate of absence. RFC 2328 reports total_requirements 0 and, before this,
    // keyword_bearing_blocks_skipped 0 - a test asserting both read as "OSPF states no
    // requirements and I checked". The document is not about the requirement language at
    // all, and the tool has no way to know that unless the document says so.
    const noLanguage = serving(
      CLEAN_TEXT.replace(
        "An implementation MUST emit the X-Trace header.",
        "The port number identifies the endpoint.",
      ).replace("A server MAY log the attempt.", "The server may log the attempt."),
      '"no-language"',
    );
    const resolved = await noLanguage.resolve({ rfc: 9999, refresh: true });
    const response = await noLanguage.requirements({ snapshot_id: resolved.data.snapshot.id });
    const coverage = coverageOf(response.data);

    expect(coverage.total_requirements).toBe(0);
    expect(coverage.keyword_usage).toBeUndefined();
    expect(coverage.completeness).toBe("partial");
    expect(coverage.completeness_warnings).toContain("zero_requirements_without_a_keyword_usage_notice");
    expect(basis(coverage).get("keyword_usage")).toBe("absent");
  });

  /* ---------------------------------------------------------------------- */
  /* one keyword predicate, and the keyword-free channel                    */
  /* ---------------------------------------------------------------------- */

  it("counts a skipped block that holds a lower-case keyword", async () => {
    // The counter tested an upper-case probe while the candidate pass selected its blocks
    // with a case-insensitive LIKE, so a body block holding only a lower-case modal was
    // dropped by one pass, uncounted by the other, and raised no warning.
    const tabulated = serving(
      CLEAN_TEXT.replace("\n1.  Requirements", `${PIPE_TABLE_WITH_MODAL}\n1.  Requirements`),
      '"lower-case-modal"',
    );
    const resolved = await tabulated.resolve({ rfc: 9999, refresh: true });
    const response = await tabulated.requirements({ snapshot_id: resolved.data.snapshot.id });
    const coverage = coverageOf(response.data);

    expect(coverage.keyword_bearing_blocks_skipped).toBe(1);
    expect(response.warnings.some((warning) => warning.startsWith("normative_text_in_unscanned_blocks:1"))).toBe(true);
    expect(coverage.completeness_warnings).toContain("normative_text_in_unscanned_blocks");
  });

  it("reaches a specification stated with no keyword, and keeps it out of the count", async () => {
    // RFC 8174 section 2: a lot of normative text uses no keyword and is still normative.
    // The pass existed, was tested, and could not be called through the service, because
    // the service handed it only the blocks a keyword appears in.
    const clean = serving(CLEAN_TEXT, '"clean-declarative"');
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const response = await clean.requirements({ snapshot_id: resolved.data.snapshot.id });
    const candidates = response.data.non_strict_candidates as {
      declarative_specifications: readonly {
        exact_text: string;
        basis: string;
        section: string | null;
        stable_citation_id: string;
        citation_id: string;
      }[];
      declarative_total: number;
    };
    const coverage = coverageOf(response.data);

    const row = candidates.declarative_specifications.find((entry) => entry.exact_text.includes("512 octets"));
    expect(row?.exact_text).toBe("The maximum total length of a command line is 512 octets.");
    expect(row?.basis).toBe("numeric-bound");
    expect(row?.section).toBe("1");
    // A sentence a contract quotes has to be checkable after the next parser bump.
    expect(row?.stable_citation_id).toMatch(/^scit_[0-9a-f]{24}$/u);
    // And it is not a requirement: it never enters the count or the list.
    expect(coverage.declarative_specifications).toBe(candidates.declarative_total);
    expect(coverage.total_requirements).toBe(2);
    expect((response.data.requirements as readonly { exact_text: string }[]).map((r) => r.exact_text)).not.toContain(
      row?.exact_text,
    );
  });

  it("names a keyword-free warning for the pass that produced it", async () => {
    // Every keyword-free warning is called `declarative_…` by the extractor, and prefixing
    // the whole array with `candidates:` arrived as `candidates:declarative_…` - a lie about
    // which pass counted it. The sentence below is dropped as a cross-reference by BOTH
    // passes, so the internal one (over the keyword blocks) emits the warning too and the
    // mislabelled string is reachable.
    const clean = serving(
      CLEAN_TEXT.replace(
        "The maximum total length of a command line is 512 octets.",
        "The maximum total length of a command line is 512 octets.\n\nA client MUST retry.  See Section 1 for the minimum of 64 octets.",
      ) +
        `
2.  Notes

   o  A list item is not a statement, whatever it bounds.
`,
      "clean-warning-prefix",
    );
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const response = await clean.requirements({ snapshot_id: resolved.data.snapshot.id });

    expect(response.warnings.some((warning) => warning.startsWith("declarative_"))).toBe(true);
    expect(response.warnings.some((warning) => warning.startsWith("candidates:declarative_"))).toBe(false);
    // And the candidate channel keeps its own prefix, so the two are still separable.
    const candidateWarnings = response.warnings.filter((warning) => warning.startsWith("candidates:"));
    for (const warning of candidateWarnings) {
      expect(warning.split(":")[1]?.startsWith("declarative_"), warning).toBe(false);
    }
  });

  it("caps declarative_limit, reports the clamp, and lets the cap truncate", async () => {
    // Same shape as the max_results clamp: a clamp that is not reported is
    // indistinguishable from a smaller corpus.
    expect(RequirementsInputSchema.safeParse({ declarative_limit: 10 }).success).toBe(true);
    expect(RequirementsInputSchema.safeParse({ declarative_limit: 5000 }).success).toBe(false);

    // Two keyword-free sentences in the body, so a limit of 1 has something to lose.
    const two = serving(
      CLEAN_TEXT.replace(
        "The maximum total length of a command line is 512 octets.",
        "The maximum total length of a command line is 512 octets.\n\nThe minimum length of a reply line is 64 octets.",
      ),
      '"clean-limit"',
    );
    const resolved = await two.resolve({ rfc: 9999, refresh: true });
    const clamped = await two.requirements({ snapshot_id: resolved.data.snapshot.id, declarative_limit: 5000 });
    expect(clamped.warnings).toContain("declarative_limit_clamped:5000->2000:declarative_limit_accepts_up_to_2000");
    expect(clamped.limits.applied).toMatchObject({ declarative_limit: 2000 });

    const capped = await two.requirements({ snapshot_id: resolved.data.snapshot.id, declarative_limit: 1 });
    const candidates = capped.data.non_strict_candidates as {
      declarative_truncated: boolean;
      declarative_specifications: readonly { exact_text: string }[];
    };
    expect(candidates.declarative_specifications).toHaveLength(1);
    expect(candidates.declarative_truncated).toBe(true);
    expect(capped.warnings.some((warning) => warning.startsWith("declarative_specifications_truncated_at_1"))).toBe(
      true,
    );
  });

  it("omits the keyword-free rows on later pages and says which page has them", async () => {
    const clean = serving(CLEAN_TEXT, '"clean-declarative-paging"');
    const resolved = await clean.resolve({ rfc: 9999, refresh: true });
    const first = await clean.requirements({ snapshot_id: resolved.data.snapshot.id, max_results: 1 });
    const firstCandidates = first.data.non_strict_candidates as Record<string, unknown>;
    expect((firstCandidates.declarative_specifications as unknown[]).length).toBeGreaterThan(0);
    expect(firstCandidates.declarative_omitted_on_page).toBe(0);

    const second = await clean.requirements({
      snapshot_id: resolved.data.snapshot.id,
      max_results: 1,
      cursor: first.next_cursor!,
    });
    const stub = second.data.non_strict_candidates as Record<string, unknown>;
    expect(stub.declarative_specifications).toEqual([]);
    expect(stub.declarative_omitted_on_page).toBe(2);
    // The counts still describe the whole document, so a caller paging does not get a
    // different answer, only the same answer without the bytes.
    expect(stub.declarative_total).toBe(firstCandidates.declarative_total);
  });

  /* ---------------------------------------------------------------------- */
  /* diff: an empty answer is not a finding                                   */
  /* ---------------------------------------------------------------------- */

  /** A second document over the same store, for the two-sided calls. */
  function secondDocument(text: string, etag: string, number: number): RfcService {
    return RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        [`https://www.rfc-editor.org/api/v1/rfc-common/${number}.json`]: () => ({
          body: JSON.stringify(cleanMetadata({ number, title: `Second fixture ${number}`, obsoletes: [] })),
          type: "application/json",
        }),
        [`https://www.rfc-editor.org/rfc/rfc${number}.txt`]: () => ({ body: text, etag, type: "text/plain" }),
      }),
    });
  }

  it("reports a diff between two empty extractions as unanswered, not as agreement", async () => {
    // The most dangerous response in the scenario walkthrough: RFC 2178 is the 1991 OSPF
    // draft and RFC 2328 the 1998 Internet Standard, both extract to zero requirements, and
    // the diff returned changes: [], summary: {}, truncated: false, status: "ok" and no
    // warnings - a shape a routing engineer cannot tell from "nothing changed".
    const keywordless = CLEAN_TEXT.replace(
      "An implementation MUST emit the X-Trace header.",
      "The X-Trace header carries the request id.",
    ).replace("A server MAY log the attempt.", "The server may log the attempt.");
    const left = serving(keywordless, '"left-empty"');
    const right = secondDocument(keywordless, '"right-empty"', 9998);
    const leftSnapshot = (await left.resolve({ rfc: 9999, refresh: true })).data.snapshot.id;
    const rightSnapshot = (await right.resolve({ rfc: 9998 })).data.snapshot.id;

    const leftCoverage = coverageOf((await left.requirements({ snapshot_id: leftSnapshot })).data);
    const rightCoverage = coverageOf((await right.requirements({ snapshot_id: rightSnapshot })).data);
    // The precondition, stated as a fact rather than assumed: both sides extract nothing.
    expect(leftCoverage.total_requirements).toBe(0);
    expect(rightCoverage.total_requirements).toBe(0);

    const response = await left.diff({
      left: { snapshot_id: leftSnapshot },
      right: { snapshot_id: rightSnapshot },
      mode: "requirements",
    });
    const coverage = response.data.coverage!;

    expect(coverage.items).toEqual({ left: 0, right: 0 });
    expect(coverage.verdict).toBe("unanswered");
    expect(coverage.reason).toBe("neither_side_contributed");
    expect(coverage.clean).toBe(false);
    // `status: "ok"` is itself an assertion, so an unanswered diff is not ok.
    expect(response.status).toBe("partial");
    expect(response.warnings).toContain("diff_unanswered:neither_side_contributed:requirements_mode");
    expect(coverage.note).toContain("unanswered question");
  });

  it("still reports a diff that ran as a comparison, and clean when both sides are complete", async () => {
    const left = serving(CLEAN_TEXT, '"left-clean"');
    const right = secondDocument(
      CLEAN_TEXT.replace("MUST emit the X-Trace header", "SHOULD emit the X-Trace header"),
      '"right-clean"',
      9998,
    );
    const leftSnapshot = (await left.resolve({ rfc: 9999, refresh: true })).data.snapshot.id;
    const rightSnapshot = (await right.resolve({ rfc: 9998 })).data.snapshot.id;

    const response = await left.diff({
      left: { snapshot_id: leftSnapshot },
      right: { snapshot_id: rightSnapshot },
      mode: "requirements",
    });
    const coverage = response.data.coverage!;

    expect(coverage.verdict).toBe("differences");
    expect(coverage.reason).toBe("both_sides_contributed");
    expect(coverage.items).toEqual({ left: 2, right: 2 });
    expect(coverage.left.completeness).toBe("complete");
    expect(coverage.right.completeness).toBe("complete");
    expect(coverage.clean).toBe(true);
    expect(response.status).toBe("ok");
    expect((response.data.changes as readonly { kind: string }[]).map((change) => change.kind)).toContain(
      "modality_changed",
    );
  });

  it("marks a comparison between two incomplete sides as not clean", async () => {
    // `clean` is a different question from `verdict`: the comparison ran, and its result is
    // still not the whole answer.
    const left = serving(CLEAN_TEXT.replace("\n1.  Requirements", `${PIPE_TABLE}\n1.  Requirements`), '"left-lossy"');
    const right = secondDocument(
      CLEAN_TEXT.replace("\n1.  Requirements", `${PIPE_TABLE}\n1.  Requirements`).replace(
        "MUST emit the X-Trace header",
        "SHOULD emit the X-Trace header",
      ),
      '"right-lossy"',
      9998,
    );
    const leftSnapshot = (await left.resolve({ rfc: 9999, refresh: true })).data.snapshot.id;
    const rightSnapshot = (await right.resolve({ rfc: 9998 })).data.snapshot.id;
    const response = await left.diff({
      left: { snapshot_id: leftSnapshot },
      right: { snapshot_id: rightSnapshot },
      mode: "requirements",
    });
    const coverage = response.data.coverage!;

    expect(coverage.verdict).toBe("differences");
    expect(coverage.left.completeness).toBe("partial");
    expect(coverage.clean).toBe(false);
    expect(response.status).toBe("ok");
  });

  it("says when mode text did not run a line diff instead of returning section renames", async () => {
    // The underlying pass gives up on documents over a per-side line ceiling and returns
    // the structural diff under a `text` label, and the note that says so is written into
    // a local array `DiffResult` has no field for. The service detects the fallback from the
    // response it got: in text mode a line diff produces `text_hunk` and nothing else.
    const left = serving(longText(1_100), '"long-left"');
    const right = secondDocument(longText(1_100, "\n2.  Extra\n\nAn extra section.\n"), '"long-right"', 9998);
    const leftSnapshot = (await left.resolve({ rfc: 9999, refresh: true })).data.snapshot.id;
    const rightSnapshot = (await right.resolve({ rfc: 9998 })).data.snapshot.id;

    const response = await left.diff({
      left: { snapshot_id: leftSnapshot },
      right: { snapshot_id: rightSnapshot },
      mode: "text",
      max_changes: 500,
    });
    const coverage = response.data.coverage!;
    const kinds = (response.data.changes as readonly { kind: string }[]).map((change) => change.kind);

    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind.startsWith("section_"))).toBe(true);
    expect(coverage.verdict).toBe("unanswered");
    expect(coverage.reason).toBe("mode_fell_back_to_structure");
    expect(response.status).toBe("partial");
    expect(response.warnings).toContain("diff_unanswered:mode_fell_back_to_structure:text_mode");
    expect(coverage.note).toContain("did NOT run");
  });

  it("reports line hunks when the line diff does run", async () => {
    // The control for the detection above: a verdict that is always `unanswered` is not a
    // verdict either.
    const left = serving(CLEAN_TEXT, '"short-left"');
    const right = secondDocument(
      CLEAN_TEXT.replace(
        "The maximum total length of a command line is 512 octets.",
        "The maximum total length of a command line is 256 octets.",
      ),
      '"short-right"',
      9998,
    );
    const leftSnapshot = (await left.resolve({ rfc: 9999, refresh: true })).data.snapshot.id;
    const rightSnapshot = (await right.resolve({ rfc: 9998 })).data.snapshot.id;
    const response = await left.diff({
      left: { snapshot_id: leftSnapshot },
      right: { snapshot_id: rightSnapshot },
      mode: "text",
    });
    const coverage = response.data.coverage!;

    expect(coverage.reason).toBe("both_sides_contributed");
    expect(coverage.verdict).toBe("differences");
    expect((response.data.changes as readonly { kind: string }[]).map((change) => change.kind)).toContain("text_hunk");
    expect(response.status).toBe("ok");
  });

  /* ---------------------------------------------------------------------- */
  /* search: which scope, and what a zero is a zero of                       */
  /* ---------------------------------------------------------------------- */

  /** Two catalog entries, one ingested: the state every coverage claim is about. */
  async function partialCorpus(): Promise<RfcService> {
    const syncer = RfcService.create(config, createLogger({ level: "silent" }), {
      store: service.storeRef,
      fetchImpl: makeFetch({
        "https://www.rfc-editor.org/api/v1/rfc-mini-index.json": () => ({
          body: JSON.stringify({
            miniIndex: [
              { number: 9999, title: "Test Document For The Fixture Suite", formats: [{ format: "txt" }] },
              { number: 9998, title: "Other fixture", formats: [{ format: "txt" }] },
            ],
          }),
          type: "application/json",
        }),
      }),
    });
    await syncer.syncIndex();
    await service.resolve({ rfc: 9999 });
    return syncer;
  }

  it("names every scope the call consulted, not only the one it answered from", async () => {
    await partialCorpus();
    const response = await service.search({ query: "zzqq nonexistent protocol foobarbaz" });
    const corpus = response.data.corpus as {
      coverage: string;
      scopes: readonly { scope: string; documents: number }[];
    };

    // auto searched the catalog over both entries first and the text index second, and the
    // old coverage string named only the second, so a caller concluded the search was
    // narrower than it was - the opposite of the truth.
    expect(response.data.scope).toBe("text");
    expect(corpus.scopes.map((entry) => entry.scope)).toEqual(["catalog", "text"]);
    expect(corpus.scopes[0]?.documents).toBe(2);
    expect(corpus.scopes[1]?.documents).toBe(1);
    expect(corpus.coverage).toContain("catalog_titles_and_abstracts:2/2");
    expect(corpus.coverage).toContain("ingested_text_only:1/2");
  });

  it("separates no such thing from not in what you have", async () => {
    await partialCorpus();

    // The document is not loaded, so the zero says nothing about it.
    const notIngested = await service.search({ query: '"X-Trace" rfc:9998', scope: "text" });
    expect(notIngested.data.total).toBe(0);
    expect(notIngested.data.miss?.consultable).toBe(false);
    expect(notIngested.data.miss?.reason).toBe("named_documents_not_ingested");
    expect(notIngested.data.miss?.named_rfcs_ingested).toEqual([]);

    // The document is loaded and was searched in full, so the zero is a statement about it.
    const ingested = await service.search({ query: '"nonexistent-phrase-xyzzy" rfc:9999', scope: "text" });
    expect(ingested.data.total).toBe(0);
    expect(ingested.data.miss?.consultable).toBe(true);
    expect(ingested.data.miss?.reason).toBe("named_documents_searched");
    expect(ingested.data.miss?.named_rfcs_ingested).toEqual([9999]);
    expect(ingested.data.miss?.remedy).not.toContain("resolve 9999");

    // No document named: a corpus gap, with the size of the gap as a number.
    const open = await service.search({ query: "zzqq nonexistent protocol foobarbaz" });
    expect(open.data.miss?.consultable).toBe(false);
    expect(open.data.miss?.reason).toBe("documents_not_ingested");
    expect(open.data.miss?.catalog_documents_without_text).toBe(1);
  });

  it("carries no miss on a search that found something", async () => {
    await partialCorpus();
    const response = await service.search({ query: "fixture", scope: "catalog" });
    expect(response.data.total).toBeGreaterThan(0);
    expect(response.data.miss).toBeUndefined();
  });

  it("documents the verdict, the diff coverage and the miss in the contract", async () => {
    // A field that is not in the self-describing contract is a hole in it: the only way to
    // find `completeness` was to already know it was there.
    const capabilities = await service.capabilities();
    const rules = (capabilities.data.reading_rules as string[]).join("\n");
    expect(rules).toContain("coverage.completeness");
    expect(rules).toContain("completeness_basis");
    expect(rules).toContain("completeness_warnings");
    expect(rules).toContain("miss.consultable");
    expect(rules).toContain("corpus.scopes");
    expect(rules).toContain("diff.coverage");
    expect(rules).toContain("declarative_specifications");
    const grammar = capabilities.data.search_grammar as { coverage: Record<string, string> };
    expect(grammar.coverage.reported).toContain("corpus.scopes");
  });

  afterEach(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
