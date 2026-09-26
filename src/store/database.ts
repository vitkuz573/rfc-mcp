/**
 * Corpus store: the only component that touches SQLite.
 *
 * All derived data is committed in a single transaction together with the
 * snapshot it was derived from, so a reader either sees a complete document
 * analysis or the previous complete one. Every write bumps `index_generation`,
 * which is what makes cursors and cached analyses detect corpus changes.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type {
  Block,
  CatalogRecord,
  Erratum,
  HistoryEntry,
  NormativeMention,
  ReferenceRecord,
  Requirement,
  Section,
  Snapshot,
  Span,
} from "../core/types.js";
import { canonicalErrataStatus, errataStatusFilter } from "../core/types.js";
import { PROSE_BLOCK_KINDS, SKIPPED_SECTION_KINDS } from "../analysis/normative.js";
import { contentHash, isoNow, sha256Hex, shortHash } from "../core/util.js";
import { SCHEMA_MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type { HttpCacheEntry } from "../upstream/http.js";
import type { UpstreamAsset as SourceAsset } from "../upstream/sources.js";

export interface DocumentBundle {
  readonly record: CatalogRecord;
  readonly snapshot: {
    readonly id: string;
    readonly rfc: number;
    readonly format: "txt" | "xml";
    readonly rawSha256: string;
    readonly bytes: number;
    readonly raw: Buffer;
    readonly retrievedAt: string;
    readonly sourceUrl: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
    readonly parserVersion: string;
    readonly extractorVersion: string;
    readonly quality: "complete" | "degraded";
    readonly warnings: readonly string[];
    readonly metadataHash: string;
  };
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
  readonly mentions: readonly NormativeMention[];
  readonly requirements: readonly Requirement[];
  readonly references: readonly ReferenceRecord[];
  readonly assets?: readonly SourceAsset[];
}

export interface SearchQuery {
  readonly match: string;
  readonly rfcs: readonly number[];
  readonly sectionPrefix: string | null;
  readonly blockKinds: readonly string[] | null;
  /** Restrict to blocks that cite a reference of this relation. */
  readonly relation?: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface BlockSearchRow {
  readonly rfc: number;
  readonly title: string;
  readonly snapshot_id: string;
  readonly block_id: string;
  readonly section_id: string;
  readonly section_path: readonly string[];
  readonly text: string;
  readonly score: number;
  readonly rank: number;
}

export class CorpusStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  readonly path: string;

  constructor(databasePath: string) {
    this.path = databasePath;
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
    this.applyMigrations();
    this.setMeta("schema_version", SCHEMA_VERSION);
    if (this.getMeta("index_generation") === null) this.setMeta("index_generation", "0");
  }

  /**
   * Brings an existing corpus up to the current schema. Each step is checked against the
   * live schema before it is applied, so a fresh database and one written by an older
   * build converge on the same shape without either failing.
   */
  private applyMigrations(): void {
    const tableExists = (table: string): boolean =>
      this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const columnExists = (table: string, column: string): boolean =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

    for (const migration of SCHEMA_MIGRATIONS) {
      // The checks are against the live schema rather than a stored version, so the same
      // path is correct for a fresh database, an older corpus, and a re-run.
      let changed = false;
      for (const [table, column, declaration] of migration.columns ?? []) {
        if (!tableExists(table) || columnExists(table, column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
        changed = true;
      }
      for (const index of migration.indexes ?? []) this.db.exec(index);
      // Backfills are re-run on every open, not only on the first, so a corpus
      // written by a build that skipped a step is repaired on the next start.
      for (const statement of migration.backfills ?? []) this.db.exec(statement);
      if (changed) this.setMeta("schema_migration_version", String(migration.version));
    }
  }

  close(): void {
    this.db.close();
  }

  /* ---------------------------------------------------------------------- */
  /* Low level helpers                                                       */
  /* ---------------------------------------------------------------------- */

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already be rolled back by SQLite.
      }
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      value,
    );
  }

  getGeneration(): number {
    return Number.parseInt(this.getMeta("index_generation") ?? "0", 10);
  }

  bumpGeneration(): number {
    const next = this.getGeneration() + 1;
    this.setMeta("index_generation", String(next));
    return next;
  }

  recordFailure(code: string, message: string): void {
    this.stmt("INSERT INTO failures (code, message, at) VALUES (?, ?, ?)").run(code, message.slice(0, 500), isoNow());
    this.stmt("DELETE FROM failures WHERE id NOT IN (SELECT id FROM failures ORDER BY at DESC LIMIT 50)").run();
  }

  recentFailures(limit = 10): { code: string; message: string; at: string }[] {
    return (
      this.stmt("SELECT code, message, at FROM failures ORDER BY at DESC LIMIT ?").all(limit) as {
        code: string;
        message: string;
        at: string;
      }[]
    ).map((row) => ({ ...row }));
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP cache port                                                         */
  /* ---------------------------------------------------------------------- */

  read(url: string): HttpCacheEntry | undefined {
    const row = this.stmt(
      "SELECT url, etag, last_modified, status, content_type, body, fetched_at, expires_at FROM source_cache WHERE url = ?",
    ).get(url) as
      | {
          url: string;
          etag: string | null;
          last_modified: string | null;
          status: number;
          content_type: string | null;
          body: Uint8Array | null;
          fetched_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      url: row.url,
      etag: row.etag,
      lastModified: row.last_modified,
      status: row.status,
      contentType: row.content_type,
      body: row.body ?? new Uint8Array(),
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
    };
  }

  write(entry: HttpCacheEntry): void {
    this.stmt(
      `INSERT INTO source_cache (url, etag, last_modified, status, content_type, body, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         etag = excluded.etag, last_modified = excluded.last_modified, status = excluded.status,
         content_type = excluded.content_type, body = excluded.body, fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at`,
    ).run(
      entry.url,
      entry.etag,
      entry.lastModified,
      entry.status,
      entry.contentType,
      entry.body,
      entry.fetchedAt,
      entry.expiresAt,
    );
  }

  remove(url: string): void {
    this.stmt("DELETE FROM source_cache WHERE url = ?").run(url);
  }

  /* ---------------------------------------------------------------------- */
  /* Catalog                                                                 */
  /* ---------------------------------------------------------------------- */

  upsertCatalog(records: readonly CatalogRecord[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;
    this.transaction(() => {
      for (const record of records) {
        const hash = catalogHash(record);
        const existing = this.getCatalog(record.rfc);
        const payload: Record<string, string | number | null> = {
          rfc: record.rfc,
          document_id: record.document_id,
          title: record.title,
          abstract: record.abstract,
          published: record.published,
          pages: record.pages,
          status_json: jsonOrNull(record.status),
          stream_json: jsonOrNull(record.stream),
          area_json: jsonOrNull(record.area),
          group_json: jsonOrNull(record.group),
          keywords_json: JSON.stringify(record.keywords),
          authors_json: JSON.stringify(record.authors),
          obsoletes_json: JSON.stringify(record.obsoletes),
          obsoleted_by_json: JSON.stringify(record.obsoleted_by),
          updates_json: JSON.stringify(record.updates),
          updated_by_json: JSON.stringify(record.updated_by),
          subseries_json: JSON.stringify(record.subseries),
          identifiers_json: JSON.stringify(record.identifiers),
          formats_json: JSON.stringify(record.formats),
          doi: record.doi,
          canonical_url: record.canonical_url,
          source_url: record.source_url,
          observed_at: record.observed_at,
          content_hash: hash,
        };
        if (existing) {
          if (existing.content_hash === hash) continue;
          this.namedStmt(
            `UPDATE catalog SET document_id = :document_id, title = :title, abstract = :abstract, published = :published,
               pages = :pages, status_json = :status_json, stream_json = :stream_json, area_json = :area_json,
               group_json = :group_json, keywords_json = :keywords_json, authors_json = :authors_json,
               obsoletes_json = :obsoletes_json, obsoleted_by_json = :obsoleted_by_json, updates_json = :updates_json,
               updated_by_json = :updated_by_json, subseries_json = :subseries_json, identifiers_json = :identifiers_json,
               formats_json = :formats_json, doi = :doi, canonical_url = :canonical_url, source_url = :source_url,
               observed_at = :observed_at, content_hash = :content_hash
             WHERE rfc = :rfc`,
          ).run(payload);
          updated += 1;
        } else {
          this.namedStmt(
            `INSERT INTO catalog (rfc, document_id, title, abstract, published, pages, status_json, stream_json,
               area_json, group_json, keywords_json, authors_json, obsoletes_json, obsoleted_by_json, updates_json,
               updated_by_json, subseries_json, identifiers_json, formats_json, doi, canonical_url, source_url,
               observed_at, content_hash)
             VALUES (:rfc, :document_id, :title, :abstract, :published, :pages, :status_json, :stream_json,
               :area_json, :group_json, :keywords_json, :authors_json, :obsoletes_json, :obsoleted_by_json,
               :updates_json, :updated_by_json, :subseries_json, :identifiers_json, :formats_json, :doi,
               :canonical_url, :source_url, :observed_at, :content_hash)`,
          ).run(payload);
          inserted += 1;
        }
        this.stmt("DELETE FROM catalog_fts WHERE rfc = ?").run(record.rfc);
        this.stmt(
          `INSERT INTO catalog_fts (document_id, rfc, title, abstract, keywords, authors, status, stream)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.document_id,
          record.rfc,
          record.title,
          record.abstract ?? "",
          record.keywords.join(" "),
          record.authors.map((author) => author.name).join(" "),
          record.status?.name ?? "",
          record.stream?.name ?? "",
        );
      }
    });
    if (inserted + updated > 0) this.bumpGeneration();
    return { inserted, updated };
  }

  private namedStmt(sql: string): StatementSync {
    return this.stmt(sql);
  }

  getCatalog(rfc: number): CatalogRecord | null {
    const row = this.stmt("SELECT * FROM catalog WHERE rfc = ?").get(rfc) as unknown as CatalogRow | undefined;
    return row ? rowToCatalog(row) : null;
  }

  getCatalogMany(rfcs: readonly number[]): CatalogRecord[] {
    if (rfcs.length === 0) return [];
    const placeholders = rfcs.map(() => "?").join(",");
    const rows = this.stmt(`SELECT * FROM catalog WHERE rfc IN (${placeholders})`).all(
      ...rfcs,
    ) as unknown as CatalogRow[];
    return rows.map(rowToCatalog);
  }

  /** RFC numbers with a stored snapshot, ascending. The input to a corpus-wide re-analysis. */
  listIngestedRfcs(): number[] {
    return (
      this.stmt("SELECT DISTINCT rfc FROM snapshots WHERE format = 'txt' ORDER BY rfc").all() as unknown as {
        rfc: number;
      }[]
    ).map((row) => row.rfc);
  }

  /**
   * Where a retired snapshot id went, or null if it was never issued.
   *
   * A rule-version bump changes every snapshot id at once. A caller that pinned one
   * before the bump is holding a valid, verifiable citation against bytes that are
   * still on disk, and the useful answer is "that is RFC N, now derived as M", not a
   * bare "unknown snapshot".
   */
  getSnapshotRedirect(oldId: string): { new_id: string; rfc: number } | null {
    const row = this.stmt("SELECT new_id, rfc FROM snapshot_redirects WHERE old_id = ?").get(oldId) as
      { new_id: string; rfc: number } | undefined;
    return row ?? null;
  }

  countCatalog(): number {
    const row = this.stmt("SELECT COUNT(*) AS n FROM catalog").get() as { n: number };
    return row.n;
  }

  getTitles(rfcs: readonly number[]): Map<number, string> {
    const map = new Map<number, string>();
    for (const record of this.getCatalogMany(rfcs)) map.set(record.rfc, record.title);
    return map;
  }

  searchCatalog(query: {
    readonly match: string | null;
    readonly limit: number;
    readonly offset: number;
    readonly statuses?: readonly string[];
    readonly streams?: readonly string[];
    readonly rfcs?: readonly number[];
  }): { rows: CatalogRow[]; total: number } {
    const filters: string[] = [];
    const params: (string | number)[] = [];
    // The stored JSON carries both a slug ("std") and a display name ("internet
    // standard"), and the query grammar uses the slug, so both are accepted.
    const facet = (column: string, values: readonly string[]): void => {
      const match = values.map(() => "?").join(",");
      filters.push(
        `(json_extract(c.${column}, '$.slug') IN (${match}) OR json_extract(c.${column}, '$.name') IN (${match}))`,
      );
      params.push(...values, ...values);
    };
    if (query.statuses && query.statuses.length > 0) facet("status_json", query.statuses);
    if (query.streams && query.streams.length > 0) facet("stream_json", query.streams);
    if (query.rfcs && query.rfcs.length > 0) {
      filters.push(`c.rfc IN (${query.rfcs.map(() => "?").join(",")})`);
      params.push(...query.rfcs);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

    if (query.match) {
      // FTS5 requires the table name, not the `f` alias, as the left operand of MATCH
      // and as the argument of bm25(); the catalog filters are plain WHERE terms, so
      // they must be joined onto that same predicate rather than appended as a second
      // WHERE clause.
      const total = (
        this.stmt(
          `SELECT COUNT(*) AS n FROM catalog_fts f JOIN catalog c ON c.rfc = f.rfc
            WHERE catalog_fts MATCH ?${filters.length > 0 ? ` AND ${filters.join(" AND ")}` : ""}`,
        ).get(query.match, ...params) as { n: number }
      ).n;
      const rows = this.stmt(
        `SELECT c.*, bm25(catalog_fts) AS score FROM catalog_fts f JOIN catalog c ON c.rfc = f.rfc
         WHERE catalog_fts MATCH ?${filters.length > 0 ? ` AND ${filters.join(" AND ")}` : ""}
         ORDER BY score, c.rfc LIMIT ? OFFSET ?`,
      ).all(query.match, ...params, query.limit, query.offset) as unknown as CatalogRow[];
      return { rows, total };
    }

    const total = (this.stmt(`SELECT COUNT(*) AS n FROM catalog c ${where}`).get(...params) as { n: number }).n;
    const rows = this.stmt(`SELECT c.*, 0 AS score FROM catalog c ${where} ORDER BY c.rfc LIMIT ? OFFSET ?`).all(
      ...params,
      query.limit,
      query.offset,
    ) as unknown as CatalogRow[];
    return { rows, total };
  }

  allCatalogNumbers(): number[] {
    return (this.stmt("SELECT rfc FROM catalog ORDER BY rfc").all() as { rfc: number }[]).map((row) => row.rfc);
  }

  /* ---------------------------------------------------------------------- */
  /* Documents                                                               */
  /* ---------------------------------------------------------------------- */

  commitDocument(bundle: DocumentBundle): { snapshotId: string; changed: boolean; generation: number } {
    let changed = false;
    const generation = this.transaction(() => {
      const recordHash = catalogHash(bundle.record);
      this.upsertCatalogInner({ ...bundle.record, content_hash: recordHash });
      const existing = this.stmt(
        `SELECT id FROM snapshots
          WHERE rfc = ? AND format = ? AND raw_sha256 = ? AND metadata_hash = ?
            AND parser_version = ? AND extractor_version = ?`,
      ).get(
        bundle.snapshot.rfc,
        bundle.snapshot.format,
        bundle.snapshot.rawSha256,
        bundle.snapshot.metadataHash,
        bundle.snapshot.parserVersion,
        bundle.snapshot.extractorVersion,
      ) as { id: string } | undefined;

      if (existing) {
        this.stmt("UPDATE snapshots SET retrieved_at = ?, etag = ?, last_modified = ? WHERE id = ?").run(
          bundle.snapshot.retrievedAt,
          bundle.snapshot.etag,
          bundle.snapshot.lastModified,
          existing.id,
        );
        this.putAssetInner(existing.id, bundle.snapshot.format, {
          format: bundle.snapshot.format,
          contentType: bundle.snapshot.format === "xml" ? "application/rfc+xml" : "text/plain",
          bytes: bundle.snapshot.bytes,
          sha256: `sha256:${bundle.snapshot.rawSha256}`,
          body: bundle.snapshot.raw,
          retrievedAt: bundle.snapshot.retrievedAt,
          sourceUrl: bundle.snapshot.sourceUrl,
          etag: bundle.snapshot.etag,
          lastModified: bundle.snapshot.lastModified,
          warnings: [],
        });
        return this.getGeneration();
      }

      // FTS5 virtual tables do not participate in foreign-key enforcement, so the
      // cascade from the catalog row never reaches blocks_fts. Without this purge
      // every re-ingest leaks a full text index of the replaced snapshot, which
      // inflates result totals, skews bm25 term statistics and keeps advertising
      // blocks of a snapshot that no longer exists. Purging per RFC rather than per
      // snapshot id also removes rows leaked by earlier generations under an id that
      // the new snapshot reproduces, which would otherwise double every hit.
      this.stmt("DELETE FROM blocks_fts WHERE rfc = ?").run(bundle.snapshot.rfc);
      // Record where the ids being retired went, before they are gone. Same
      // transaction as the delete, so a crash cannot leave a redirect to nothing.
      const retired = this.stmt("SELECT id FROM snapshots WHERE rfc = ? AND id != ?").all(
        bundle.snapshot.rfc,
        bundle.snapshot.id,
      ) as unknown as { id: string }[];
      for (const row of retired) {
        this.stmt(
          `INSERT INTO snapshot_redirects (old_id, new_id, rfc, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(old_id) DO UPDATE SET new_id = excluded.new_id, created_at = excluded.created_at`,
        ).run(row.id, bundle.snapshot.id, bundle.snapshot.rfc, isoNow());
      }
      this.stmt("DELETE FROM snapshots WHERE rfc = ?").run(bundle.snapshot.rfc);
      this.stmt(
        `INSERT INTO snapshots (id, rfc, format, raw_sha256, bytes, raw, retrieved_at, source_url, etag, last_modified,
           parser_version, extractor_version, quality, warnings_json, metadata_hash, section_count, block_count,
           requirement_count, reference_count, prose_block_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bundle.snapshot.id,
        bundle.snapshot.rfc,
        bundle.snapshot.format,
        bundle.snapshot.rawSha256,
        bundle.snapshot.bytes,
        bundle.snapshot.raw,
        bundle.snapshot.retrievedAt,
        bundle.snapshot.sourceUrl,
        bundle.snapshot.etag,
        bundle.snapshot.lastModified,
        bundle.snapshot.parserVersion,
        bundle.snapshot.extractorVersion,
        bundle.snapshot.quality,
        JSON.stringify(bundle.snapshot.warnings),
        bundle.snapshot.metadataHash,
        bundle.sections.length,
        bundle.blocks.length,
        bundle.requirements.length,
        bundle.references.length,
        countProseBlocks(bundle.blocks, bundle.sections),
      );

      for (const section of bundle.sections) {
        this.stmt(
          `INSERT INTO sections (snapshot_id, id, rfc, number, title, kind, parent_id, ordinal, path_json, text,
             text_sha256, byte_start, byte_end, char_start, char_end, codepoint_start, codepoint_end, line_start, line_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          bundle.snapshot.id,
          section.id,
          section.rfc,
          section.number,
          section.title,
          section.kind,
          section.parent_id,
          section.ordinal,
          JSON.stringify(section.path),
          section.text,
          section.text_sha256,
          section.byte_start,
          section.byte_end,
          section.char_start,
          section.char_end,
          section.codepoint_start,
          section.codepoint_end,
          section.line_start,
          section.line_end,
        );
      }

      const insertBlock = this.stmt(
        `INSERT INTO blocks (snapshot_id, id, rfc, section_id, ordinal, kind, text, text_sha256, byte_start, byte_end,
           char_start, char_end, codepoint_start, codepoint_end, line_start, line_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.stmt(
        "INSERT INTO blocks_fts (snapshot_id, block_id, section_id, rfc, text) VALUES (?, ?, ?, ?, ?)",
      );
      for (const block of bundle.blocks) {
        insertBlock.run(
          bundle.snapshot.id,
          block.id,
          block.rfc,
          block.section_id,
          block.ordinal,
          block.kind,
          block.text,
          block.text_sha256,
          block.byte_start,
          block.byte_end,
          block.char_start,
          block.char_end,
          block.codepoint_start,
          block.codepoint_end,
          block.line_start,
          block.line_end,
        );
        insertFts.run(bundle.snapshot.id, block.id, block.section_id, block.rfc, block.text);
      }

      const insertMention = this.stmt(
        `INSERT INTO mentions (id, snapshot_id, rfc, section_id, block_id, term, strength, polarity, exact_text, context,
           disposition, flags_json, citation_id, char_start, char_end, byte_start, byte_end, codepoint_start,
           codepoint_end, line_start, line_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const mention of bundle.mentions) {
        insertMention.run(
          mention.id,
          bundle.snapshot.id,
          mention.rfc,
          mention.section_id,
          mention.block_id,
          mention.term,
          mention.strength,
          mention.polarity,
          mention.exact_text,
          mention.context,
          mention.disposition,
          JSON.stringify(mention.flags),
          mention.citation_id,
          mention.span.char_start,
          mention.span.char_end,
          mention.span.byte_start,
          mention.span.byte_end,
          mention.span.codepoint_start,
          mention.span.codepoint_end,
          mention.span.line_start,
          mention.span.line_end,
        );
      }

      const insertRequirement = this.stmt(
        `INSERT INTO requirements (id, snapshot_id, rfc, section_id, block_id, term, strength, polarity, exact_text,
           citation_id, parse_status, confidence, actor, condition_text, action, exception_text, flags_json,
           char_start, char_end, byte_start, byte_end, codepoint_start, codepoint_end, line_start, line_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const requirement of bundle.requirements) {
        insertRequirement.run(
          requirement.id,
          bundle.snapshot.id,
          requirement.rfc,
          requirement.section_id,
          requirement.block_id,
          requirement.term,
          requirement.strength,
          requirement.polarity,
          requirement.exact_text,
          requirement.citation_id,
          requirement.parse_status,
          requirement.confidence,
          requirement.clause.actor,
          requirement.clause.condition,
          requirement.clause.action,
          requirement.clause.exception,
          JSON.stringify(requirement.flags),
          requirement.span.char_start,
          requirement.span.char_end,
          requirement.span.byte_start,
          requirement.span.byte_end,
          requirement.span.codepoint_start,
          requirement.span.codepoint_end,
          requirement.span.line_start,
          requirement.span.line_end,
        );
      }

      const insertReference = this.stmt(
        `INSERT INTO rfc_references (id, snapshot_id, rfc, section_id, ordinal, label, raw_text, relation, target_kind,
           target, target_rfc, resolution, external_kind, external_id, external_publisher, external_year, cited_by_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertReferenceCitation = this.stmt(
        `INSERT OR REPLACE INTO reference_citations (snapshot_id, reference_id, block_id, relation, char_start)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const reference of bundle.references) {
        insertReference.run(
          reference.id,
          bundle.snapshot.id,
          reference.rfc,
          reference.section_id,
          reference.ordinal,
          reference.label,
          reference.raw_text,
          reference.relation,
          reference.target_kind,
          reference.target,
          reference.target_rfc,
          reference.resolution,
          reference.external?.kind ?? null,
          reference.external?.id ?? null,
          reference.external?.publisher ?? null,
          reference.external?.year ?? null,
          JSON.stringify(reference.cited_by),
        );
        for (const site of reference.cited_by) {
          insertReferenceCitation.run(bundle.snapshot.id, reference.id, site.block_id, reference.relation, site.offset);
        }
      }

      for (const asset of bundle.assets ?? []) {
        this.putAssetInner(bundle.snapshot.id, asset.format, asset);
      }
      changed = true;
      return this.getGeneration() + 1;
    });

    if (changed) this.setMeta("index_generation", String(generation));
    if (changed) this.setMeta("last_document_sync", isoNow());
    return { snapshotId: bundle.snapshot.id, changed, generation: this.getGeneration() };
  }

  private upsertCatalogInner(record: CatalogRecord): void {
    const hash = catalogHash(record);
    const payload: Record<string, string | number | null> = {
      rfc: record.rfc,
      document_id: record.document_id,
      title: record.title,
      abstract: record.abstract,
      published: record.published,
      pages: record.pages,
      status_json: jsonOrNull(record.status),
      stream_json: jsonOrNull(record.stream),
      area_json: jsonOrNull(record.area),
      group_json: jsonOrNull(record.group),
      keywords_json: JSON.stringify(record.keywords),
      authors_json: JSON.stringify(record.authors),
      obsoletes_json: JSON.stringify(record.obsoletes),
      obsoleted_by_json: JSON.stringify(record.obsoleted_by),
      updates_json: JSON.stringify(record.updates),
      updated_by_json: JSON.stringify(record.updated_by),
      subseries_json: JSON.stringify(record.subseries),
      identifiers_json: JSON.stringify(record.identifiers),
      formats_json: JSON.stringify(record.formats),
      doi: record.doi,
      canonical_url: record.canonical_url,
      source_url: record.source_url,
      observed_at: record.observed_at,
      content_hash: hash,
    };
    // A metadata refresh must update the row in place. `snapshots.rfc` references
    // `catalog(rfc)` with ON DELETE CASCADE, so deleting and re-inserting the row
    // silently destroys every pinned snapshot, section, block, requirement and asset
    // of that document while its text index survives — one catalog sync would wipe
    // the whole evidence corpus.
    const columns = Object.keys(payload);
    const updates = columns.filter((column) => column !== "rfc").map((column) => `${column} = :${column}`);
    this.stmt(
      `INSERT INTO catalog (${columns.join(", ")})
         VALUES (${columns.map((column) => `:${column}`).join(", ")})
       ON CONFLICT(rfc) DO UPDATE SET ${updates.join(", ")}`,
    ).run(payload);
    this.stmt("DELETE FROM catalog_fts WHERE rfc = ?").run(record.rfc);
    this.stmt(
      `INSERT INTO catalog_fts (document_id, rfc, title, abstract, keywords, authors, status, stream)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.document_id,
      record.rfc,
      record.title,
      record.abstract ?? "",
      record.keywords.join(" "),
      record.authors.map((author) => author.name).join(" "),
      record.status?.name ?? "",
      record.stream?.name ?? "",
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Snapshots                                                               */
  /* ---------------------------------------------------------------------- */

  getLatestSnapshot(rfc: number, format: "txt" | "xml" = "txt"): Snapshot | null {
    const row = this.stmt(
      "SELECT * FROM snapshots WHERE rfc = ? AND format = ? ORDER BY retrieved_at DESC LIMIT 1",
    ).get(rfc, format) as unknown as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  getSnapshot(id: string): Snapshot | null {
    const row = this.stmt("SELECT * FROM snapshots WHERE id = ?").get(id) as unknown as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  getSnapshotRaw(id: string): Buffer | null {
    const row = this.stmt("SELECT raw FROM snapshots WHERE id = ?").get(id) as { raw: Uint8Array } | undefined;
    return row ? Buffer.from(row.raw) : null;
  }

  listSnapshots(rfc: number): Snapshot[] {
    return (
      this.stmt("SELECT * FROM snapshots WHERE rfc = ? ORDER BY retrieved_at DESC").all(rfc) as unknown as SnapshotRow[]
    ).map(rowToSnapshot);
  }

  /**
   * Whether a snapshot for this exact identity already exists. The rule versions are
   * part of the identity: without them a version bump would look like unchanged
   * content, the stored analysis would be reused under new rules, and `reanalyze`
   * would report a new snapshot id that was never written.
   */
  hasSnapshotContent(
    rfc: number,
    format: string,
    rawSha256: string,
    metadataHash: string,
    parserVersion: string,
    extractorVersion: string,
  ): boolean {
    const row = this.stmt(
      `SELECT id FROM snapshots
        WHERE rfc = ? AND format = ? AND raw_sha256 = ? AND metadata_hash = ?
          AND parser_version = ? AND extractor_version = ?`,
    ).get(rfc, format, rawSha256, metadataHash, parserVersion, extractorVersion) as { id: string } | undefined;
    return row !== undefined;
  }

  putAsset(snapshotId: string, asset: SourceAsset): void {
    this.transaction(() => this.putAssetInner(snapshotId, asset.format, asset));
  }

  private putAssetInner(snapshotId: string, format: string, asset: SourceAsset): void {
    this.stmt(
      `INSERT INTO assets (snapshot_id, format, raw_sha256, bytes, body, content_type, retrieved_at, source_url, etag, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_id, format) DO UPDATE SET
         raw_sha256 = excluded.raw_sha256, bytes = excluded.bytes, body = excluded.body,
         content_type = excluded.content_type, retrieved_at = excluded.retrieved_at, source_url = excluded.source_url,
         etag = excluded.etag, last_modified = excluded.last_modified`,
    ).run(
      snapshotId,
      format,
      asset.sha256,
      asset.bytes,
      asset.body,
      asset.contentType,
      asset.retrievedAt,
      asset.sourceUrl,
      asset.etag,
      asset.lastModified,
    );
  }

  getAsset(snapshotId: string, format: string): (SourceAsset & { body: Buffer }) | null {
    const row = this.stmt("SELECT * FROM assets WHERE snapshot_id = ? AND format = ?").get(snapshotId, format) as
      | {
          snapshot_id: string;
          format: string;
          raw_sha256: string;
          bytes: number;
          body: Uint8Array;
          content_type: string;
          retrieved_at: string;
          source_url: string;
          etag: string | null;
          last_modified: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      format: row.format,
      contentType: row.content_type,
      bytes: row.bytes,
      sha256: row.raw_sha256,
      body: Buffer.from(row.body),
      retrievedAt: row.retrieved_at,
      sourceUrl: row.source_url,
      etag: row.etag,
      lastModified: row.last_modified,
      warnings: [],
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Sections, blocks                                                        */
  /* ---------------------------------------------------------------------- */

  getSections(snapshotId: string): Section[] {
    return (
      this.stmt("SELECT * FROM sections WHERE snapshot_id = ? ORDER BY ordinal").all(
        snapshotId,
      ) as unknown as SectionRow[]
    ).map(rowToSection);
  }

  getOutline(snapshotId: string): Section[] {
    return this.getSections(snapshotId);
  }

  getSectionByNumber(snapshotId: string, number: string): Section | null {
    const row = this.stmt("SELECT * FROM sections WHERE snapshot_id = ? AND number = ? ORDER BY ordinal LIMIT 1").get(
      snapshotId,
      number,
    ) as unknown as SectionRow | undefined;
    return row ? rowToSection(row) : null;
  }

  getSectionById(snapshotId: string, id: string): Section | null {
    const row = this.stmt("SELECT * FROM sections WHERE snapshot_id = ? AND id = ?").get(snapshotId, id) as
      SectionRow | undefined;
    return row ? rowToSection(row) : null;
  }

  getBlock(snapshotId: string, blockId: string): Block | null {
    const row = this.stmt("SELECT * FROM blocks WHERE snapshot_id = ? AND id = ?").get(snapshotId, blockId) as
      BlockRow | undefined;
    return row ? rowToBlock(row) : null;
  }

  /** Every block of a snapshot, in document order. Bounded by the document itself. */
  listBlocks(snapshotId: string): Block[] {
    return (this.stmt("SELECT * FROM blocks WHERE snapshot_id = ? ORDER BY ordinal").all(snapshotId) as BlockRow[]).map(
      rowToBlock,
    );
  }

  getBlocksForSection(snapshotId: string, sectionId: string): Block[] {
    return (
      this.stmt("SELECT * FROM blocks WHERE snapshot_id = ? AND section_id = ? ORDER BY ordinal").all(
        snapshotId,
        sectionId,
      ) as BlockRow[]
    ).map(rowToBlock);
  }

  countSections(snapshotId: string): number {
    return (this.stmt("SELECT COUNT(*) AS n FROM sections WHERE snapshot_id = ?").get(snapshotId) as { n: number }).n;
  }

  /* ---------------------------------------------------------------------- */
  /* Search                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Shared FTS5 predicates for `searchBlocks` and `countBlockMatches`, so a reported
   * total can never drift from the rows that are actually returned.
   *
   * Both spellings below are load-bearing: FTS5 accepts only the table name, not the
   * `f` alias, as the left operand of MATCH and as the argument of bm25(), while a
   * correlated reference from inside a subquery must use the alias the outer query
   * declares. Qualifying the subquery with the table name instead of the alias makes
   * SQLite fail to resolve it.
   */
  private ftsFilters(query: SearchQuery): { conditions: string[]; params: (string | number)[] } {
    const conditions = [
      "blocks_fts MATCH ?",
      // Defence in depth: a hit may only cite a snapshot that still exists, otherwise
      // the caller receives a snapshot_id that read() and verify_citation reject.
      "snapshot_id IN (SELECT id FROM snapshots)",
    ];
    const params: (string | number)[] = [query.match];
    if (query.rfcs.length > 0) {
      conditions.push(`rfc IN (${query.rfcs.map(() => "?").join(",")})`);
      params.push(...query.rfcs);
    }
    if (query.blockKinds && query.blockKinds.length > 0) {
      conditions.push(
        `block_id IN (SELECT id FROM blocks WHERE snapshot_id = f.snapshot_id AND kind IN (${query.blockKinds
          .map(() => "?")
          .join(",")}))`,
      );
      params.push(...query.blockKinds);
    }
    if (query.sectionPrefix) {
      conditions.push(
        `section_id IN (SELECT id FROM sections WHERE snapshot_id = f.snapshot_id AND (number = ? OR number LIKE ?))`,
      );
      params.push(query.sectionPrefix, `${query.sectionPrefix}.%`);
    }
    if (query.relation) {
      conditions.push(
        `block_id IN (SELECT block_id FROM reference_citations WHERE snapshot_id = f.snapshot_id AND relation = ?)`,
      );
      params.push(query.relation);
    }
    return { conditions, params };
  }

  searchBlocks(query: SearchQuery): BlockSearchRow[] {
    const { conditions, params } = this.ftsFilters(query);
    const rows = this.stmt(
      `SELECT f.rfc AS rfc, f.snapshot_id AS snapshot_id, f.block_id AS block_id, f.section_id AS section_id,
              f.text AS text, bm25(blocks_fts) AS score, rank AS rank
         FROM blocks_fts f
        WHERE ${conditions.join(" AND ")}
        ORDER BY score, f.rfc, f.block_id
        LIMIT ? OFFSET ?`,
    ).all(...params, query.limit, query.offset) as {
      rfc: number;
      snapshot_id: string;
      block_id: string;
      section_id: string;
      text: string;
      score: number;
      rank: number;
    }[];
    const sections = new Map<string, { path: string[]; number: string; title: string }>();
    for (const snapshotId of new Set(rows.map((row) => row.snapshot_id))) {
      for (const section of this.getSections(snapshotId)) {
        sections.set(`${snapshotId}:${section.id}`, {
          path: [...section.path],
          number: section.number,
          title: section.title,
        });
      }
    }
    const titles = this.getTitles([...new Set(rows.map((row) => row.rfc))]);
    return rows.map((row) => ({
      rfc: row.rfc,
      title: titles.get(row.rfc) ?? `RFC ${row.rfc}`,
      snapshot_id: row.snapshot_id,
      block_id: row.block_id,
      section_id: row.section_id,
      section_path: sections.get(`${row.snapshot_id}:${row.section_id}`)?.path ?? [],
      text: row.text,
      score: row.score,
      rank: row.rank,
    }));
  }

  countBlockMatches(query: SearchQuery): number {
    const { conditions, params } = this.ftsFilters(query);
    const row = this.stmt(`SELECT COUNT(*) AS n FROM blocks_fts f WHERE ${conditions.join(" AND ")}`).get(
      ...params,
    ) as { n: number };
    return row.n;
  }

  /* ---------------------------------------------------------------------- */
  /* Analysis results                                                        */
  /* ---------------------------------------------------------------------- */

  getRequirements(
    snapshotId: string,
    filter: { term?: string; sectionPrefix?: string | null; limit: number; offset: number },
  ): Requirement[] {
    const conditions = ["snapshot_id = ?"];
    const params: (string | number)[] = [snapshotId];
    if (filter.term) {
      conditions.push("term = ?");
      params.push(filter.term);
    }
    if (filter.sectionPrefix) {
      conditions.push(
        `section_id IN (SELECT id FROM sections WHERE snapshot_id = ? AND (number = ? OR number LIKE ?))`,
      );
      params.push(snapshotId, filter.sectionPrefix, `${filter.sectionPrefix}.%`);
    }
    const rows = this.stmt(
      `SELECT * FROM requirements WHERE ${conditions.join(" AND ")} ORDER BY char_start, id LIMIT ? OFFSET ?`,
    ).all(...params, filter.limit, filter.offset) as unknown as RequirementRow[];
    return rows.map((row) => rowToRequirement(row, snapshotId));
  }

  countRequirements(snapshotId: string, filter: { term?: string; sectionPrefix?: string | null }): number {
    const conditions = ["snapshot_id = ?"];
    const params: (string | number)[] = [snapshotId];
    if (filter.term) {
      conditions.push("term = ?");
      params.push(filter.term);
    }
    if (filter.sectionPrefix) {
      conditions.push(
        `section_id IN (SELECT id FROM sections WHERE snapshot_id = ? AND (number = ? OR number LIKE ?))`,
      );
      params.push(snapshotId, filter.sectionPrefix, `${filter.sectionPrefix}.%`);
    }
    const row = this.stmt(`SELECT COUNT(*) AS n FROM requirements WHERE ${conditions.join(" AND ")}`).get(
      ...params,
    ) as { n: number };
    return row.n;
  }

  getRequirementById(snapshotId: string, id: string): Requirement | null {
    const row = this.stmt("SELECT * FROM requirements WHERE snapshot_id = ? AND id = ?").get(snapshotId, id) as
      RequirementRow | undefined;
    return row ? rowToRequirement(row, snapshotId) : null;
  }

  getMentions(snapshotId: string, limit: number): NormativeMention[] {
    return (
      this.stmt("SELECT * FROM mentions WHERE snapshot_id = ? ORDER BY char_start LIMIT ?").all(
        snapshotId,
        limit,
      ) as unknown as MentionRow[]
    ).map((row) => rowToMention(row, snapshotId));
  }

  /**
   * Blocks whose text contains an RFC 2119 keyword in any case.
   *
   * `requirements` is the strict, upper-case-only reading of RFC 8174. A zero there
   * is ambiguous on its own: RFC 1035 writes "Z  Reserved for future use.  Must be
   * zero", and RFC 4033 writes a lower-case "must" throughout. Both are normative
   * to an implementer and neither is a requirement by the letter of the spec. The
   * candidates have to be reachable, or a caller can only conclude "no norms" from
   * a number that means "no upper-case norms".
   */
  listBlocksWithKeywords(snapshotId: string, limit = 5000): Block[] {
    return (
      this.stmt(
        `SELECT * FROM blocks
          WHERE snapshot_id = ?
            AND (lower(text) LIKE '%must%' OR lower(text) LIKE '%shall%' OR lower(text) LIKE '%should%'
                 OR lower(text) LIKE '%may%' OR lower(text) LIKE '%required%' OR lower(text) LIKE '%recommend%'
                 OR lower(text) LIKE '%optional%')
          ORDER BY ordinal
          LIMIT ?`,
      ).all(snapshotId, limit) as unknown as BlockRow[]
    ).map(rowToBlock);
  }

  getReferences(
    snapshotId: string,
    filter: { relation?: string; resolution?: string; label?: string; limit: number; offset: number },
  ): ReferenceRecord[] {
    const conditions = ["snapshot_id = ?"];
    const params: (string | number)[] = [snapshotId];
    if (filter.relation) {
      conditions.push("relation = ?");
      params.push(filter.relation);
    }
    if (filter.resolution) {
      conditions.push("resolution = ?");
      params.push(filter.resolution);
    }
    if (filter.label) {
      conditions.push("label = ?");
      params.push(filter.label);
    }
    const rows = this.stmt(
      `SELECT * FROM rfc_references WHERE ${conditions.join(" AND ")} ORDER BY ordinal, id LIMIT ? OFFSET ?`,
    ).all(...params, filter.limit, filter.offset) as unknown as ReferenceRow[];
    return rows.map((row) => rowToReference(row, snapshotId));
  }

  countReferences(snapshotId: string, filter: { relation?: string; resolution?: string }): number {
    const conditions = ["snapshot_id = ?"];
    const params: (string | number)[] = [snapshotId];
    if (filter.relation) {
      conditions.push("relation = ?");
      params.push(filter.relation);
    }
    if (filter.resolution) {
      conditions.push("resolution = ?");
      params.push(filter.resolution);
    }
    const row = this.stmt(`SELECT COUNT(*) AS n FROM rfc_references WHERE ${conditions.join(" AND ")}`).get(
      ...params,
    ) as { n: number };
    return row.n;
  }

  findCitationMatches(
    snapshotId: string,
    input: { quoteSha256?: string; blockId?: string; charStart?: number; citationId?: string },
    limit: number,
  ): {
    mention_id: string | null;
    block_id: string;
    section_id: string;
    char_start: number;
    exact_text: string;
    citation_id: string;
    kind: "requirement" | "mention";
  }[] {
    const results: {
      mention_id: string | null;
      block_id: string;
      section_id: string;
      char_start: number;
      exact_text: string;
      citation_id: string;
      kind: "requirement" | "mention";
    }[] = [];
    if (input.citationId) {
      for (const table of ["requirements", "mentions"] as const) {
        const candidates = this.stmt(
          `SELECT id, block_id, section_id, char_start, exact_text, citation_id FROM ${table} WHERE snapshot_id = ? AND citation_id = ?`,
        ).all(snapshotId, input.citationId) as {
          id: string;
          block_id: string;
          section_id: string;
          char_start: number;
          exact_text: string;
          citation_id: string;
        }[];
        for (const candidate of candidates) {
          results.push({
            mention_id: candidate.id,
            block_id: candidate.block_id,
            section_id: candidate.section_id,
            char_start: candidate.char_start,
            exact_text: candidate.exact_text,
            citation_id: candidate.citation_id,
            kind: table === "requirements" ? "requirement" : "mention",
          });
        }
      }
    }
    if (input.quoteSha256) {
      const hash = input.quoteSha256.replace(/^sha256:/u, "");
      for (const table of ["requirements", "mentions"] as const) {
        const candidates = this.stmt(
          `SELECT id, block_id, section_id, char_start, exact_text, citation_id FROM ${table} WHERE snapshot_id = ?`,
        ).all(snapshotId) as {
          id: string;
          block_id: string;
          section_id: string;
          char_start: number;
          exact_text: string;
          citation_id: string;
        }[];
        for (const candidate of candidates) {
          if (sha256Hex(candidate.exact_text) === hash) {
            results.push({
              mention_id: candidate.id,
              block_id: candidate.block_id,
              section_id: candidate.section_id,
              char_start: candidate.char_start,
              exact_text: candidate.exact_text,
              citation_id: candidate.citation_id,
              kind: table === "requirements" ? "requirement" : "mention",
            });
          }
        }
      }
    }
    if (input.blockId) {
      const block = this.getBlock(snapshotId, input.blockId);
      if (block) {
        results.push({
          mention_id: null,
          block_id: block.id,
          section_id: block.section_id,
          char_start: block.char_start,
          exact_text: block.text,
          citation_id: `cit_block_${shortHash(`${snapshotId}|${block.id}`)}`,
          kind: "mention",
        });
      }
    }
    if (input.charStart !== undefined) {
      const rows = this.stmt(
        "SELECT id, block_id, section_id, char_start, exact_text, citation_id FROM mentions WHERE snapshot_id = ? AND char_start = ?",
      ).all(snapshotId, input.charStart) as {
        id: string;
        block_id: string;
        section_id: string;
        char_start: number;
        exact_text: string;
        citation_id: string;
      }[];
      for (const row of rows) {
        results.push({
          mention_id: row.id,
          block_id: row.block_id,
          section_id: row.section_id,
          char_start: row.char_start,
          exact_text: row.exact_text,
          citation_id: row.citation_id,
          kind: "mention",
        });
      }
    }
    const deduped = (() => {
      const requirementCitations = new Set(
        results.filter((row) => row.kind === "requirement").map((row) => row.citation_id),
      );
      return results.filter((row) => row.kind === "requirement" || !requirementCitations.has(row.citation_id));
    })();
    const filtered = input.citationId
      ? deduped
      : deduped
          .filter((row) => (input.blockId ? row.block_id === input.blockId : true))
          .filter((row) => (input.charStart === undefined ? true : row.char_start === input.charStart || row.block_id));
    return filtered.slice(0, limit);
  }

  /* ---------------------------------------------------------------------- */
  /* Relations, errata, history                                              */
  /* ---------------------------------------------------------------------- */

  replaceRelations(
    rfc: number,
    relations: readonly {
      relation: string;
      target_rfc: number;
      source: string;
      evidence: unknown;
      observed_at: string;
    }[],
  ): void {
    this.transaction(() => {
      this.stmt("DELETE FROM relations WHERE rfc = ?").run(rfc);
      const insert = this.stmt(
        `INSERT INTO relations (rfc, direction, relation, target_rfc, source, evidence_json, observed_at)
         VALUES (?, 'outgoing', ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      );
      for (const relation of relations) {
        insert.run(
          rfc,
          relation.relation,
          relation.target_rfc,
          relation.source,
          jsonOrNull(relation.evidence),
          relation.observed_at,
        );
      }
    });
    this.bumpGeneration();
  }

  getRelations(
    rfc: number,
  ): { relation: string; target_rfc: number; source: string; evidence: unknown; observed_at: string }[] {
    return (
      this.stmt(
        "SELECT relation, target_rfc, source, evidence_json, observed_at FROM relations WHERE rfc = ? ORDER BY relation, target_rfc",
      ).all(rfc) as {
        relation: string;
        target_rfc: number;
        source: string;
        evidence_json: string | null;
        observed_at: string;
      }[]
    ).map((row) => ({
      relation: row.relation,
      target_rfc: row.target_rfc,
      source: row.source,
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
      observed_at: row.observed_at,
    }));
  }

  replaceErrata(rfc: number, errata: readonly Erratum[]): void {
    this.transaction(() => {
      this.stmt("DELETE FROM errata WHERE rfc = ?").run(rfc);
      const insert = this.stmt(
        `INSERT INTO errata (rfc, errata_id, status, type, section, original_text, corrected_text, notes, submitted_at, updated_at, url, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = isoNow();
      for (const item of errata) {
        insert.run(
          rfc,
          item.errata_id,
          item.status,
          item.type,
          item.section,
          item.original_text,
          item.corrected_text,
          item.notes,
          item.submitted_at,
          item.updated_at,
          item.url,
          now,
        );
      }
    });
    this.bumpGeneration();
  }

  getErrata(rfc: number, status: string | null, limit: number, offset: number): { rows: Erratum[]; total: number } {
    const conditions = ["rfc = ?"];
    const params: (string | number)[] = [rfc];
    const filter = errataStatusFilter(status);
    if (filter) {
      conditions.push(filter.clause);
      params.push(filter.parameter);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const total = (this.stmt(`SELECT COUNT(*) AS n FROM errata ${where}`).get(...params) as { n: number }).n;
    const rows = this.stmt(`SELECT * FROM errata ${where} ORDER BY errata_id LIMIT ? OFFSET ?`).all(
      ...params,
      limit,
      offset,
    ) as unknown as ErrataRow[];
    return { rows: rows.map(rowToErratum), total };
  }

  hasErrata(rfc: number): boolean {
    return (this.stmt("SELECT COUNT(*) AS n FROM errata WHERE rfc = ?").get(rfc) as { n: number }).n > 0;
  }

  /**
   * Errata counts per canonical status, computed over every stored row.
   *
   * Two facts are impossible to learn from a filtered result set: which statuses
   * exist at all, and whether an empty answer means "none of that status" or
   * "none at all". `errata` reports this map next to every filtered answer so an
   * empty list is never ambiguous.
   */
  countErrataByStatus(rfc: number): Record<string, number> {
    const rows = this.stmt(
      `SELECT lower(replace(replace(status, ' ', '_'), '-', '_')) AS status, COUNT(*) AS n
         FROM errata WHERE rfc = ? GROUP BY status`,
    ).all(rfc) as unknown as { status: string; n: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const status = canonicalErrataStatus(row.status);
      counts[status] = (counts[status] ?? 0) + row.n;
    }
    return counts;
  }

  replaceHistory(rfc: number, entries: readonly HistoryEntry[]): void {
    this.transaction(() => {
      this.stmt("DELETE FROM history WHERE rfc = ?").run(rfc);
      const insert = this.stmt(
        "INSERT INTO history (id, rfc, title, summary, published_at, author, url, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const now = isoNow();
      for (const entry of entries) {
        insert.run(entry.id, rfc, entry.title, entry.summary, entry.published_at, entry.author, entry.url, now);
      }
    });
  }

  getHistory(rfc: number, limit: number, offset: number): { rows: HistoryEntry[]; total: number } {
    const total = (this.stmt("SELECT COUNT(*) AS n FROM history WHERE rfc = ?").get(rfc) as { n: number }).n;
    const rows = this.stmt(
      "SELECT id, rfc, title, summary, published_at, author, url FROM history WHERE rfc = ? ORDER BY published_at DESC, id LIMIT ? OFFSET ?",
    ).all(rfc, limit, offset) as unknown as HistoryRow[];
    return { rows: rows.map(rowToHistory), total };
  }

  hasHistory(rfc: number): boolean {
    return (this.stmt("SELECT COUNT(*) AS n FROM history WHERE rfc = ?").get(rfc) as { n: number }).n > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Status                                                                  */
  /* ---------------------------------------------------------------------- */

  status(): {
    index_generation: number;
    catalog: number;
    snapshots: number;
    with_requirements: number;
    sections: number;
    blocks: number;
    requirements: number;
    references: number;
    errata: number;
    parser_versions: string[];
    extractor_versions: string[];
    last_document_sync: string | null;
    last_catalog_sync: string | null;
  } {
    const count = (sql: string, ...params: (string | number)[]): number =>
      (this.stmt(sql).get(...params) as { n: number }).n;
    const versions = (sql: string): string[] =>
      (this.stmt(sql).all() as { version: string }[]).map((row) => row.version);
    return {
      index_generation: this.getGeneration(),
      catalog: count("SELECT COUNT(*) AS n FROM catalog"),
      snapshots: count("SELECT COUNT(*) AS n FROM snapshots"),
      with_requirements: count("SELECT COUNT(DISTINCT snapshot_id) AS n FROM requirements"),
      sections: count("SELECT COUNT(*) AS n FROM sections"),
      blocks: count("SELECT COUNT(*) AS n FROM blocks"),
      requirements: count("SELECT COUNT(*) AS n FROM requirements"),
      references: count("SELECT COUNT(*) AS n FROM rfc_references"),
      errata: count("SELECT COUNT(*) AS n FROM errata"),
      parser_versions: versions("SELECT DISTINCT parser_version AS version FROM snapshots"),
      extractor_versions: versions("SELECT DISTINCT extractor_version AS version FROM snapshots"),
      last_document_sync: this.getMeta("last_document_sync"),
      last_catalog_sync: this.getMeta("last_catalog_sync"),
    };
  }

  /**
   * Removes search-index rows that no longer correspond to a stored block: rows of a
   * deleted snapshot, and stale duplicates left under an id a re-ingest reproduced.
   * Idempotent.
   */
  purgeOrphanIndexRows(): number {
    return this.transaction(() => this.purgeOrphanIndexRowsUnsafe());
  }

  private purgeOrphanIndexRowsUnsafe(): number {
    const orphans = this.stmt(
      `SELECT COUNT(*) AS n FROM blocks_fts
        WHERE snapshot_id NOT IN (SELECT id FROM snapshots)
           OR block_id NOT IN (SELECT id FROM blocks)`,
    ).get() as { n: number };
    this.stmt(
      `DELETE FROM blocks_fts
        WHERE snapshot_id NOT IN (SELECT id FROM snapshots)
           OR block_id NOT IN (SELECT id FROM blocks)`,
    ).run();
    return orphans.n;
  }

  rebuildSearchIndex(): void {
    this.transaction(() => {
      this.purgeOrphanIndexRowsUnsafe();
      this.stmt("DELETE FROM blocks_fts").run();
      this.stmt(
        "INSERT INTO blocks_fts (snapshot_id, block_id, section_id, rfc, text) SELECT snapshot_id, id, section_id, rfc, text FROM blocks",
      ).run();
      this.stmt("DELETE FROM catalog_fts").run();
      this.stmt(
        `INSERT INTO catalog_fts (document_id, rfc, title, abstract, keywords, authors, status, stream)
         SELECT c.document_id, c.rfc, c.title, COALESCE(c.abstract, ''), c.keywords_json, c.authors_json,
                COALESCE(json_extract(c.status_json, '$.name'), ''), COALESCE(json_extract(c.stream_json, '$.name'), '')
           FROM catalog c`,
      ).run();
    });
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface CatalogRow {
  rfc: number;
  document_id: string;
  title: string;
  abstract: string | null;
  published: string | null;
  pages: number | null;
  status_json: string | null;
  stream_json: string | null;
  area_json: string | null;
  group_json: string | null;
  keywords_json: string;
  authors_json: string;
  obsoletes_json: string;
  obsoleted_by_json: string;
  updates_json: string;
  updated_by_json: string;
  subseries_json: string;
  identifiers_json: string;
  formats_json: string;
  doi: string | null;
  canonical_url: string;
  source_url: string;
  observed_at: string;
  content_hash: string;
  score?: number;
}

function rowToCatalog(row: CatalogRow): CatalogRecord {
  return {
    document_id: row.document_id,
    rfc: row.rfc,
    title: row.title,
    abstract: row.abstract,
    published: row.published,
    pages: row.pages,
    status: parseJson(row.status_json),
    stream: parseJson(row.stream_json),
    area: parseJson(row.area_json),
    group: parseJson(row.group_json),
    keywords: parseJson(row.keywords_json) ?? [],
    authors: parseJson(row.authors_json) ?? [],
    obsoletes: parseJson(row.obsoletes_json) ?? [],
    obsoleted_by: parseJson(row.obsoleted_by_json) ?? [],
    updates: parseJson(row.updates_json) ?? [],
    updated_by: parseJson(row.updated_by_json) ?? [],
    subseries: parseJson(row.subseries_json) ?? [],
    identifiers: parseJson(row.identifiers_json) ?? [],
    formats: parseJson(row.formats_json) ?? [],
    doi: row.doi,
    canonical_url: row.canonical_url,
    source_url: row.source_url,
    observed_at: row.observed_at,
    content_hash: row.content_hash,
  };
}

interface SnapshotRow {
  id: string;
  rfc: number;
  format: string;
  raw_sha256: string;
  bytes: number;
  retrieved_at: string;
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  parser_version: string;
  extractor_version: string;
  quality: string;
  warnings_json: string;
  metadata_hash: string;
  section_count: number;
  block_count: number;
  requirement_count: number;
  reference_count: number;
  prose_block_count: number;
}

/**
 * Blocks the normative extractor reads, under the same rules it applies.
 *
 * Kept as a stored count so `requirements` can state how much of a document was
 * examined. Recomputing it per call would mean loading every block of every
 * snapshot on each query, and the value is a property of the immutable snapshot.
 */
function countProseBlocks(blocks: readonly Block[], sections: readonly Section[]): number {
  const kinds = new Map(sections.map((section) => [section.id, section.kind]));
  let count = 0;
  for (const block of blocks) {
    if (!PROSE_BLOCK_KINDS.has(block.kind)) continue;
    if (SKIPPED_SECTION_KINDS.has(kinds.get(block.section_id) ?? "unknown")) continue;
    count += 1;
  }
  return count;
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    rfc: row.rfc,
    format: row.format as "txt" | "xml",
    raw_sha256: row.raw_sha256,
    bytes: row.bytes,
    retrieved_at: row.retrieved_at,
    source_url: row.source_url,
    etag: row.etag,
    last_modified: row.last_modified,
    parser_version: row.parser_version,
    extractor_version: row.extractor_version,
    quality: row.quality as "complete" | "degraded",
    warnings: parseJson(row.warnings_json) ?? [],
    metadata_hash: row.metadata_hash,
    section_count: row.section_count,
    block_count: row.block_count,
    requirement_count: row.requirement_count,
    reference_count: row.reference_count,
    prose_block_count: row.prose_block_count,
  };
}

interface SectionRow {
  snapshot_id: string;
  id: string;
  rfc: number;
  number: string;
  title: string;
  kind: string;
  parent_id: string | null;
  ordinal: number;
  path_json: string;
  text: string;
  text_sha256: string;
  byte_start: number;
  byte_end: number;
  char_start: number;
  char_end: number;
  codepoint_start: number;
  codepoint_end: number;
  line_start: number;
  line_end: number;
}

function spanFromRow(row: SectionRow): Span {
  return {
    byte_start: row.byte_start,
    byte_end: row.byte_end,
    char_start: row.char_start,
    char_end: row.char_end,
    codepoint_start: row.codepoint_start,
    codepoint_end: row.codepoint_end,
    line_start: row.line_start,
    line_end: row.line_end,
  };
}

function rowToSection(row: SectionRow): Section {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    rfc: row.rfc,
    number: row.number,
    title: row.title,
    kind: row.kind as Section["kind"],
    parent_id: row.parent_id,
    ordinal: row.ordinal,
    path: parseJson(row.path_json) ?? [],
    text: row.text,
    text_sha256: row.text_sha256,
    ...spanFromRow(row),
  };
}

type BlockRow = Omit<SectionRow, "path_json"> & { section_id: string; snapshot_id: string; id: string };

function rowToBlock(row: BlockRow): Block {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    rfc: row.rfc,
    section_id: row.section_id,
    ordinal: row.ordinal,
    kind: row.kind as Block["kind"],
    text: row.text,
    text_sha256: row.text_sha256,
    ...spanFromRow(row as unknown as SectionRow),
  };
}

interface RequirementRow {
  id: string;
  snapshot_id: string;
  rfc: number;
  section_id: string;
  block_id: string;
  term: string;
  strength: string;
  polarity: string;
  exact_text: string;
  citation_id: string;
  parse_status: string;
  confidence: number;
  actor: string | null;
  condition_text: string | null;
  action: string | null;
  exception_text: string | null;
  flags_json: string;
  char_start: number;
  char_end: number;
  byte_start: number;
  byte_end: number;
  codepoint_start: number;
  codepoint_end: number;
  line_start: number;
  line_end: number;
}

function rowToRequirement(row: RequirementRow, _snapshotId: string): Requirement {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    rfc: row.rfc,
    section_id: row.section_id,
    block_id: row.block_id,
    term: row.term as Requirement["term"],
    strength: row.strength as Requirement["strength"],
    polarity: row.polarity as Requirement["polarity"],
    exact_text: row.exact_text,
    span: {
      char_start: row.char_start,
      char_end: row.char_end,
      byte_start: row.byte_start,
      byte_end: row.byte_end,
      codepoint_start: row.codepoint_start,
      codepoint_end: row.codepoint_end,
      line_start: row.line_start,
      line_end: row.line_end,
    },
    context: row.exact_text,
    disposition: "requirement",
    flags: parseJson(row.flags_json) ?? [],
    citation_id: row.citation_id,
    clause: {
      actor: row.actor,
      condition: row.condition_text,
      action: row.action,
      exception: row.exception_text,
    },
    parse_status: row.parse_status as Requirement["parse_status"],
    confidence: row.confidence,
  };
}

interface MentionRow {
  id: string;
  snapshot_id: string;
  rfc: number;
  section_id: string;
  block_id: string;
  term: string;
  strength: string;
  polarity: string;
  exact_text: string;
  context: string;
  disposition: string;
  flags_json: string;
  citation_id: string;
  char_start: number;
  char_end: number;
  byte_start: number;
  byte_end: number;
  codepoint_start: number;
  codepoint_end: number;
  line_start: number;
  line_end: number;
}

function rowToMention(row: MentionRow, _snapshotId: string): NormativeMention {
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    rfc: row.rfc,
    section_id: row.section_id,
    block_id: row.block_id,
    term: row.term as NormativeMention["term"],
    strength: row.strength as NormativeMention["strength"],
    polarity: row.polarity as NormativeMention["polarity"],
    exact_text: row.exact_text,
    span: {
      char_start: row.char_start,
      char_end: row.char_end,
      byte_start: row.byte_start,
      byte_end: row.byte_end,
      codepoint_start: row.codepoint_start,
      codepoint_end: row.codepoint_end,
      line_start: row.line_start,
      line_end: row.line_end,
    },
    context: row.context,
    disposition: row.disposition as NormativeMention["disposition"],
    flags: parseJson(row.flags_json) ?? [],
    citation_id: row.citation_id,
  };
}

interface ReferenceRow {
  id: string;
  snapshot_id: string;
  rfc: number;
  section_id: string | null;
  ordinal: number;
  label: string;
  raw_text: string;
  relation: string;
  target_kind: string;
  target: string | null;
  target_rfc: number | null;
  resolution: string;
  external_kind: string | null;
  external_id: string | null;
  external_publisher: string | null;
  external_year: number | null;
  cited_by_json: string;
}

function rowToReference(row: ReferenceRow, _snapshotId: string): ReferenceRecord {
  const external =
    row.external_id === null
      ? null
      : {
          kind: (row.external_kind ?? "publication") as NonNullable<ReferenceRecord["external"]>["kind"],
          id: row.external_id,
          publisher: row.external_publisher,
          year: row.external_year,
        };
  return {
    id: row.id,
    snapshot_id: row.snapshot_id,
    rfc: row.rfc,
    section_id: row.section_id,
    ordinal: row.ordinal,
    label: row.label,
    raw_text: row.raw_text,
    relation: row.relation as ReferenceRecord["relation"],
    target_kind: row.target_kind as ReferenceRecord["target_kind"],
    target: row.target,
    target_rfc: row.target_rfc,
    resolution: row.resolution as ReferenceRecord["resolution"],
    external,
    cited_by: parseJson(row.cited_by_json) ?? [],
  };
}

interface ErrataRow {
  rfc: number;
  errata_id: string;
  status: string;
  type: string | null;
  section: string | null;
  original_text: string | null;
  corrected_text: string | null;
  notes: string | null;
  submitted_at: string | null;
  updated_at: string | null;
  url: string;
}

function rowToErratum(row: ErrataRow): Erratum {
  return {
    errata_id: row.errata_id,
    rfc: row.rfc,
    status: canonicalErrataStatus(row.status),
    type: row.type,
    section: row.section,
    original_text: row.original_text,
    corrected_text: row.corrected_text,
    notes: row.notes,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    url: row.url,
  };
}

interface HistoryRow {
  id: string;
  rfc: number;
  title: string;
  summary: string;
  published_at: string | null;
  author: string | null;
  url: string;
}

function rowToHistory(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    rfc: row.rfc,
    title: row.title,
    summary: row.summary,
    published_at: row.published_at,
    author: row.author,
    url: row.url,
  };
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function catalogHash(record: CatalogRecord): string {
  return contentHash({
    title: record.title,
    abstract: record.abstract,
    published: record.published,
    pages: record.pages,
    status: record.status,
    stream: record.stream,
    area: record.area,
    group: record.group,
    keywords: record.keywords,
    authors: record.authors,
    obsoletes: record.obsoletes,
    obsoleted_by: record.obsoleted_by,
    updates: record.updates,
    updated_by: record.updated_by,
    subseries: record.subseries,
    identifiers: record.identifiers,
    formats: record.formats,
    doi: record.doi,
  });
}
