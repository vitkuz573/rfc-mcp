import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CorpusStore } from "../src/store/database.js";
import { SCHEMA_SQL } from "../src/store/schema.js";
import { classifyExternal } from "../src/analysis/references.js";

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
