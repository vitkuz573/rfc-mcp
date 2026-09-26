import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CorpusStore, NORMATIVE_KEYWORD_STEMS, carriesNormativeKeyword } from "../src/store/database.js";
import { SCHEMA_MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "../src/store/schema.js";
import { classifyExternal } from "../src/analysis/references.js";
import type { Section } from "../src/core/types.js";

/** The live handle, for the tests that seed rows the public API does not write. */
const db = (store: CorpusStore): DatabaseSync => (store as unknown as { db: DatabaseSync }).db;

describe("schema migrations", () => {
  it("adds new columns to a corpus created by an earlier build", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-migration-"));
    const file = path.join(dir, "corpus.sqlite");
    try {
      // Build the old shape: the table exists, without the external-identity columns.
      const legacy = new DatabaseSync(file);
      legacy.exec("PRAGMA foreign_keys = ON;");
      legacy.exec(
        `CREATE TABLE catalog (rfc INTEGER PRIMARY KEY, document_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
           keywords_json TEXT NOT NULL, authors_json TEXT NOT NULL, obsoletes_json TEXT NOT NULL,
           obsoleted_by_json TEXT NOT NULL, updates_json TEXT NOT NULL, updated_by_json TEXT NOT NULL,
           subseries_json TEXT NOT NULL, identifiers_json TEXT NOT NULL, source_url TEXT NOT NULL,
           observed_at TEXT NOT NULL, content_hash TEXT NOT NULL)`,
      );
      legacy.exec(
        `CREATE TABLE rfc_references (id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, rfc INTEGER NOT NULL,
           section_id TEXT, ordinal INTEGER NOT NULL, label TEXT NOT NULL, raw_text TEXT NOT NULL,
           relation TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT, target_rfc INTEGER,
           resolution TEXT NOT NULL, cited_by_json TEXT NOT NULL)`,
      );
      legacy.close();

      // Opening it through the store must bring it to the current shape.
      const store = new CorpusStore(file);
      const columns = (store as unknown as { db: DatabaseSync }).db
        .prepare("PRAGMA table_info(rfc_references)")
        .all() as { name: string }[];
      const names = columns.map((c) => c.name);
      for (const column of ["external_kind", "external_id", "external_publisher", "external_year"]) {
        expect(names).toContain(column);
      }
      // A fresh database and a migrated one must expose the same columns. Order differs —
      // ALTER TABLE appends — so the comparison is on the set, not the sequence.
      const fresh = new CorpusStore(":memory:");
      const freshColumns = (fresh as unknown as { db: DatabaseSync }).db
        .prepare("PRAGMA table_info(rfc_references)")
        .all() as { name: string }[];
      expect([...freshColumns.map((c) => c.name)].sort()).toEqual([...names].sort());
      // And re-opening must be a no-op.
      expect(() => new CorpusStore(file).close()).not.toThrow();
      store.close();
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares every table before any migration runs", () => {
    // The migration runner skips a step whose table is absent, so a base schema missing a
    // table would silently skip a column forever. Guard the invariant explicitly.
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS rfc_references");
    expect(SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS snapshot_redirects");
  });
});

describe("stable citation id migration", () => {
  /** The pre-8 shape of `requirements`, which is the table the id was added to. */
  const LEGACY_REQUIREMENTS = `CREATE TABLE requirements (
     id              TEXT PRIMARY KEY,
     snapshot_id     TEXT NOT NULL,
     rfc             INTEGER NOT NULL,
     section_id      TEXT NOT NULL,
     block_id        TEXT NOT NULL,
     term            TEXT NOT NULL,
     strength        TEXT NOT NULL,
     polarity        TEXT NOT NULL,
     exact_text      TEXT NOT NULL,
     citation_id     TEXT NOT NULL,
     parse_status    TEXT NOT NULL,
     confidence      REAL NOT NULL,
     actor           TEXT,
     condition_text  TEXT,
     action          TEXT,
     exception_text  TEXT,
     flags_json      TEXT NOT NULL,
     keywords_json   TEXT NOT NULL DEFAULT '[]',
     char_start      INTEGER NOT NULL,
     char_end        INTEGER NOT NULL,
     byte_start      INTEGER NOT NULL,
     byte_end        INTEGER NOT NULL,
     codepoint_start INTEGER NOT NULL,
     codepoint_end   INTEGER NOT NULL,
     line_start      INTEGER NOT NULL,
     line_end        INTEGER NOT NULL
   )`;

  const columns = (store: CorpusStore, table: string): string[] =>
    (db(store).prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
  function legacyCorpus(file: string): void {
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA foreign_keys = ON;");
    legacy.exec(LEGACY_REQUIREMENTS);
    legacy.close();
  }

  it("adds the column to a corpus written before it existed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-stable-migration-"));
    const file = path.join(dir, "corpus.sqlite");
    try {
      legacyCorpus(file);
      const store = new CorpusStore(file);
      for (const table of ["requirements", "mentions"]) {
        expect(columns(store, table), table).toContain("stable_citation_id");
      }
      // A fresh database and a migrated one must expose the same columns.
      const fresh = new CorpusStore(":memory:");
      for (const table of ["requirements", "mentions"]) {
        expect([...columns(fresh, table)].sort(), table).toEqual([...columns(store, table)].sort());
      }
      // Re-opening is a no-op rather than a duplicate-column failure.
      store.close();
      expect(() => new CorpusStore(file).close()).not.toThrow();
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports 'never minted' for a row an earlier build wrote, instead of a reconstruction", () => {
    // The id hashes the section NUMBER, which is not on the row, so there is nothing
    // honest to rebuild it from and a backfill could only have guessed. The column's
    // default is the honest answer, and `reanalyze --all` is what replaces it.
    const dir = mkdtempSync(path.join(tmpdir(), "rfc-mcp-stable-default-"));
    const file = path.join(dir, "corpus.sqlite");
    try {
      legacyCorpus(file);
      const store = new CorpusStore(file);
      const database = db(store);
      database
        .prepare(
          `INSERT INTO requirements (id, snapshot_id, rfc, section_id, block_id, term, strength, polarity, exact_text,
             citation_id, parse_status, confidence, flags_json, keywords_json, char_start, char_end, byte_start,
             byte_end, codepoint_start, codepoint_end, line_start, line_end)
           VALUES ('req_legacy', 'snp_legacy', 9998, 'sec-1', 'blk-1', 'MUST', 'absolute', 'positive',
             'A server MUST log the request.', 'cit_legacy', 'complete', 0.9, '[]', '[]', 10, 20, 10, 20, 10, 20, 1, 1)`,
        )
        .run();
      const row = store.getRequirementById("snp_legacy", "req_legacy");
      expect(row?.exact_text).toBe("A server MUST log the request.");
      expect(row?.stable_citation_id).toBe("");
      // And the column cannot be matched as a citation, so a blank id never resolves to
      // something a caller could quote.
      expect(store.stableCitationOrigins("")).toEqual([]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("indexes the column from the migration, not from the base schema", () => {
    // SCHEMA_SQL runs before the migrations, so an index over a migrated column in the
    // base schema fails on every existing corpus instead of being skipped. The base
    // schema must therefore not mention it, and the migration must.
    expect(SCHEMA_SQL).not.toContain("requirements_by_stable_citation");
    expect(SCHEMA_MIGRATIONS.find((migration) => migration.version === 8)?.indexes).toContain(
      "CREATE INDEX IF NOT EXISTS requirements_by_stable_citation ON requirements (stable_citation_id)",
    );
    expect(SCHEMA_VERSION).toBe("8");
    // No backfill, and the reason is on the record next to the step that omits it.
    const step = SCHEMA_MIGRATIONS.find((migration) => migration.version === 8);
    expect(step?.backfills ?? []).toEqual([]);
  });
});

describe("snapshot redirects", () => {
  /** Seed a catalog row and one snapshot, the minimum `snapshots.rfc` will accept. */
  function seed(store: CorpusStore, rfc: number, id: string): void {
    const db = (store as unknown as { db: DatabaseSync }).db;
    store.upsertCatalog([
      {
        rfc,
        document_id: `rfc-${rfc}`,
        title: "T",
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
      },
    ]);
    db.prepare(
      `INSERT OR REPLACE INTO snapshots (id, rfc, format, raw_sha256, bytes, raw, retrieved_at, source_url,
         etag, last_modified, parser_version, extractor_version, quality, warnings_json, metadata_hash)
       VALUES (?, ?, 'txt', ?, 0, X'', '2026-01-01T00:00:00Z', 'https://example.invalid', NULL, NULL, 'p', 'e', 'complete', '[]', 'm')`,
    ).run(id, rfc, `${id}-raw`);
  }

  /** One rule-version bump: retire the outgoing id, install the new one. */
  function bump(store: CorpusStore, rfc: number, newId: string): void {
    const db = (store as unknown as { db: DatabaseSync }).db;
    store.retireSnapshots(rfc, newId);
    db.prepare("DELETE FROM snapshots WHERE rfc = ?").run(rfc);
    seed(store, rfc, newId);
  }

  it("points a retired id at its replacement", () => {
    const store = new CorpusStore(":memory:");
    try {
      seed(store, 1035, "snp_aaaaaaaaaaaa");
      bump(store, 1035, "snp_bbbbbbbbbbbb");
      expect(store.getSnapshotRedirect("snp_aaaaaaaaaaaa")).toEqual({ new_id: "snp_bbbbbbbbbbbb", rfc: 1035 });
      expect(store.getSnapshotRedirect("snp_never_issued")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("collapses a chain of bumps into one hop", () => {
    // The cost of a version bump is a caller re-pinning. A pin from three versions
    // ago must therefore resolve to the current id in a single step, not by walking
    // a chain of intermediate ids the caller cannot see.
    const store = new CorpusStore(":memory:");
    try {
      seed(store, 1035, "snp_aaaaaaaaaaaa");
      bump(store, 1035, "snp_bbbbbbbbbbbb");
      bump(store, 1035, "snp_cccccccccccc");
      bump(store, 1035, "snp_dddddddddddd");
      for (const old of ["snp_aaaaaaaaaaaa", "snp_bbbbbbbbbbbb", "snp_cccccccccccc"]) {
        expect(store.getSnapshotRedirect(old)?.new_id, old).toBe("snp_dddddddddddd");
      }
    } finally {
      store.close();
    }
  });

  it("does not redirect an id that is still current", () => {
    const store = new CorpusStore(":memory:");
    try {
      seed(store, 1035, "snp_aaaaaaaaaaaa");
      store.retireSnapshots(1035, "snp_aaaaaaaaaaaa");
      expect(store.getSnapshotRedirect("snp_aaaaaaaaaaaa")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("the RFC 2119 keyword predicate", () => {
  /**
   * A snapshot with one block per capitalisation, all of them in blocks the extractor
   * refuses to read, so the loss counter and the block selector can be compared on the
   * same set.
   */
  function seedKeywordBlocks(store: CorpusStore, texts: readonly string[]): string {
    const record = {
      rfc: 4242,
      document_id: "rfc-4242",
      title: "T",
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
      canonical_url: "https://www.rfc-editor.org/info/rfc4242",
      source_url: "https://www.rfc-editor.org/info/rfc4242",
      observed_at: "2026-01-01T00:00:00.000Z",
      content_hash: "h",
    };
    const raw = Buffer.from(texts.join("\n\n"), "utf8");
    const snapshotId = "snp_kwkwkwkwkwkwkwkwkwkwkwk";
    store.commitDocument({
      record,
      snapshot: {
        id: snapshotId,
        rfc: 4242,
        format: "txt",
        rawSha256: "raw",
        bytes: raw.byteLength,
        raw,
        retrievedAt: "2026-01-01T00:00:00.000Z",
        sourceUrl: "https://www.rfc-editor.org/info/rfc4242",
        etag: null,
        lastModified: null,
        parserVersion: "p",
        extractorVersion: "e",
        quality: "complete",
        warnings: [],
        metadataHash: "m",
      },
      sections: [
        {
          id: "sec_body",
          snapshot_id: snapshotId,
          rfc: 4242,
          number: "1",
          title: "Body",
          kind: "body",
          parent_id: null,
          ordinal: 0,
          path: ["1", "Body"],
          text: texts.join("\n\n"),
          text_sha256: "h",
          furniture_lines: [],
          byte_start: 0,
          byte_end: raw.byteLength,
          char_start: 0,
          char_end: raw.byteLength,
          codepoint_start: 0,
          codepoint_end: raw.byteLength,
          line_start: 1,
          line_end: texts.length * 2,
        } satisfies Section,
      ],
      blocks: texts.map((text, index) => ({
        id: `blk_${index}`,
        snapshot_id: snapshotId,
        rfc: 4242,
        section_id: "sec_body",
        ordinal: index,
        // `table` is a kind the extractor never reads, which is the point: these blocks are
        // the loss the counter exists to account for.
        kind: "table" as const,
        text,
        text_sha256: "h",
        byte_start: 0,
        byte_end: raw.byteLength,
        char_start: 0,
        char_end: raw.byteLength,
        codepoint_start: 0,
        codepoint_end: raw.byteLength,
        line_start: index * 2 + 1,
        line_end: index * 2 + 1,
      })),
      mentions: [],
      requirements: [],
      references: [],
    });
    return snapshotId;
  }

  it("counts a keyword in any capitalisation, in the counter and in the selector alike", () => {
    // The counter tested an upper-case probe and the candidate pass selected its blocks with
    // a case-insensitive LIKE, so the same predicate had two case semantics: a body block
    // holding only a lower-case modal was dropped by one pass, uncounted by the other, and
    // raised no warning. Both sides are now generated from one keyword list.
    const store = new CorpusStore(":memory:");
    try {
      const snapshotId = seedKeywordBlocks(store, [
        "A server MUST log the request.",
        "A server must log the request.",
        "A server Must log the request.",
        "A list of mustards, and a maximum of 3.",
        "The maximum total length of a command line is 512 octets.",
      ]);
      const snapshot = store.getSnapshot(snapshotId)!;
      // Four of the five carry a keyword in some capitalisation; the two that do not are a
      // substring false positive and a keyword-free bound, and the counter must exclude both.
      expect(snapshot.keyword_bearing_unscanned_block_count).toBe(3);
      expect(snapshot.unscanned_block_count).toBe(5);
      // The selector finds the same three plus the substring false positive, and that
      // difference is measured rather than accidental: the LIKE is a PREFILTER that decides
      // which blocks get loaded, and the candidate pass re-tests every sentence it is handed
      // with its own word-bounded regex, so "mustards" costs one string test and produces no
      // row. Word boundaries in SQL would mean locating every occurrence in SQL, which is
      // the shape of query that cost 29 500 ms on RFC 3261. Over the 182-document corpus
      // this residual is 101 blocks against 1 471 that really carry a keyword.
      expect(store.listBlocksWithKeywords(snapshotId).map((block) => block.text)).toEqual([
        "A server MUST log the request.",
        "A server must log the request.",
        "A server Must log the request.",
        "A list of mustards, and a maximum of 3.",
      ]);
      expect(carriesNormativeKeyword("A server must log the request.")).toBe(true);
      expect(carriesNormativeKeyword("A list of mustards.")).toBe(false);
      expect(carriesNormativeKeyword("The maximum total length is 512 octets.")).toBe(false);
      // The list is the source both consumers read, so a keyword added to NORMATIVE_TERMS
      // cannot leave them disagreeing again.
      for (const stem of NORMATIVE_KEYWORD_STEMS) {
        expect(carriesNormativeKeyword(`a clause with ${stem} in it`), stem).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("recomputes a loss counter an earlier build wrote, once, without moving the generation", () => {
    // The counters are a function of the keyword predicate and not of the snapshot
    // identity, so `reanalyze` leaves them alone and a corpus written by a case-sensitive
    // probe reports its numbers forever. The only documented remedy was a rule-version bump,
    // which re-mints every pinned id in the corpus.
    const store = new CorpusStore(":memory:");
    try {
      const snapshotId = seedKeywordBlocks(store, [
        "A server must log the request.",
        "The maximum total length of a command line is 512 octets.",
      ]);
      const database = db(store);
      // Pretend an earlier build wrote the row: one keyword-bearing block, and no record of
      // which predicate produced it.
      database
        .prepare(
          "UPDATE snapshots SET keyword_bearing_unscanned_block_count = 0, unscanned_block_count = 0, unscanned_block_kinds_json = '{}' WHERE id = ?",
        )
        .run(snapshotId);
      database.prepare("DELETE FROM meta WHERE key LIKE 'loss_counter_predicate:%'").run();
      const generationBefore = store.getGeneration();

      const first = store.ensureLossCounters(snapshotId)!;
      expect(first.repaired).toBe(true);
      expect(first.keywordBearing).toBe(1);
      expect(first.unscanned).toBe(2);
      expect(first.byKind).toEqual({ table: 2 });
      // The number is right for the caller immediately, and the repair is visible.
      expect(store.getSnapshot(snapshotId)!.keyword_bearing_unscanned_block_count).toBe(1);

      // Once, not on every call: the second read is a stored value.
      const second = store.ensureLossCounters(snapshotId)!;
      expect(second.repaired).toBe(false);
      expect(second.keywordBearing).toBe(1);
      // A corrected reported number changes no indexed text, so a cursor that was valid a
      // moment ago is still valid. Bumping the generation would invalidate every outstanding
      // cursor for a change no caller could perceive.
      expect(store.getGeneration()).toBe(generationBefore);
      expect(store.ensureLossCounters("snp_does_not_exist")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("counts the rows that declare themselves fragments, under the same filters", () => {
    // `coverage` describes the document while `requirements` is one page of it, so the
    // count has to be a document-level query and not read off the page. The value it counts
    // does not exist yet - the diagnosis for it specifies `parse_status: "fragment"` and the
    // strict extractor emits `complete` today - and 0 is the true answer to the question
    // asked, not a claim that the document has none.
    const store = new CorpusStore(":memory:");
    try {
      const snapshotId = seedKeywordBlocks(store, ["A server MUST log the request."]);
      const row = (id: string, sectionId: string, parseStatus: string): Record<string, string | number | null> => ({
        id,
        snapshot_id: snapshotId,
        rfc: 4242,
        section_id: sectionId,
        block_id: "blk_0",
        term: "MUST",
        strength: "absolute",
        polarity: "positive",
        exact_text: `A server MUST ${id}.`,
        citation_id: `cit_${id}`,
        parse_status: parseStatus,
        confidence: 0.9,
        actor: null,
        condition_text: null,
        action: null,
        exception_text: null,
        flags_json: "[]",
        keywords_json: "[]",
        char_start: 0,
        char_end: 10,
        byte_start: 0,
        byte_end: 10,
        codepoint_start: 0,
        codepoint_end: 10,
        line_start: 1,
        line_end: 1,
      });
      const insert = db(store).prepare(
        `INSERT INTO requirements (id, snapshot_id, rfc, section_id, block_id, term, strength, polarity, exact_text,
           citation_id, parse_status, confidence, actor, condition_text, action, exception_text, flags_json,
           keywords_json, char_start, char_end, byte_start, byte_end, codepoint_start, codepoint_end, line_start, line_end)
         VALUES (@id, @snapshot_id, @rfc, @section_id, @block_id, @term, @strength, @polarity, @exact_text,
           @citation_id, @parse_status, @confidence, @actor, @condition_text, @action, @exception_text, @flags_json,
           @keywords_json, @char_start, @char_end, @byte_start, @byte_end, @codepoint_start, @codepoint_end, @line_start, @line_end)`,
      );
      insert.run(row("req_a", "sec_body", "complete"));
      insert.run(row("req_b", "sec_body", "fragment"));
      insert.run(row("req_c", "sec_other", "fragment"));

      expect(store.countFragmentRequirements(snapshotId, {})).toBe(2);
      // Under the section prefix, exactly as countRequirements is, so the two numbers on a
      // filtered response describe the same set.
      expect(store.countFragmentRequirements(snapshotId, { sectionPrefix: "1" })).toBe(1);
      expect(store.countFragmentRequirements(snapshotId, { sectionPrefix: "99" })).toBe(0);
      expect(store.countFragmentRequirements(snapshotId, { term: "MUST" })).toBe(2);
      expect(store.countFragmentRequirements(snapshotId, { term: "MAY" })).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("external reference identity", () => {
  it("recovers standard designations from the entry text", () => {
    const cases: readonly [string, string, string | null][] = [
      ['[FIPS197] NIST, "AES", FIPS PUB 197, November 2001.', "FIPS 197", "NIST"],
      ['[FIPS180] NIST FIPS PUB 180-2, "Secure Hash Standard".', "FIPS 180", "NIST"],
      ["[X680] ITU-T Recommendation X.680 (2002) | ISO/IEC 8824-1:2002.", "ITU-T X.680", "ITU-T"],
      ["[ISO10646] ISO/IEC 10646:2003, Information technology.", "ISO/IEC 10646:2003", "ISO"],
      ["[UTR15] Unicode Standard Annex #15, April 2005.", "UAX #15", "Unicode Consortium"],
      ["[UNIV4] The Unicode Standard, Version 4.0.1.", "Unicode 4.0.1", "Unicode Consortium"],
    ];
    for (const [text, id, publisher] of cases) {
      const identity = classifyExternal(text);
      expect(identity?.id, text).toBe(id);
      expect(identity?.publisher, text).toBe(publisher);
      expect(identity?.kind, text).toBe("standard");
    }
  });

  it("reports a bare URL as an identity rather than nothing", () => {
    const identity = classifyExternal("[OWASP] OWASP Foundation, <https://owasp.org/x>, 2023.");
    expect(identity).toEqual({ kind: "url", id: "https://owasp.org/x", publisher: null, year: null });
  });

  it("invents nothing when the text designates nothing", () => {
    expect(classifyExternal("[MYSTERY] Something with no designation at all.")).toBeNull();
    expect(classifyExternal("")).toBeNull();
  });

  it("prefers a standard designation over a URL in the same entry", () => {
    const identity = classifyExternal('[FIPS197] NIST, "AES", FIPS PUB 197, <https://doi.org/10.6028/NIST.FIPS.197>.');
    expect(identity?.id).toBe("FIPS 197");
  });

  it("reads designations and URLs in the forms RFC entries actually use", () => {
    const cases: readonly [string, string][] = [
      ['[ASCII] American National Standards Institute, "Coded Character Set", ANSI X3.4, 1986.', "ANSI X3.4"],
      ['[3DES] NIST, "Triple DES", NIST Special Publication 800-67, May 2004.', "NIST SP 800-67"],
      ['[CCM] "NIST Special Publication 800-38C: CCM Mode", SP800-38C.pdf', "NIST SP 800-38C"],
      [
        '[BidiEx] "Examples of bidirectional IRIs", <http://www.w3.org/International/iri-edit/ BidiExamples>.',
        "http://www.w3.org/International/iri-edit/BidiExamples",
      ],
      [
        // A standard designation beats a URL in the same entry, whichever form it takes.
        '[CCM] Dworkin, M., "NIST SP 800-38C", <http://csrc.nist.gov/publications/nistpubs/800-38C/ SP800-38C.pdf>.',
        "NIST SP 800-38C",
      ],
      [
        "[IEEE] Institute of Electrical and Electronics Engineers, <http://ieeexplore.ieee.org/document/1659158/>.",
        "http://ieeexplore.ieee.org/document/1659158/",
      ],
      // A URL at the end of a sentence does not carry the sentence's punctuation.
      [
        "[CBCATT] Bodo Moeller, <http://www.openssl.org/~bodo/tls-cbc.txt>.",
        "http://www.openssl.org/~bodo/tls-cbc.txt",
      ],
      ['[PAPER] Someone, "A study" (see http://example.org/paper.pdf).', "http://example.org/paper.pdf"],
      ["[DICT] See http://example.org/dict.", "http://example.org/dict"],
    ];
    for (const [text, id] of cases) expect(classifyExternal(text)?.id, text).toBe(id);
  });
});
