import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, type AppConfig } from "../src/core/config.js";
import { createLogger } from "../src/core/logger.js";
import { RfcService } from "../src/service/rfcService.js";
import { SearchInputSchema, describeIssues } from "../src/service/inputSchemas.js";

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
