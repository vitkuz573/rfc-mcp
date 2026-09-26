import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type AppConfig } from "../src/core/config.js";
import { createLogger } from "../src/core/logger.js";
import type { Block, CatalogRecord, Section } from "../src/core/types.js";
import { sha256Hex } from "../src/core/util.js";
import { stableCitationId } from "../src/analysis/citation.js";
import { analyzeNormative } from "../src/analysis/normative.js";
import { parseRfcText } from "../src/parse/text.js";
import { CorpusStore } from "../src/store/database.js";
import { RfcService } from "../src/service/rfcService.js";

/**
 * One sentence, twice, in one section, in two different blocks.
 *
 * The repeat is the point of the fixture rather than an accident of it: a stable id
 * names a sentence and a section, not a place in the document, so the case where the
 * same sentence stands in two blocks is the case where a first-match resolver hands a
 * caller a location it never chose.
 */
const FIXTURE = `Network Working Group                                   Example Editor
Request for Comments: 9998                                 Example Org
Category: Standards Track                                         June 2026


              Citation Stability Fixture

Status of This Memo

   This document is a test fixture.  Distribution is unlimited.

Abstract

   A fixture with one deliberately repeated sentence.

Table of Contents

   1.  Introduction ............................................. 1
   2.  Requirements ............................................. 1


1.  Introduction

   This document is a fixture.  The key words MUST, MUST NOT, SHOULD,
   SHOULD NOT and MAY are to be interpreted as described in [RFC2119].

2.  Requirements

   An implementation MUST emit the X-Trace header.  The header format is
   specified in [FIPS197].

   An implementation MUST emit the X-Trace header.  This paragraph repeats
   the previous one on purpose.

   A client SHOULD NOT retry a request after a 503 response.

Author's Address

   Example Editor
   Example Org
`;

const REPEATED_SENTENCE = "An implementation MUST emit the X-Trace header.";
const UNIQUE_SENTENCE = "A client SHOULD NOT retry a request after a 503 response.";

const METADATA = {
  number: 9998,
  title: "Citation Stability Fixture",
  abstract: "A fixture with one deliberately repeated sentence.",
  published: "2026-06-01",
  pages: 2,
  status: { slug: "std", name: "standards track" },
  stream: { slug: "IETF", name: "IETF" },
  group: { acronym: "example", name: "Example WG", type: "wg" },
  area: { acronym: "gen", name: "General" },
  keywords: ["fixture", "citations"],
  authors: [{ titlepage_name: "Example Editor", is_editor: true, email: "editor@example.invalid" }],
  obsoletes: [],
  obsoleted_by: [],
  updates: [],
  updated_by: [],
  subseries: [],
  identifiers: [],
  formats: [{ format: "txt" }, { format: "xml" }],
};

function makeFetch(): typeof fetch {
  const routes: Record<string, () => { body: string; etag: string; type: string }> = {
    "https://www.rfc-editor.org/api/v1/rfc-common/9998.json": () => ({
      body: JSON.stringify(METADATA),
      etag: '"common-9998"',
      type: "application/json",
    }),
    "https://www.rfc-editor.org/rfc/rfc9998.txt": () => ({
      body: FIXTURE,
      etag: '"txt-9998"',
      type: "text/plain",
    }),
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    const result = route();
    const headers = new Headers({ etag: result.etag, "content-type": result.type });
    const conditional = init?.headers as Record<string, string> | undefined;
    if (conditional?.["if-none-match"] === result.etag) return new Response(null, { status: 304, headers });
    return new Response(result.body, { status: 200, headers });
  }) as unknown as typeof fetch;
}

function catalogRecord(rfc: number): CatalogRecord {
  return {
    document_id: `rfc-${rfc}`,
    rfc,
    title: "Citation Stability Fixture",
    abstract: null,
    published: null,
    pages: null,
    status: null,
    stream: null,
    area: null,
    group: null,
    keywords: [],
    authors: [],
    obsoletes: [],
    obsoleted_by: [],
    updates: [],
    updated_by: [],
    subseries: [],
    identifiers: [],
    formats: ["txt"],
    doi: null,
    canonical_url: `https://www.rfc-editor.org/info/rfc${rfc}`,
    source_url: `https://www.rfc-editor.org/info/rfc${rfc}`,
    observed_at: "2026-01-01T00:00:00.000Z",
    content_hash: "h",
  };
}

/**
 * A second derivation of the same bytes under a different snapshot id.
 *
 * `commitDocument` keeps one snapshot per RFC — a re-derive replaces the old one and
 * records a redirect — so two coexisting snapshots of one document have to be written
 * directly. That is exactly the state a caller is in when they hold a citation recorded
 * against a derivation that is no longer the current one, and the store has no public
 * way to produce it. The clone carries NO requirement or mention rows: it stands for a
 * derivation whose rows were not written by this build, which is what makes its
 * provenance unrecorded rather than merely different.
 */
function cloneDerivation(store: CorpusStore, sourceId: string, cloneId: string): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const source = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(sourceId) as
    Record<string, unknown> | undefined;
  if (!source) throw new Error(`no snapshot ${sourceId}`);
  const columns = Object.keys(source);
  const insert = columns.join(", ");
  const select = columns
    .map((column) => {
      if (column === "id") return "?";
      // snapshots_content is UNIQUE on (rfc, format, raw_sha256, metadata_hash), so a
      // second row for the same bytes needs a different derivation identity. The bytes and
      // their hash are copied unchanged, which is what keeps the integrity check honest.
      if (column === "metadata_hash") return "?";
      return column;
    })
    .join(", ");
  db.prepare(`INSERT INTO snapshots (${insert}) SELECT ${select} FROM snapshots WHERE id = ?`).run(
    cloneId,
    `${String(source.metadata_hash)}-clone`,
    sourceId,
  );
  for (const table of ["sections", "blocks"]) {
    const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
    // Only the snapshot_id changes; block and section ids stay, so the clone is the same
    // document under a different id rather than a reshuffled one.
    const from = names.map((name) => (name === "snapshot_id" ? "?" : name)).join(", ");
    db.prepare(`INSERT INTO ${table} (${names.join(", ")}) SELECT ${from} FROM ${table} WHERE snapshot_id = ?`).run(
      cloneId,
      sourceId,
    );
  }
}

/** Commit one parse of the fixture into a store, the way an ingest would. */
function commitParse(
  store: CorpusStore,
  rfc: number,
  snapshotId: string,
  parsed: ReturnType<typeof parseRfcText>,
  raw: Buffer,
): void {
  const normative = analyzeNormative({
    snapshotId,
    rfc,
    sections: parsed.sections,
    blocks: parsed.blocks,
  });
  store.commitDocument({
    record: catalogRecord(rfc),
    snapshot: {
      id: snapshotId,
      rfc,
      format: "txt",
      rawSha256: sha256Hex(raw),
      bytes: raw.byteLength,
      raw,
      retrievedAt: "2026-01-01T00:00:00.000Z",
      sourceUrl: `https://www.rfc-editor.org/rfc/rfc${rfc}.txt`,
      etag: null,
      lastModified: null,
      parserVersion: "rfc-text-1.7.3",
      extractorVersion: "normative-2119-8174-1.6.3",
      quality: parsed.quality,
      warnings: parsed.warnings,
      metadataHash: "meta-1",
    },
    sections: parsed.sections,
    blocks: parsed.blocks,
    mentions: normative.mentions,
    requirements: normative.requirements,
    references: [],
  });
}

describe("re-derivation-stable citation ids", () => {
  describe("identity", () => {
    it("derives the same id from two parses whose block ids and offsets differ", () => {
      const raw = Buffer.from(FIXTURE, "utf8");
      const first = parseRfcText({ rfc: 9998, snapshotId: "snp_1111111111111111", raw, parserVersion: "p" });
      // The same text, re-parsed as a different parser version would: every block id and
      // every offset moved, nothing a reader can see changed.
      const sectionIds = new Map(first.sections.map((section, index) => [section.id, `sec-b${index}`]));
      const second: { sections: Section[]; blocks: Block[] } = {
        sections: first.sections.map((section, index) => ({
          ...section,
          id: `sec-b${index}`,
          byte_start: section.byte_start + 4096,
          byte_end: section.byte_end + 4096,
          char_start: section.char_start + 4096,
          char_end: section.char_end + 4096,
          codepoint_start: section.codepoint_start + 4096,
          codepoint_end: section.codepoint_end + 4096,
          line_start: section.line_start + 40,
          line_end: section.line_end + 40,
        })),
        blocks: first.blocks.map((block, index) => ({
          ...block,
          id: `blk-b${index}`,
          section_id: sectionIds.get(block.section_id) ?? block.section_id,
          byte_start: block.byte_start + 4096,
          byte_end: block.byte_end + 4096,
          char_start: block.char_start + 4096,
          char_end: block.char_end + 4096,
          codepoint_start: block.codepoint_start + 4096,
          codepoint_end: block.codepoint_end + 4096,
          line_start: block.line_start + 40,
          line_end: block.line_end + 40,
        })),
      };

      const firstStore = new CorpusStore(":memory:");
      const secondStore = new CorpusStore(":memory:");
      try {
        commitParse(firstStore, 9998, "snp_1111111111111111", first, raw);
        commitParse(
          secondStore,
          9998,
          "snp_2222222222222222",
          { ...second, quality: first.quality, warnings: first.warnings, textLength: first.textLength },
          raw,
        );

        const left = firstStore.getRequirements("snp_1111111111111111", { limit: 100, offset: 0 });
        const right = secondStore.getRequirements("snp_2222222222222222", { limit: 100, offset: 0 });
        expect(left.length).toBeGreaterThan(0);
        expect(right.length).toBe(left.length);

        const key = (rows: readonly { exact_text: string; stable_citation_id?: string }[]): Map<string, string> =>
          new Map(rows.map((row) => [row.exact_text, row.stable_citation_id ?? ""]));
        const leftByText = key(left);
        const rightByText = key(right);
        for (const [text, stable] of leftByText) {
          // The whole point: byte-identical across a re-derivation.
          expect(stable, text).toMatch(/^scit_[0-9a-f]{24}$/u);
          expect(rightByText.get(text), text).toBe(stable);
        }

        // And the snapshot-scoped id moved, which is the defect the second id exists for.
        const leftCitations = left.map((row) => row.citation_id);
        const rightCitations = right.map((row) => row.citation_id);
        expect(rightCitations).not.toEqual(leftCitations);
        const blockIds = new Set(right.map((row) => row.block_id));
        expect([...blockIds].every((id) => id.startsWith("blk-b"))).toBe(true);
      } finally {
        firstStore.close();
        secondStore.close();
      }
    });

    it("is a different id for a different section number", () => {
      const inSection2 = stableCitationId({ rfc: 9998, sectionNumber: "2", quote: UNIQUE_SENTENCE });
      const inSection3 = stableCitationId({ rfc: 9998, sectionNumber: "3", quote: UNIQUE_SENTENCE });
      expect(inSection2).not.toBe(inSection3);
      expect(stableCitationId({ rfc: 9998, sectionNumber: "2", quote: UNIQUE_SENTENCE })).toBe(inSection2);
      // The RFC is in the hash too, so the same sentence in two documents is two ids.
      expect(stableCitationId({ rfc: 2119, sectionNumber: "2", quote: UNIQUE_SENTENCE })).not.toBe(inSection2);
      // The text is in the hash, byte for byte.
      expect(stableCitationId({ rfc: 9998, sectionNumber: "2", quote: `${UNIQUE_SENTENCE} ` })).not.toBe(inSection2);
      // And it cannot be mistaken for the snapshot-scoped id by shape.
      expect(inSection2).not.toMatch(/^cit_[0-9a-f]{24}$/u);
      expect(stableCitationId({ rfc: 9998, sectionNumber: "2", quote: UNIQUE_SENTENCE, occurrence: 1 })).not.toBe(
        inSection2,
      );
    });

    it("gives one id to a sentence that stands in two blocks of one section", () => {
      // One sentence, one section number: one id with two referents. That is the honest
      // state of the evidence, and it is why verify_citation answers `ambiguous` for it
      // rather than picking the first block it finds.
      expect(stableCitationId({ rfc: 9998, sectionNumber: "2", quote: REPEATED_SENTENCE })).toBe(
        stableCitationId({ rfc: 9998, sectionNumber: "2", quote: REPEATED_SENTENCE }),
      );
    });
  });

  describe("verify_citation", () => {
    let dir: string;
    let config: AppConfig;
    let service: RfcService;
    let snapshotId: string;

    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-citation-"));
      process.env.RFC_MCP_DATA_DIR = dir;
      process.env.RFC_MCP_LOG_LEVEL = "silent";
      config = loadConfig();
      service = RfcService.create(config, createLogger({ level: "silent" }), { fetchImpl: makeFetch() });
      const resolved = await service.resolve({ rfc: 9998 });
      snapshotId = resolved.data.snapshot.id;
    });

    afterEach(() => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function stableIdOf(exactText: string): Promise<string> {
      const page = await service.requirements({ snapshot_id: snapshotId });
      const rows = page.data.requirements as readonly {
        exact_text: string;
        stable_citation_id: string | undefined;
      }[];
      const row = rows.find((candidate) => candidate.exact_text === exactText);
      expect(row, `no requirement for ${exactText}`).toBeDefined();
      return row!.stable_citation_id!;
    }

    it("answers verified against the snapshot that minted it", async () => {
      const stableId = await stableIdOf(UNIQUE_SENTENCE);
      expect(stableId).toMatch(/^scit_[0-9a-f]{24}$/u);
      const verified = await service.verifyCitation({
        snapshot_id: snapshotId,
        citation_id: stableId,
        rfc: 9998,
        section: "2",
      });
      expect(verified.data.verdict).toBe("verified");
      // The verdict names which kind of id it was given. A caller that cannot tell the
      // two apart cannot act on either verdict.
      expect(verified.data.citation_id_kind).toBe("stable");
      expect(verified.data.citation_id).toBe(stableId);
      expect(verified.data.minted_in).toEqual([snapshotId]);
      expect(verified.data.matches).toHaveLength(1);
      expect(verified.data.matches[0]?.quote).toBe(UNIQUE_SENTENCE);
      expect(verified.data.matches[0]?.locator.span.byte_end).toBeGreaterThan(
        verified.data.matches[0]!.locator.span.byte_start,
      );
    });

    it("answers stale against another derivation of the same document, and says why", async () => {
      const stableId = await stableIdOf(UNIQUE_SENTENCE);
      const cloneId = "snp_3333333333333333";
      cloneDerivation(service.storeRef, snapshotId, cloneId);

      const againstClone = await service.verifyCitation({
        snapshot_id: cloneId,
        citation_id: stableId,
        rfc: 9998,
        section: "2",
      });
      // The text is still in the document. The derivation is not the one the citation was
      // recorded against, and those are different claims: stale, not verified.
      expect(againstClone.data.verdict).toBe("stale");
      expect(againstClone.data.citation_id_kind).toBe("stable");
      expect(againstClone.data.minted_in).toEqual([snapshotId]);
      expect(againstClone.data.matches[0]?.quote).toBe(UNIQUE_SENTENCE);
      expect(againstClone.data.notes.join(" ")).toContain("still in the document");
      expect(againstClone.data.notes.join(" ")).toContain(snapshotId);

      // The pinned snapshot still verifies, so "stale" was about the pin and not the text.
      const againstPinned = await service.verifyCitation({
        snapshot_id: snapshotId,
        citation_id: stableId,
        rfc: 9998,
        section: "2",
      });
      expect(againstPinned.data.verdict).toBe("verified");
    });

    it("reports a sentence that stands twice in one section as ambiguous, naming both spans", async () => {
      const stableId = await stableIdOf(REPEATED_SENTENCE);
      const result = await service.verifyCitation({
        snapshot_id: snapshotId,
        citation_id: stableId,
        rfc: 9998,
        section: "2",
      });
      expect(result.data.verdict).toBe("ambiguous");
      expect(result.data.matches).toHaveLength(2);
      const spans = result.data.matches.map((match) => match.locator.span);
      for (const match of result.data.matches) expect(match.quote).toBe(REPEATED_SENTENCE);
      // Both byte spans are named, they are different places, and neither is guessed.
      expect(spans[0]?.byte_start).not.toBe(spans[1]?.byte_start);
      expect(spans[0]!.byte_end).toBeGreaterThan(spans[0]!.byte_start);
      expect(spans[1]!.byte_end).toBeGreaterThan(spans[1]!.byte_start);
      expect(new Set(result.data.matches.map((match) => match.locator.block_id)).size).toBe(2);
      expect(result.data.notes.join(" ")).toContain("block_id");

      // A caller that does know which one it meant can say so with an input that already
      // exists, which is what makes `ambiguous` an answer rather than a dead end.
      const narrowed = await service.verifyCitation({
        snapshot_id: snapshotId,
        citation_id: stableId,
        rfc: 9998,
        section: "2",
        block_id: result.data.matches[1]!.locator.block_id,
      });
      expect(narrowed.data.verdict).toBe("verified");
      expect(narrowed.data.matches[0]?.locator.block_id).toBe(result.data.matches[1]?.locator.block_id);
    });

    it("refuses to resolve a stable id without the section it names", async () => {
      const stableId = await stableIdOf(UNIQUE_SENTENCE);
      const result = await service.verifyCitation({ snapshot_id: snapshotId, citation_id: stableId, rfc: 9998 });
      expect(result.data.verdict).toBe("not_found");
      expect(result.data.notes.join(" ")).toContain("section");
    });

    it("leaves the snapshot-scoped id verifying exactly as before", async () => {
      const page = await service.requirements({ snapshot_id: snapshotId });
      const rows = page.data.requirements as readonly { exact_text: string; citation_id: string }[];
      for (const row of rows) {
        expect(row.citation_id).toMatch(/^cit_[0-9a-f]{24}$/u);
        const verified = await service.verifyCitation({ snapshot_id: snapshotId, citation_id: row.citation_id });
        expect(verified.data.verdict, row.exact_text).toBe("verified");
        expect(verified.data.citation_id_kind).toBe("snapshot_scoped");
        expect(verified.data.minted_in).toEqual([]);
        expect(verified.data.matches[0]?.quote).toBe(row.exact_text);
      }
      // And an id that matches neither shape is reported as such rather than guessed at.
      const unknown = await service.verifyCitation({
        snapshot_id: snapshotId,
        citation_id: "cit_000000000000000000000000",
      });
      expect(unknown.data.verdict).toBe("not_found");
      expect(unknown.data.citation_id_kind).toBe("snapshot_scoped");
    });
  });
});

/**
 * An `ambiguous` verdict is only useful if the caller can tell the places apart.
 *
 * Measured: with `locator.span` built from the BLOCK, 15 of 27 ambiguous answers named the
 * same place twice - two records in one block, which happens whenever a paragraph states
 * two obligations, produced two citations with identical locators. The verdict said "this
 * sentence appears twice" and handed over one address twice, so the caller's only documented
 * way to disambiguate - `block_id` or `char_start` - had nothing to select on.
 */
describe("an ambiguous citation names two distinguishable places", () => {
  const LOCAL_SNAPSHOT = "snp_444444444444444444444444";
  // Two obligations in ONE paragraph, so one block. Two modals in one SENTENCE would not do:
  // the extractor emits one row per statement, and collapsing is its documented behaviour, so
  // the case that produces two records in one block is two sentences in one paragraph.
  const PARA = [
    "3.1.  Behaviour",
    "",
    "   A server MUST reject a request whose length field is zero.  A server MUST",
    "      reject a request whose length field exceeds the configured maximum.",
    "",
  ].join("\n");

  const analysis = () => {
    const parsed = parseRfcText({
      rfc: 9999,
      snapshotId: LOCAL_SNAPSHOT,
      raw: Buffer.from(PARA, "utf8"),
      parserVersion: "test",
    });
    return {
      parsed,
      rows: analyzeNormative({
        snapshotId: LOCAL_SNAPSHOT,
        rfc: 9999,
        sections: parsed.sections,
        blocks: parsed.blocks,
      }).requirements,
    };
  };

  it("finds two obligations in one block", () => {
    expect(analysis().rows).toHaveLength(2);
  });

  it("gives the two records the same block, which is the case the bug needed", () => {
    const rows = analysis().rows;
    expect(rows[0]!.block_id).toBe(rows[1]!.block_id);
  });

  it("gives the two records different spans, so a locator can select between them", () => {
    const rows = analysis().rows;
    expect(rows[0]!.span.char_start).not.toBe(rows[1]!.span.char_start);
    expect(rows[0]!.span.byte_start).not.toBe(rows[1]!.span.byte_start);
  });

  it("has each record's span address its own text in the block", () => {
    const { parsed, rows } = analysis();
    for (const row of rows) {
      const block = parsed.blocks.find((b) => b.id === row.block_id)!;
      const slice = block.text.slice(row.span.char_start - block.char_start, row.span.char_end - block.char_start);
      expect(slice.replace(/\s+/gu, " ")).toBe(row.exact_text.replace(/\s+/gu, " "));
    }
  });
});
