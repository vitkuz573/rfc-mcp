/**
 * Physical schema of the local corpus.
 *
 * Design rules:
 *  - snapshots are content addressed and immutable (`snp_<hash>`);
 *  - derived rows (sections, blocks, mentions, requirements, references) are
 *    keyed by (snapshot_id, …) and are replaced atomically with the snapshot;
 *  - a monotonic `index_generation` in `meta` invalidates cursors and lets
 *    readers detect that the corpus changed under them;
 *  - FTS5 tables are derived and can always be rebuilt from `blocks`.
 */

export const SCHEMA_VERSION = "5";

/**
 * Schema migrations, applied in order to any existing corpus on open.
 *
 * `SCHEMA_SQL` only creates missing tables (`CREATE TABLE IF NOT EXISTS`), so a column
 * added to a table definition never reaches a database that already has that table.
 * Every step here is therefore written to be idempotent and is checked against the live
 * schema before it runs, so the same code path serves a fresh database and a corpus
 * built by an earlier version.
 */
export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  /** Columns to add, as `[table, column, declaration]`. */
  readonly columns?: readonly (readonly [string, string, string])[];
  /** Indexes to create; `IF NOT EXISTS` is added by the runner. */
  readonly indexes?: readonly string[];
  /**
   * Idempotent statements that derive values for rows an earlier version wrote.
   *
   * A new column added to an existing table defaults to its declared default, which
   * for a derived count means zero — a value that reads as "nothing was scanned"
   * when the truth is "this was never counted". Every statement here must be safe
   * to run repeatedly and must only touch rows the new column cannot already hold.
   */
  readonly backfills?: readonly string[];
}

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 5,
    name: "section_furniture_lines",
    columns: [["sections", "furniture_lines_json", "TEXT NOT NULL DEFAULT '[]'"]],
  },
  {
    version: 4,
    name: "snapshot_redirects",
    // A snapshot id is a hash of (document, bytes, metadata, parser, extractor), so
    // bumping a rule version retires every id at once. Without a record of where an
    // id went, a caller holding a pin from the previous version gets a bare
    // NOT_FOUND and no way to learn which document it was or what replaced it.
  },
  {
    version: 3,
    name: "snapshot_prose_block_count",
    columns: [["snapshots", "prose_block_count", "INTEGER NOT NULL DEFAULT 0"]],
    // Snapshots ingested before this column existed all carry the declared default
    // of 0, which reads as "no prose block was scanned" instead of "never counted".
    // Recompute it from the stored blocks, which are the authority either way, and
    // leave a genuine zero alone by only touching rows that still hold 0.
    backfills: [
      `UPDATE snapshots
          SET prose_block_count = (
            SELECT COUNT(*) FROM blocks b
             WHERE b.snapshot_id = snapshots.id
               AND b.kind IN ('paragraph', 'list_item', 'unknown')
               AND COALESCE((
                 SELECT s.kind FROM sections s
                  WHERE s.snapshot_id = b.snapshot_id AND s.id = b.section_id
               ), 'unknown') NOT IN ('authors', 'index', 'references')
          )
        WHERE prose_block_count = 0
          AND EXISTS (SELECT 1 FROM blocks b WHERE b.snapshot_id = snapshots.id)`,
    ],
  },
  {
    version: 2,
    name: "reference_external_identity",
    columns: [
      ["rfc_references", "external_kind", "TEXT"],
      ["rfc_references", "external_id", "TEXT"],
      ["rfc_references", "external_publisher", "TEXT"],
      ["rfc_references", "external_year", "INTEGER"],
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS references_by_external ON rfc_references (snapshot_id, target_kind, external_id)",
    ],
  },
];

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog (
  rfc              INTEGER PRIMARY KEY,
  document_id      TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  abstract         TEXT,
  published        TEXT,
  pages            INTEGER,
  status_json      TEXT,
  stream_json      TEXT,
  area_json        TEXT,
  group_json       TEXT,
  keywords_json    TEXT NOT NULL,
  authors_json     TEXT NOT NULL,
  obsoletes_json   TEXT NOT NULL,
  obsoleted_by_json TEXT NOT NULL,
  updates_json     TEXT NOT NULL,
  updated_by_json  TEXT NOT NULL,
  subseries_json   TEXT NOT NULL,
  identifiers_json TEXT NOT NULL,
  formats_json     TEXT NOT NULL,
  doi              TEXT,
  canonical_url    TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  observed_at      TEXT NOT NULL,
  content_hash     TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
  document_id UNINDEXED,
  rfc UNINDEXED,
  title,
  abstract,
  keywords,
  authors,
  status,
  stream,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS snapshots (
  id                TEXT PRIMARY KEY,
  rfc               INTEGER NOT NULL REFERENCES catalog(rfc) ON DELETE CASCADE,
  format            TEXT NOT NULL,
  raw_sha256        TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  raw               BLOB NOT NULL,
  retrieved_at      TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  etag              TEXT,
  last_modified     TEXT,
  parser_version    TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  quality           TEXT NOT NULL,
  warnings_json     TEXT NOT NULL,
  metadata_hash     TEXT NOT NULL,
  section_count     INTEGER NOT NULL DEFAULT 0,
  block_count       INTEGER NOT NULL DEFAULT 0,
  requirement_count INTEGER NOT NULL DEFAULT 0,
  reference_count   INTEGER NOT NULL DEFAULT 0,
  -- Blocks the normative extractor actually read. Without this a caller cannot tell
  -- "scanned 4 blocks, found nothing" from "scanned 900, found nothing", and the
  -- two support opposite conclusions about whether a document states any norms.
  prose_block_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS snapshots_content
  ON snapshots (rfc, format, raw_sha256, metadata_hash);
CREATE INDEX IF NOT EXISTS snapshots_by_rfc ON snapshots (rfc, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS assets (
  snapshot_id  TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  format       TEXT NOT NULL,
  raw_sha256   TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  body         BLOB NOT NULL,
  content_type TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  etag         TEXT,
  last_modified TEXT,
  PRIMARY KEY (snapshot_id, format)
);

CREATE TABLE IF NOT EXISTS sections (
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  rfc             INTEGER NOT NULL,
  number          TEXT NOT NULL,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  parent_id       TEXT,
  ordinal         INTEGER NOT NULL,
  path_json       TEXT NOT NULL,
  text            TEXT NOT NULL,
  text_sha256     TEXT NOT NULL,
  -- Line numbers inside the text column that carry page furniture. The text is a
  -- verbatim slice, so those lines remain in it; this is how a caller finds them.
  furniture_lines_json TEXT NOT NULL DEFAULT '[]',
  byte_start      INTEGER NOT NULL,
  byte_end        INTEGER NOT NULL,
  char_start      INTEGER NOT NULL,
  char_end        INTEGER NOT NULL,
  codepoint_start INTEGER NOT NULL,
  codepoint_end   INTEGER NOT NULL,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);

CREATE INDEX IF NOT EXISTS sections_by_number ON sections (snapshot_id, number);
CREATE INDEX IF NOT EXISTS sections_by_ordinal ON sections (snapshot_id, ordinal);

CREATE TABLE IF NOT EXISTS blocks (
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  id              TEXT NOT NULL,
  rfc             INTEGER NOT NULL,
  section_id      TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  text            TEXT NOT NULL,
  text_sha256     TEXT NOT NULL,
  byte_start      INTEGER NOT NULL,
  byte_end        INTEGER NOT NULL,
  char_start      INTEGER NOT NULL,
  char_end        INTEGER NOT NULL,
  codepoint_start INTEGER NOT NULL,
  codepoint_end   INTEGER NOT NULL,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, id)
);

CREATE INDEX IF NOT EXISTS blocks_by_section ON blocks (snapshot_id, section_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  snapshot_id UNINDEXED,
  block_id UNINDEXED,
  section_id UNINDEXED,
  rfc UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS mentions (
  id             TEXT PRIMARY KEY,
  snapshot_id    TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  rfc            INTEGER NOT NULL,
  section_id     TEXT NOT NULL,
  block_id       TEXT NOT NULL,
  term           TEXT NOT NULL,
  strength       TEXT NOT NULL,
  polarity       TEXT NOT NULL,
  exact_text     TEXT NOT NULL,
  context        TEXT NOT NULL,
  disposition    TEXT NOT NULL,
  flags_json     TEXT NOT NULL,
  citation_id    TEXT NOT NULL,
  char_start     INTEGER NOT NULL,
  char_end       INTEGER NOT NULL,
  byte_start     INTEGER NOT NULL,
  byte_end       INTEGER NOT NULL,
  codepoint_start INTEGER NOT NULL,
  codepoint_end  INTEGER NOT NULL,
  line_start     INTEGER NOT NULL,
  line_end       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mentions_by_snapshot ON mentions (snapshot_id, term);
CREATE INDEX IF NOT EXISTS mentions_by_citation ON mentions (citation_id);

CREATE TABLE IF NOT EXISTS requirements (
  id              TEXT PRIMARY KEY,
  snapshot_id     TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
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
  char_start      INTEGER NOT NULL,
  char_end        INTEGER NOT NULL,
  byte_start      INTEGER NOT NULL,
  byte_end        INTEGER NOT NULL,
  codepoint_start INTEGER NOT NULL,
  codepoint_end   INTEGER NOT NULL,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS requirements_by_snapshot ON requirements (snapshot_id, term);
CREATE INDEX IF NOT EXISTS requirements_by_citation ON requirements (citation_id);

CREATE TABLE IF NOT EXISTS rfc_references (
  id           TEXT PRIMARY KEY,
  snapshot_id  TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  rfc          INTEGER NOT NULL,
  section_id   TEXT,
  ordinal      INTEGER NOT NULL,
  label        TEXT NOT NULL,
  raw_text     TEXT NOT NULL,
  relation     TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  target       TEXT,
  target_rfc   INTEGER,
  resolution   TEXT NOT NULL,
  -- Identity of a cited non-IETF document, recovered from the entry text. NULL when the
  -- entry is an IETF document or when nothing in it designates the target.
  external_kind      TEXT,
  external_id        TEXT,
  external_publisher TEXT,
  external_year     INTEGER,
  cited_by_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS references_by_snapshot ON rfc_references (snapshot_id, relation);
CREATE INDEX IF NOT EXISTS references_by_target ON rfc_references (target_rfc);
-- No index over external_id here: SCHEMA_SQL runs before the migrations, and against an
-- existing corpus this table already exists without that column, so the statement would
-- fail. Indexes that depend on a migrated column are created by the migration instead.

-- In-body citation sites, normalised. rfc_references keeps them inside a JSON column,
-- which is fine for reading a single reference but not for asking the inverse question
-- "which blocks cite a normative reference", i.e. the relation: search filter.
CREATE TABLE IF NOT EXISTS reference_citations (
  snapshot_id  TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  block_id     TEXT NOT NULL,
  relation     TEXT NOT NULL,
  char_start   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_citations_unique
  ON reference_citations (reference_id, block_id, char_start);
CREATE INDEX IF NOT EXISTS reference_citations_by_block
  ON reference_citations (snapshot_id, relation, block_id);

CREATE TABLE IF NOT EXISTS relations (
  rfc          INTEGER NOT NULL,
  direction    TEXT NOT NULL,
  relation     TEXT NOT NULL,
  target_rfc   INTEGER NOT NULL,
  source       TEXT NOT NULL,
  evidence_json TEXT,
  observed_at  TEXT NOT NULL,
  PRIMARY KEY (rfc, direction, relation, target_rfc, source)
);

CREATE INDEX IF NOT EXISTS relations_by_target ON relations (target_rfc, direction);

-- Where a retired snapshot id went. A rule-version bump re-derives every document
-- under a new id; without this the old id is simply gone, and a caller holding a
-- pin is told only that it is unknown, not which document it referred to or what
-- now stands in for it.
CREATE TABLE IF NOT EXISTS snapshot_redirects (
  old_id     TEXT PRIMARY KEY,
  new_id     TEXT NOT NULL,
  rfc        INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshot_redirects_by_rfc ON snapshot_redirects (rfc);

CREATE TABLE IF NOT EXISTS errata (
  rfc           INTEGER NOT NULL,
  errata_id     TEXT NOT NULL,
  status        TEXT NOT NULL,
  type          TEXT,
  section       TEXT,
  original_text TEXT,
  corrected_text TEXT,
  notes         TEXT,
  submitted_at  TEXT,
  updated_at    TEXT,
  url           TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  PRIMARY KEY (rfc, errata_id)
);

CREATE INDEX IF NOT EXISTS errata_by_status ON errata (rfc, status);

CREATE TABLE IF NOT EXISTS history (
  id           TEXT NOT NULL,
  rfc          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  published_at TEXT,
  author       TEXT,
  url          TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  PRIMARY KEY (rfc, id)
);

CREATE TABLE IF NOT EXISTS source_cache (
  url           TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  status        INTEGER NOT NULL,
  content_type  TEXT,
  body          BLOB,
  fetched_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  message    TEXT NOT NULL,
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS failures_by_at ON failures (at DESC);
`;
