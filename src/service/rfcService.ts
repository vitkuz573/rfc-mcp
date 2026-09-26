/**
 * RFC service: the single place where snapshots, provenance and policy live.
 *
 * Invariants enforced here and relied on by every tool:
 *  - analysis always runs against an immutable, content-addressed snapshot;
 *  - `resolve` is the only operation that turns "current" into a snapshot id;
 *    other operations accept an explicit `snapshot_id` or fall back to the
 *    latest local snapshot and say so in `provenance.freshness`;
 *  - every response is an envelope: status, data, provenance, warnings, limits;
 *  - a degraded upstream never becomes a silent success.
 */

import { RfcMcpError } from "../core/errors.js";
import type { AppConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import {
  CONTRACT_VERSION,
  type Block,
  type CatalogRecord,
  type Citation,
  type CitationVerdict,
  type DiffResult,
  type Envelope,
  type Erratum,
  type GraphResult,
  type HistoryEntry,
  type IndexStatus,
  type Provenance,
  type ReadResult,
  type ResolveResult,
  type SearchHit,
  type Section,
  type Snapshot,
} from "../core/types.js";
import { canonicalErrataStatus, type ErrataStatus } from "../core/types.js";
import { citationId, quoteHash } from "../analysis/citation.js";
import { diffDocuments, type DiffMode, type DiffSide } from "../analysis/diff.js";
import { analyzeReferences, buildGraph } from "../analysis/references.js";
import {
  analyzeNormative,
  analyzeNormativeCandidates,
  detectKeywordUsage,
  splitSentences,
} from "../analysis/normative.js";
import { parseRfcXmlOutline } from "../parse/rfcXml.js";
import { parseRfcText } from "../parse/text.js";
import { CorpusStore, catalogHash, type DocumentBundle } from "../store/database.js";
import { BATCH_OPERATION_SCHEMAS, describeIssues } from "./inputSchemas.js";
import { HttpClient } from "../upstream/http.js";
import {
  DatatrackerSource,
  mergeDocJson,
  mergeDocumentJson,
  normalizeCommon,
  RfcEditorSource,
  type UpstreamAsset,
  type UpstreamMetadata,
} from "../upstream/sources.js";
import {
  blankLines,
  clamp,
  decodeCursor,
  encodeCursor,
  isoNow,
  mapWithConcurrency,
  sanitizeSnippet,
  sha256Hex,
  shortHash,
  truncateBytes,
} from "../core/util.js";
import { buildFtsMatch, parseQuery, type ParsedQuery } from "./query.js";

export interface RequestContext {
  readonly signal?: AbortSignal;
}

export interface Anchor {
  readonly snapshot_id?: string;
  readonly rfc?: number;
}

export interface ResolveInput {
  readonly rfc?: number | string;
  readonly document_id?: string;
  readonly uri?: string;
  readonly refresh?: boolean;
  readonly with_xml?: boolean;
}

export interface MetadataInput extends Anchor {
  readonly include?: readonly ("relations" | "series" | "errata_summary" | "identifiers")[];
  readonly refresh?: boolean;
}

export interface ReadInput extends Anchor {
  readonly target?: string;
  readonly section?: string;
  readonly section_id?: string;
  readonly block_id?: string;
  readonly include?: readonly ("text" | "blocks" | "outline" | "source_map" | "subsections")[];
  readonly format?: "structured" | "text";
  readonly max_output_bytes?: number;
  readonly offset_bytes?: number;
  readonly refresh?: boolean;
}

export interface SearchInput {
  readonly query: string;
  readonly scope?: "auto" | "catalog" | "text";
  /**
   * Documents to ingest before the search runs, so a text search is not silently
   * limited to whatever happens to be cached.
   */
  readonly ensure_rfcs?: number[];
  readonly max_results?: number;
  readonly cursor?: string;
  readonly context_chars?: number;
  readonly block_kinds?: string[];
}

export interface RequirementsInput extends Anchor {
  readonly scope?: string;
  readonly term?: string;
  readonly keyword?: string;
  /**
   * Include requirement-shaped statements the strict upper-case extractor rejected.
   * Default true: without them a count of 0 cannot be told apart from a parser gap.
   */
  readonly include_candidates?: boolean;
  readonly max_candidates?: number;
  readonly max_results?: number;
  readonly cursor?: string;
  readonly include_mentions?: boolean;
  readonly refresh?: boolean;
}

export interface ReferencesInput extends Anchor {
  readonly relation?: string;
  readonly resolution?: string;
  readonly label?: string;
  readonly max_results?: number;
  readonly cursor?: string;
  readonly include_cited_by?: boolean;
  readonly refresh?: boolean;
}

export interface DependenciesInput extends Anchor {
  readonly direction?: "outgoing" | "incoming" | "both";
  readonly depth?: number;
  readonly max_nodes?: number;
  readonly max_edges?: number;
  readonly include_inferred?: boolean;
  readonly refresh_relations?: boolean;
  readonly refresh?: boolean;
}

export interface DiffInput {
  readonly left: Anchor;
  readonly right: Anchor;
  readonly mode?: DiffMode;
  readonly max_changes?: number;
  readonly include_unchanged?: boolean;
}

export interface ErrataInput extends Anchor {
  readonly status?: string;
  readonly max_results?: number;
  readonly cursor?: string;
  readonly refresh?: boolean;
}

export interface HistoryInput extends Anchor {
  readonly max_results?: number;
  readonly cursor?: string;
  readonly refresh?: boolean;
}

export interface SourceInput extends Anchor {
  readonly format?: "txt" | "xml" | "html" | "pdf";
  readonly include_text?: boolean;
  readonly max_text_bytes?: number;
  readonly refresh?: boolean;
}

export interface VerifyCitationInput {
  readonly citation_id?: string;
  readonly snapshot_id?: string;
  readonly rfc?: number;
  readonly block_id?: string;
  readonly char_start?: number;
  readonly quote_sha256?: string;
  readonly section?: string;
}

export interface BatchInput {
  readonly operations: readonly BatchOperation[];
}

export interface EnvelopeOptions {
  readonly warnings?: readonly string[];
  readonly nextCursor?: string | null;
  readonly status?: Envelope<unknown>["status"];
  readonly freshness?: Provenance["freshness"];
  readonly sourceUrls?: readonly string[];
  readonly appliedLimits?: Record<string, number>;
  readonly truncated?: boolean;
  readonly snapshot?: Snapshot | null;
  readonly observedAt?: string;
}

const CURSOR_SECRET_ENV = "RFC_MCP_CURSOR_SECRET";

export class RfcService {
  private readonly cursorSecret: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: CorpusStore,
    private readonly editor: RfcEditorSource,
    private readonly datatracker: DatatrackerSource,
    private readonly logger: Logger,
  ) {
    this.cursorSecret =
      process.env[CURSOR_SECRET_ENV] ??
      this.store.getMeta("cursor_secret") ??
      shortHash(`${this.store.path}|${this.config.productName}|${this.config.version}`, 32);
    this.store.setMeta("cursor_secret", this.cursorSecret);
  }

  static create(
    config: AppConfig,
    logger: Logger,
    options: { fetchImpl?: typeof fetch; store?: CorpusStore } = {},
  ): RfcService {
    const store = options.store ?? new CorpusStore(config.databasePath);
    const http = new HttpClient({
      userAgent: config.userAgent,
      timeoutMs: config.httpTimeoutMs,
      maxBytes: config.maxHttpBytes,
      maxConcurrency: config.maxConcurrency,
      defaultTtlMs: config.metadataCacheTtlMs,
      negativeTtlMs: config.negativeCacheTtlMs,
      logger: logger.child({ component: "http" }),
      cache: store,
      offline: config.offline,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return new RfcService(
      config,
      store,
      new RfcEditorSource(http, { indexTimeoutMs: config.indexTimeoutMs }),
      new DatatrackerSource(http),
      logger,
    );
  }

  close(): void {
    this.store.close();
  }

  get storeRef(): CorpusStore {
    return this.store;
  }

  /* ---------------------------------------------------------------------- */
  /* Envelope plumbing                                                       */
  /* ---------------------------------------------------------------------- */

  private envelope<T>(data: T, options: EnvelopeOptions = {}): Envelope<T> {
    const snapshot = options.snapshot ?? null;
    const observedAt = options.observedAt ?? snapshot?.retrieved_at ?? isoNow();
    const provenance: Provenance = {
      corpus_id: `rfc-mcp:${shortHash(this.store.path, 12)}`,
      index_generation: this.store.getGeneration(),
      parser_version: snapshot?.parser_version ?? this.config.parserVersion,
      extractor_version: snapshot?.extractor_version ?? this.config.extractorVersion,
      observed_at: observedAt,
      source_urls: options.sourceUrls ?? (snapshot ? [snapshot.source_url] : []),
      freshness: options.freshness ?? (this.config.offline ? "offline" : "cached"),
    };
    return {
      contract: CONTRACT_VERSION,
      status: options.status ?? "ok",
      data,
      provenance,
      warnings: options.warnings ?? [],
      next_cursor: options.nextCursor ?? null,
      limits: {
        applied: options.appliedLimits ?? {},
        truncated: options.truncated ?? false,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Snapshot resolution                                                     */
  /* ---------------------------------------------------------------------- */

  parseRfcNumber(value: string | number): number {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 1 || value > 99_999) {
        throw new RfcMcpError("INVALID_SELECTOR", `Invalid RFC number: ${value}`, { retryable: false });
      }
      return value;
    }
    const text = value.trim().replace(/^rfc/iu, "");
    if (!/^[1-9]\d{0,4}$/u.test(text)) {
      throw new RfcMcpError("INVALID_SELECTOR", `Invalid RFC identifier: ${JSON.stringify(value)}`, {
        retryable: false,
      });
    }
    return Number.parseInt(text, 10);
  }

  resolveNumberFromSelector(selector: {
    rfc?: number | string;
    document_id?: string;
    uri?: string;
    snapshot_id?: string;
  }): number {
    if (selector.rfc !== undefined) return this.parseRfcNumber(selector.rfc);
    if (selector.document_id) {
      const match = /^rfc-(\d{1,5})$/u.exec(selector.document_id.trim());
      if (match) return Number.parseInt(match[1]!, 10);
    }
    if (selector.uri) {
      const match = /rfc(\d{1,5})/iu.exec(selector.uri);
      if (match) return Number.parseInt(match[1]!, 10);
    }
    if (selector.snapshot_id) {
      const snapshot = this.store.getSnapshot(selector.snapshot_id);
      if (!snapshot) {
        throw new RfcMcpError("NOT_FOUND", `Unknown snapshot: ${selector.snapshot_id}`, { retryable: false });
      }
      return snapshot.rfc;
    }
    throw new RfcMcpError("INVALID_SELECTOR", "Provide one of: rfc, document_id, uri, snapshot_id", {
      retryable: false,
    });
  }

  /** Resolve a pinned snapshot, ingesting from upstream when allowed. */
  async ensureSnapshot(
    rfc: number,
    options: { refresh?: boolean; signal?: AbortSignal; withXml?: boolean },
  ): Promise<{ snapshot: Snapshot; record: CatalogRecord; warnings: string[]; freshness: Provenance["freshness"] }> {
    const existing = this.store.getLatestSnapshot(rfc, "txt");
    if (existing && options.refresh !== true) {
      const record = this.store.getCatalog(rfc);
      if (record) {
        const warnings: string[] = [];
        // with_xml is a request for a stored asset, not only for a re-derivation. A cached
        // snapshot returned without it would make the read fail with NOT_CACHED while
        // telling the caller to re-resolve with with_xml — advice that changes nothing.
        if (this.config.offline) {
          if (options.withXml && record.formats.includes("xml")) warnings.push("xml_unavailable:offline");
        } else {
          await this.ensureXmlAsset(existing, record, options.signal, warnings);
        }
        return { snapshot: existing, record, warnings, freshness: this.config.offline ? "offline" : "cached" };
      }
    }
    if (this.config.offline) {
      if (existing) {
        const record = this.store.getCatalog(rfc);
        if (record) {
          return { snapshot: existing, record, warnings: ["offline_served_from_cache"], freshness: "offline" };
        }
      }
      throw new RfcMcpError("NOT_CACHED", `RFC ${rfc} is not in the local corpus and the server is offline`, {
        details: { rfc },
        retryable: false,
      });
    }

    const warnings: string[] = [];
    // An explicit refresh must reach the wire: otherwise the freshness TTL in the
    // HTTP cache answers the request and the caller is told the document was
    // resolved from upstream while it was not.
    const revalidate = options.refresh === true;
    const metadata = await this.editor.fetchCommonMetadata(rfc, options.signal, { revalidate });
    let record = metadata.record;
    if (record.abstract === null) {
      try {
        const document = await this.editor.fetchDocumentJson(rfc, options.signal, { revalidate });
        record = mergeDocumentJson(record, document.payload);
      } catch (error) {
        warnings.push(`document_json_unavailable:${codeOf(error)}`);
      }
    }
    if (record.group === null || record.status === null) {
      try {
        const docJson = await this.datatracker.fetchDocJson(rfc, options.signal);
        record = mergeDocJson(record, docJson.payload);
      } catch (error) {
        warnings.push(`datatracker_doc_unavailable:${codeOf(error)}`);
      }
    }
    record = { ...record, content_hash: "" };

    const publication = await this.editor.fetchPublication(rfc, "txt", options.signal, { revalidate });
    warnings.push(...publication.warnings);
    const rawSha256 = sha256Hex(publication.body);
    // The metadata hash must cover document metadata only. Hashing the whole
    // catalog record would fold in observed_at, so re-observing unchanged bytes
    // would mint a different snapshot id and break content addressing.
    const metadataHash = catalogHash(record);
    // Parser/extractor versions are part of the identity: bumping either one
    // produces a new snapshot with re-derived analysis instead of silently
    // reusing results produced by different rules.
    const snapshotId = `snp_${shortHash(
      `rfc${rfc}|txt|${rawSha256}|${metadataHash}|${this.config.parserVersion}|${this.config.extractorVersion}`,
    )}`;

    if (
      this.store.hasSnapshotContent(
        rfc,
        "txt",
        rawSha256,
        metadataHash,
        this.config.parserVersion,
        this.config.extractorVersion,
      )
    ) {
      const snapshot = this.store.getSnapshot(snapshotId);
      if (snapshot) {
        if (options.withXml && record.formats.includes("xml")) {
          await this.ensureXmlAsset(snapshot, record, options.signal, warnings);
        }
        return { snapshot, record, warnings, freshness: "cached" };
      }
    }

    const parsed = parseRfcText({
      rfc,
      snapshotId,
      raw: publication.body,
      parserVersion: this.config.parserVersion,
    });
    warnings.push(...parsed.warnings.map((warning) => `parse:${warning}`));
    const normative = analyzeNormative({
      snapshotId,
      rfc,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    warnings.push(...normative.warnings);
    const references = analyzeReferences({
      snapshotId,
      rfc,
      sections: parsed.sections,
      blocks: parsed.blocks,
    });
    warnings.push(...references.warnings);

    const assets: UpstreamAsset[] = [];
    if (options.withXml && record.formats.includes("xml")) {
      try {
        assets.push(await this.editor.fetchPublication(rfc, "xml", options.signal));
      } catch (error) {
        warnings.push(`xml_unavailable:${codeOf(error)}`);
      }
    }

    const bundle: DocumentBundle = {
      record: { ...record, content_hash: metadataHash },
      snapshot: {
        id: snapshotId,
        rfc,
        format: "txt",
        rawSha256,
        bytes: publication.bytes,
        raw: publication.body,
        retrievedAt: publication.retrievedAt,
        sourceUrl: publication.sourceUrl,
        etag: publication.etag,
        lastModified: publication.lastModified,
        parserVersion: this.config.parserVersion,
        extractorVersion: this.config.extractorVersion,
        quality: parsed.quality,
        warnings: [...parsed.warnings, ...normative.warnings, ...references.warnings],
        metadataHash,
      },
      sections: parsed.sections,
      blocks: parsed.blocks,
      mentions: normative.mentions,
      requirements: normative.requirements,
      references: references.references,
      assets,
    };

    this.store.commitDocument(bundle);
    this.logger.info("document.ingested", {
      rfc,
      snapshot: snapshotId,
      sections: parsed.sections.length,
      blocks: parsed.blocks.length,
      requirements: normative.requirements.length,
      references: references.references.length,
      quality: parsed.quality,
    });

    const snapshot = this.store.getSnapshot(snapshotId)!;
    return { snapshot, record, warnings, freshness: "current" };
  }

  /**
   * Stores the RFCXML asset for a snapshot that was ingested without it. The asset is not
   * part of snapshot identity — it is a second representation of the same document — so it
   * is attached to the existing snapshot instead of minting a new one.
   */
  private async ensureXmlAsset(
    snapshot: Snapshot,
    record: CatalogRecord,
    signal: AbortSignal | undefined,
    warnings: string[],
  ): Promise<void> {
    if (!record.formats.includes("xml")) return;
    if (this.store.getAsset(snapshot.id, "xml")) return;
    try {
      const asset = await this.editor.fetchPublication(record.rfc, "xml", signal);
      this.store.putAsset(snapshot.id, asset);
    } catch (error) {
      warnings.push(`xml_unavailable:${codeOf(error)}`);
    }
  }

  private async anchor(
    input: Anchor,
    options: { refresh?: boolean; signal?: AbortSignal; withXml?: boolean },
  ): Promise<{
    snapshot: Snapshot;
    record: CatalogRecord;
    warnings: string[];
    freshness: Provenance["freshness"];
    pinned: boolean;
  }> {
    if (input.snapshot_id) {
      const snapshot = this.store.getSnapshot(input.snapshot_id);
      if (!snapshot) {
        // A pin retired by a rule-version bump is not an unknown id: the caller named
        // a real derivation of a real document. Saying which document, and what now
        // stands in for it, is the difference between a recoverable mistake and a
        // dead end that sends the caller back to guessing.
        const redirect = this.store.getSnapshotRedirect(input.snapshot_id);
        if (redirect) {
          throw new RfcMcpError(
            "NOT_FOUND",
            `Snapshot ${input.snapshot_id} was superseded: it is RFC ${redirect.rfc}, now derived as ${redirect.new_id}. Re-pin against the current id; the document bytes are unchanged unless raw_sha256 differs.`,
            {
              details: {
                snapshot_id: input.snapshot_id,
                superseded_by: redirect.new_id,
                rfc: redirect.rfc,
                reason: "rule_version_changed",
              },
              retryable: false,
            },
          );
        }
        throw new RfcMcpError("NOT_FOUND", `Unknown snapshot: ${input.snapshot_id}`, {
          details: { snapshot_id: input.snapshot_id },
          retryable: false,
        });
      }
      const record = this.store.getCatalog(snapshot.rfc);
      if (!record) {
        throw new RfcMcpError("CORPUS_UNAVAILABLE", `Catalog entry for RFC ${snapshot.rfc} is missing`, {
          retryable: false,
        });
      }
      return { snapshot, record, warnings: [], freshness: this.config.offline ? "offline" : "cached", pinned: true };
    }
    if (input.rfc === undefined) {
      throw new RfcMcpError("INVALID_ARGUMENT", "Provide snapshot_id or rfc", { retryable: false });
    }
    const resolved = await this.ensureSnapshot(input.rfc, options);
    return { ...resolved, pinned: false };
  }

  /* ---------------------------------------------------------------------- */
  /* resolve                                                                 */
  /* ---------------------------------------------------------------------- */

  async resolve(input: ResolveInput, context: RequestContext = {}): Promise<Envelope<ResolveResult>> {
    const rfc = this.resolveNumberFromSelector(input);
    const resolved = await this.ensureSnapshot(rfc, {
      refresh: input.refresh,
      withXml: input.with_xml,
      signal: context.signal,
    });
    const warnings = [...resolved.warnings];
    warnings.push("snapshot_resolved_from_upstream");
    if (resolved.snapshot.quality === "degraded") warnings.push("parse_quality_degraded");
    const result: ResolveResult = {
      document: resolved.record,
      snapshot: resolved.snapshot,
      available_formats: resolved.record.formats,
      analyses: {
        requirements_extracted: true,
        references_extracted: true,
        warnings: resolved.snapshot.warnings,
      },
    };
    return this.envelope(result, {
      snapshot: resolved.snapshot,
      warnings,
      freshness: resolved.freshness,
      sourceUrls: [resolved.record.source_url, resolved.snapshot.source_url],
      appliedLimits: { search_results: this.config.limits.maxSearchResults },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* metadata                                                                */
  /* ---------------------------------------------------------------------- */

  async metadata(input: MetadataInput, context: RequestContext = {}): Promise<Envelope<Record<string, unknown>>> {
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const include = new Set(input.include ?? ["relations", "series", "identifiers"]);
    const data: Record<string, unknown> = {
      document: record,
      snapshot: {
        id: snapshot.id,
        raw_sha256: snapshot.raw_sha256,
        bytes: snapshot.bytes,
        retrieved_at: snapshot.retrieved_at,
        quality: snapshot.quality,
        parser_version: snapshot.parser_version,
        extractor_version: snapshot.extractor_version,
        pinned,
      },
    };
    if (include.has("relations")) {
      data.relations = {
        obsoletes: record.obsoletes.map((target) => this.store.getCatalog(target)?.title ?? `RFC ${target}`),
        obsoleted_by: record.obsoleted_by.map((target) => this.store.getCatalog(target)?.title ?? `RFC ${target}`),
        updates: record.updates.map((target) => this.store.getCatalog(target)?.title ?? `RFC ${target}`),
        updated_by: record.updated_by.map((target) => this.store.getCatalog(target)?.title ?? `RFC ${target}`),
        datatracker: this.store.getRelations(record.rfc).map((relation) => ({
          relation: relation.relation,
          target_rfc: relation.target_rfc,
          source: relation.source,
          observed_at: relation.observed_at,
        })),
      };
    }
    if (include.has("errata_summary")) {
      // Counted in SQL over the whole set, not over one page: a by_status map built
      // from a bounded page silently reads as "this is all of them".
      const errata = this.store.getErrata(record.rfc, null, 200, 0);
      data.errata_summary = {
        total: errata.total,
        by_status: this.store.countErrataByStatus(record.rfc),
        fetched: this.store.hasErrata(record.rfc),
      };
    }
    if (include.has("identifiers")) data.identifiers = record.identifiers;
    if (include.has("series")) data.series = record.subseries;

    const allWarnings = [...warnings];
    if (!pinned) allWarnings.push("snapshot_not_explicitly_pinned");
    return this.envelope(data, { snapshot, warnings: allWarnings, freshness });
  }

  /* ---------------------------------------------------------------------- */
  /* read                                                                    */
  /* ---------------------------------------------------------------------- */

  async read(input: ReadInput, context: RequestContext = {}): Promise<Envelope<ReadResult>> {
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    // The floor is a byte budget, not a page size: 64 bytes is a legitimate budget
    // for "give me the first line", and a 1 KiB minimum would reject a question the
    // server can answer exactly. Truncation is always reported, so a small budget
    // narrows the answer instead of failing it.
    const maxBytes = clamp(input.max_output_bytes ?? this.config.limits.maxOutputBytes, 64, 4 * 1024 * 1024);
    const include = new Set(input.include ?? ["text", "blocks", "source_map"]);
    const warningsOut = [...warnings];
    if (!pinned) warningsOut.push("snapshot_not_explicitly_pinned");
    // Asking for `blocks` and getting rows whose `text` is empty is a successful
    // response that answers a different question. `source_map` is what carries the
    // text, so an explicit list without it has to say so rather than look identical
    // to a section that genuinely has no text.
    if (input.include !== undefined && include.has("blocks") && !include.has("source_map")) {
      warningsOut.push("block_text_suppressed_add_source_map_to_include_or_omit_include_entirely");
    }

    const target = input.target ?? "section";
    if (target === "outline") {
      const sections = this.store.getSections(snapshot.id);
      return this.envelope<ReadResult>(
        {
          document: record,
          snapshot,
          target: { kind: "outline", section: null, block_id: null },
          section: null,
          blocks: [],
          text: null,
          outline: sections.map((section) => ({
            ...section,
            text: "",
            text_sha256: section.text_sha256,
          })),
          truncated: false,
          byte_cursor: null,
        },
        { snapshot, warnings: warningsOut, freshness, appliedLimits: { max_output_bytes: maxBytes } },
      );
    }

    if (target === "xml_outline") {
      const asset = this.store.getAsset(snapshot.id, "xml");
      if (!asset) {
        // Two different states must not look alike. A document with no RFCXML
        // representation cannot be fixed by asking again, and telling the caller to
        // re-resolve with with_xml would send it into a loop that never terminates.
        if (!record.formats.includes("xml")) {
          throw new RfcMcpError("NOT_FOUND", `RFC ${record.rfc} has no RFCXML representation upstream`, {
            details: { rfc: record.rfc, available_formats: record.formats, target: "xml_outline" },
            retryable: false,
          });
        }
        throw new RfcMcpError("NOT_CACHED", "XML asset is not stored for this snapshot; re-resolve with with_xml", {
          details: { snapshot_id: snapshot.id },
          retryable: false,
        });
      }
      const outline = parseRfcXmlOutline(asset.body);
      // The parsed structure is the whole point of this target, and a degraded status
      // must state its cause: both were previously discarded.
      const xmlWarnings = outline.warnings.map((warning) => `xml:${warning}`);
      return this.envelope<ReadResult>(
        {
          document: record,
          snapshot,
          target: { kind: "xml_outline", section: null, block_id: null },
          section: null,
          blocks: [],
          text: null,
          outline: null,
          xml_outline: outline,
          truncated: false,
          byte_cursor: null,
        },
        {
          snapshot,
          warnings: [...warningsOut, ...xmlWarnings],
          freshness,
          status: xmlWarnings.length > 0 ? "degraded" : "ok",
        },
      );
    }

    if (target === "raw_slice" || target === "blocks") {
      const raw = this.store.getSnapshotRaw(snapshot.id);
      if (!raw) throw new RfcMcpError("CORPUS_UNAVAILABLE", "Snapshot bytes are missing", { retryable: false });
      const start = clamp(input.offset_bytes ?? 0, 0, raw.byteLength);
      const slice = raw.subarray(start, start + maxBytes);
      const truncated = start + slice.byteLength < raw.byteLength;
      return this.envelope<ReadResult>(
        {
          document: record,
          snapshot,
          target: { kind: "raw_slice", section: null, block_id: null },
          section: null,
          blocks: [],
          text: slice.toString("utf8"),
          outline: null,
          truncated,
          byte_cursor: truncated ? start + slice.byteLength : null,
        },
        {
          snapshot,
          warnings: warningsOut,
          freshness,
          truncated,
          nextCursor: truncated ? String(start + slice.byteLength) : null,
          appliedLimits: { max_output_bytes: maxBytes },
        },
      );
    }

    // section / block addressing
    let section = null;
    if (input.block_id) {
      const block = this.store.getBlock(snapshot.id, input.block_id);
      if (!block) {
        throw new RfcMcpError("NOT_FOUND", `Unknown block: ${input.block_id}`, { retryable: false });
      }
      section = this.store.getSectionById(snapshot.id, block.section_id);
    } else if (input.section_id) {
      section = this.store.getSectionById(snapshot.id, input.section_id);
      if (!section) {
        throw new RfcMcpError("NOT_FOUND", `Unknown section: ${input.section_id}`, { retryable: false });
      }
    } else if (input.section) {
      section = this.store.getSectionByNumber(snapshot.id, input.section);
      if (!section) {
        throw new RfcMcpError("NOT_FOUND", `Section ${input.section} not found in RFC ${snapshot.rfc}`, {
          details: { section: input.section, snapshot_id: snapshot.id },
          retryable: false,
        });
      }
    } else {
      const first = this.store.getSections(snapshot.id)[0] ?? null;
      if (!first) {
        throw new RfcMcpError("PARSE_FAILED", "Snapshot has no sections", { retryable: false });
      }
      section = first;
    }
    if (!section) {
      throw new RfcMcpError("NOT_FOUND", "Section could not be resolved", { retryable: false });
    }
    const resolvedSection = section;

    const blocks = this.store.getBlocksForSection(snapshot.id, resolvedSection.id);
    const selectedBlocks = include.has("subsections") ? blocks : this.filterBlocksToSection(resolvedSection, blocks);
    let text = input.format === "structured" ? null : resolvedSection.text;
    let truncated = false;
    if (text && Buffer.byteLength(text, "utf8") > maxBytes) {
      const limited = truncateBytes(text, maxBytes);
      text = limited.text;
      truncated = true;
    }
    let returnedBlocks = selectedBlocks;
    if (input.format === "text") {
      returnedBlocks = [];
    }

    // `text` is a verbatim slice, and its char and byte span denote exactly the
    // string reported next to them — that is what lets a caller locate what it read
    // in the file. Page furniture therefore survives in it. Rather than break that
    // invariant or leave the caller to guess which lines to distrust, the response
    // carries the same text with those lines emptied, plus their numbers.
    const furnitureLines = resolvedSection.furniture_lines ?? [];
    if (furnitureLines.length > 0) {
      warningsOut.push(`section_text_contains_page_furniture_on_lines:${furnitureLines.join(",")}:use_text_clean`);
    }

    const data: ReadResult = {
      document: record,
      snapshot,
      target: {
        kind: input.block_id ? "blocks" : "section",
        section: resolvedSection.number,
        block_id: input.block_id ?? null,
      },
      section: include.has("source_map") ? resolvedSection : ({ ...resolvedSection, text: "" } as Section),
      blocks: returnedBlocks.map((block) => (include.has("source_map") ? block : ({ ...block, text: "" } as Block))),
      text,
      ...(furnitureLines.length > 0 && text !== null
        ? {
            text_clean: blankLines(text, furnitureLines, resolvedSection.line_start),
            page_furniture_lines: furnitureLines,
          }
        : {}),
      outline: null,
      truncated,
      byte_cursor: truncated ? resolvedSection.byte_end : null,
    };
    return this.envelope(data, {
      snapshot,
      warnings: warningsOut,
      freshness,
      truncated,
      appliedLimits: { max_output_bytes: maxBytes },
    });
  }

  private filterBlocksToSection(section: Section, blocks: readonly Block[]): Block[] {
    return blocks.filter((block) => block.byte_start >= section.byte_start && block.byte_end <= section.byte_end);
  }

  /* ---------------------------------------------------------------------- */
  /* search                                                                  */
  /* ---------------------------------------------------------------------- */

  async search(
    input: SearchInput,
    context: RequestContext = {},
  ): Promise<
    Envelope<{
      scope: string;
      hits: SearchHit[];
      total: number;
      corpus: { generation: number; documents: number; catalog_documents: number; coverage: string };
    }>
  > {
    const limit = clamp(
      input.max_results ?? this.config.limits.maxSearchResults,
      1,
      this.config.limits.maxSearchResults,
    );
    const query = parseQuery(input.query, { maxChars: this.config.limits.maxQueryChars });
    const match = buildFtsMatch(query);
    const warnings: string[] = [...query.notes];

    // A text search can only see documents that are ingested. Resolving them here
    // turns "search the corpus" into an operation with a stated scope instead of one
    // whose scope is whatever a previous session happened to download.
    const ensured: number[] = [];
    if (input.ensure_rfcs && input.ensure_rfcs.length > 0) {
      for (const rfc of [...new Set(input.ensure_rfcs)].slice(0, 20)) {
        try {
          const resolved = await this.ensureSnapshot(rfc, { signal: context.signal });
          ensured.push(resolved.snapshot.rfc);
          warnings.push(...resolved.warnings.map((warning) => `ensure_rfc${rfc}:${warning}`));
        } catch (error) {
          warnings.push(`ensure_rfc${rfc}_failed:${codeOf(error)}`);
        }
      }
    }

    const generation = this.store.getGeneration();
    const binding = `${generation}|${input.scope ?? "auto"}|${stable(input.query)}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;

    let scope = input.scope ?? "auto";
    if (scope === "auto") {
      scope = match && this.countCatalogMatches(match, query) > 0 ? "catalog" : "text";
      if (match === null) scope = "catalog";
    }

    const contextChars = clamp(input.context_chars ?? this.config.limits.maxContextChars, 40, 2000);
    const catalogDocuments = this.store.countCatalog();
    const ingestedDocuments = this.store.status().snapshots;
    if (scope === "catalog") {
      const result = this.store.searchCatalog({
        match,
        limit,
        offset,
        ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
        ...(query.streams.length > 0 ? { streams: query.streams } : {}),
        ...(query.rfcs.length > 0 ? { rfcs: query.rfcs } : {}),
      });
      const hits: SearchHit[] = result.rows.map((row) => ({
        document_id: row.document_id,
        rfc: row.rfc,
        title: row.title,
        match_field: "title",
        snippet: sanitizeSnippet(row.abstract ?? row.title),
        highlight_spans: [],
        citation_id: null,
        score: typeof row.score === "number" ? -row.score : 0,
      }));
      const nextCursor =
        offset + hits.length < result.total
          ? encodeCursor({ o: offset + hits.length, g: generation, b: binding }, this.cursorSecret)
          : null;
      if (result.total === 0) warnings.push("no_catalog_match");
      // A filter the catalog index cannot honour must be reported, never dropped: a
      // section-scoped question answered from titles looks scoped but is not.
      const unsupported = unsupportedCatalogFilters(query);
      if (unsupported.length > 0) warnings.push(`filters_not_applied_to_catalog:${unsupported.join(",")}`);
      return this.envelope(
        {
          scope,
          hits,
          total: result.total,
          corpus: {
            generation,
            documents: catalogDocuments,
            catalog_documents: catalogDocuments,
            coverage: "catalog_titles_and_abstracts",
          },
        },
        { warnings, nextCursor, appliedLimits: { max_results: limit } },
      );
    }

    if (match === null) {
      // Catalog facets alone are meaningful: `status:std` or `stream:IETF` selects
      // documents without any text term. Only a query with nothing at all is an error.
      if (query.statuses.length === 0 && query.streams.length === 0 && query.rfcs.length === 0) {
        throw new RfcMcpError(
          "INVALID_ARGUMENT",
          "Text search needs free text, a phrase, or a field filter such as rfc:, status: or stream:",
          { retryable: false },
        );
      }
    }
    // A facet-only query has no MATCH expression, so it is answered from the catalog.
    if (match === null) {
      return this.searchCatalogOnly(query, input, limit, offset, generation, binding, warnings);
    }
    const total = this.store.countBlockMatches({
      match,
      rfcs: query.rfcs,
      sectionPrefix: query.sectionPrefix,
      blockKinds: input.block_kinds ?? null,
      relation: query.relation ?? null,
      limit: 0,
      offset: 0,
    });
    const rows = this.store.searchBlocks({
      match,
      rfcs: query.rfcs,
      sectionPrefix: query.sectionPrefix,
      blockKinds: input.block_kinds ?? null,
      relation: query.relation ?? null,
      limit,
      offset,
    });
    const hits: SearchHit[] = rows.map((row) => {
      const citation = citationId({
        snapshotId: row.snapshot_id,
        blockId: row.block_id,
        byteStart: 0,
        quote: row.text,
      });
      const { snippet, spans } = this.snippet(row.text, query, contextChars);
      return {
        document_id: `rfc-${row.rfc}`,
        rfc: row.rfc,
        title: row.title,
        snapshot_id: row.snapshot_id,
        section_id: row.section_id,
        section_path: row.section_path,
        block_id: row.block_id,
        match_field: "text",
        snippet,
        highlight_spans: spans,
        citation_id: citation,
        score: -row.score,
      };
    });
    if (total === 0) warnings.push("no_text_match");
    // A text search matches block text, which carries no document status or stream.
    // Saying so is the difference between a scoped answer and a quietly broader one.
    const textUnsupported: string[] = [];
    if (query.statuses.length > 0) textUnsupported.push("status");
    if (query.streams.length > 0) textUnsupported.push("stream");
    if (textUnsupported.length > 0) {
      warnings.push(`filters_not_applied_to_text:${textUnsupported.join(",")}`);
    }
    if (catalogDocuments > 0 && ingestedDocuments === 0) {
      warnings.push("corpus_has_no_ingested_documents_run_sync_rfc");
    }
    // Zero hits from a partially ingested corpus is the most misleading answer this
    // server can give: the document that holds the term may simply not be loaded.
    // `no_text_match` is only a statement about the corpus when the corpus is whole.
    if (total === 0 && ingestedDocuments < catalogDocuments) {
      warnings.push(
        `text_search_covers_ingested_documents_only:ingested=${ingestedDocuments},catalog=${catalogDocuments},resolve_the_rfc_first_or_pass_ensure_rfcs`,
      );
    }
    const nextCursor =
      offset + hits.length < total
        ? encodeCursor({ o: offset + hits.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    return this.envelope(
      {
        scope,
        hits,
        total,
        corpus: {
          generation,
          documents: ingestedDocuments,
          catalog_documents: catalogDocuments,
          coverage: `ingested_text_only:${ingestedDocuments}/${catalogDocuments}`,
        },
        ...(ensured.length > 0 ? { ensured_rfcs: ensured } : {}),
      },
      { warnings, nextCursor, appliedLimits: { max_results: limit, context_chars: contextChars } },
    );
  }

  /**
   * Answers a query that carries only catalog facets (`status:`, `stream:`, `rfc:`) and
   * no text term. The catalog is the only place these facets exist, so an explicit
   * `scope: "text"` cannot be honoured and is reported rather than silently ignored.
   */
  private searchCatalogOnly(
    query: ParsedQuery,
    input: SearchInput,
    limit: number,
    offset: number,
    generation: number,
    binding: string,
    warnings: string[],
  ): Envelope<{
    scope: string;
    hits: SearchHit[];
    total: number;
    corpus: { generation: number; documents: number; catalog_documents: number; coverage: string };
  }> {
    if (input.scope === "text") warnings.push("catalog_facets_only_scope_relaxed_to_catalog");
    const result = this.store.searchCatalog({
      match: null,
      limit,
      offset,
      ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
      ...(query.streams.length > 0 ? { streams: query.streams } : {}),
      ...(query.rfcs.length > 0 ? { rfcs: query.rfcs } : {}),
    });
    const hits: SearchHit[] = result.rows.map((row) => ({
      document_id: row.document_id,
      rfc: row.rfc,
      title: row.title,
      match_field: "title",
      snippet: sanitizeSnippet(row.abstract ?? row.title),
      highlight_spans: [],
      citation_id: null,
      score: 0,
    }));
    if (result.total === 0) warnings.push("no_catalog_match");
    const nextCursor =
      offset + hits.length < result.total
        ? encodeCursor({ o: offset + hits.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    const catalogDocuments = this.store.countCatalog();
    return this.envelope(
      {
        scope: "catalog",
        hits,
        total: result.total,
        corpus: {
          generation,
          documents: catalogDocuments,
          catalog_documents: catalogDocuments,
          coverage: "catalog_titles_and_abstracts",
        },
      },
      { warnings, nextCursor, appliedLimits: { max_results: limit } },
    );
  }

  private countCatalogMatches(match: string, query: ParsedQuery): number {
    const result = this.store.searchCatalog({
      match,
      limit: 1,
      offset: 0,
      ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
      ...(query.streams.length > 0 ? { streams: query.streams } : {}),
      ...(query.rfcs.length > 0 ? { rfcs: query.rfcs } : {}),
    });
    return result.total;
  }

  private snippet(
    text: string,
    query: ReturnType<typeof parseQuery>,
    contextChars: number,
  ): { snippet: string; spans: { start: number; end: number }[] } {
    const needles = [...query.phrases, ...(query.text ? query.text.split(/\s+/u) : []), ...query.keywords].filter(
      Boolean,
    );
    const lower = text.toLowerCase();
    let first = -1;
    for (const needle of needles) {
      const index = lower.indexOf(needle.toLowerCase());
      if (index !== -1 && (first === -1 || index < first)) first = index;
    }
    const start = first === -1 ? 0 : Math.max(0, first - contextChars);
    const end = Math.min(text.length, (first === -1 ? 0 : first) + contextChars * 2);
    const raw = text.slice(start, end);
    const spans: { start: number; end: number }[] = [];
    const lowerRaw = raw.toLowerCase();
    for (const needle of needles) {
      let from = 0;
      for (;;) {
        const index = lowerRaw.indexOf(needle.toLowerCase(), from);
        if (index === -1) break;
        spans.push({ start: index, end: index + needle.length });
        from = index + needle.length;
      }
    }
    return { snippet: sanitizeSnippet(raw), spans: spans.slice(0, 20) };
  }

  /* ---------------------------------------------------------------------- */
  /* requirements                                                            */
  /* ---------------------------------------------------------------------- */

  async requirements(
    input: RequirementsInput,
    context: RequestContext = {},
  ): Promise<Envelope<Record<string, unknown>>> {
    void context;
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const limit = clamp(
      input.max_results ?? this.config.limits.maxSearchResults,
      1,
      this.config.limits.maxSearchResults,
    );
    const generation = this.store.getGeneration();
    const binding = `${generation}|req|${snapshot.id}|${input.scope ?? ""}|${input.term ?? ""}|${input.keyword ?? ""}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;

    const filter = {
      ...(input.term ? { term: input.term.toUpperCase() } : {}),
      sectionPrefix: input.scope ?? null,
    };
    const total = this.store.countRequirements(snapshot.id, filter);
    const rows = this.store.getRequirements(snapshot.id, { ...filter, limit, offset });
    const sectionNumbers = new Map(this.store.getSections(snapshot.id).map((section) => [section.id, section.number]));
    const requirements = rows.map((requirement) => ({
      ...requirement,
      section: sectionNumbers.get(requirement.section_id) ?? null,
    }));
    const keywordFiltered = input.keyword
      ? requirements.filter((requirement) =>
          requirement.exact_text.toLowerCase().includes(input.keyword!.toLowerCase()),
        )
      : requirements;

    const warningsOut = [...warnings];
    if (!pinned) warningsOut.push("snapshot_not_explicitly_pinned");

    const data: Record<string, unknown> = {
      document: record,
      snapshot_id: snapshot.id,
      requirements: keywordFiltered,
      coverage: {
        total_requirements: total,
        returned: keywordFiltered.length,
        section_filter: input.scope ?? null,
        term_filter: input.term ?? null,
        keyword_filter: input.keyword ?? null,
        blocks_scanned: snapshot.block_count,
        prose_blocks_scanned: snapshot.prose_block_count,
      },
      interpretation: {
        normative_terms: "RFC 2119 / RFC 8174, upper case only",
        caveat:
          "A missing requirement is not proof of absence: only prose blocks are scanned, and code, tables, figures and reference sections are excluded by design. Read non_strict_candidates before concluding that a document states no requirements.",
      },
    };
    if (input.include_mentions !== false) {
      data.mentions = this.store.getMentions(snapshot.id, 500);
    }

    // A zero requirement count is only a statement about absence once the reader can
    // see what was rejected. The candidate pass runs over the stored blocks, so it
    // needs no re-ingest and stays correct for every snapshot in the corpus.
    const keywordBlocks = this.store.listBlocksWithKeywords(snapshot.id);
    const usage = detectKeywordUsage({ snapshotId: snapshot.id, blocks: keywordBlocks });
    if (usage.length > 0) {
      data.keyword_usage = {
        stance: usage[0]!.stance,
        notes: usage,
        meaning:
          usage[0]!.stance === "disclaims"
            ? "The document states that it does not use the RFC 2119 requirement language, so a zero requirement count is expected and is not a gap in extraction. Its normative statements are in non_strict_candidates."
            : "The document adopts RFC 2119 / RFC 8174, so a low requirement count is the surprising outcome. Read coverage and non_strict_candidates before concluding there is little to implement.",
      };
    }
    if (input.include_candidates !== false) {
      const sections = this.store.getSections(snapshot.id);
      // A candidate list that ignored `scope` would answer a different question
      // than the requirement list beside it, and the two are read together.
      const scopeSections = input.scope
        ? sections.filter((section) => section.number === input.scope || section.number.startsWith(`${input.scope}.`))
        : sections;
      const scopeIds = new Set(scopeSections.map((section) => section.id));
      const analysis = analyzeNormativeCandidates({
        snapshotId: snapshot.id,
        rfc: record.rfc,
        sections: scopeSections,
        blocks: keywordBlocks.filter((block) => scopeIds.has(block.section_id)),
        ...(input.max_candidates !== undefined ? { limit: input.max_candidates } : {}),
      });
      const sectionById = new Map(sections.map((section) => [section.id, section.number]));
      const bySection: Record<string, number> = {};
      for (const candidate of analysis.candidates) {
        const key = sectionById.get(candidate.section_id) ?? candidate.section_id;
        bySection[key] = (bySection[key] ?? 0) + 1;
      }
      data.non_strict_candidates = {
        total: analysis.candidates.length,
        by_keyword: analysis.by_keyword,
        by_keyword_case: analysis.by_case,
        by_reason: analysis.by_reason,
        by_role: analysis.by_role,
        by_section: bySection,
        scanned_blocks: analysis.scanned_blocks,
        unreadable_blocks: analysis.unreadable_blocks,
        candidates: analysis.candidates.map((candidate) => ({
          ...candidate,
          section: sectionById.get(candidate.section_id) ?? null,
        })),
        note: "Requirement-shaped statements the strict upper-case extractor rejected. Per RFC 8174 section 3 an uncapitalised keyword has no normative force, so these are NOT requirements; they are reported so a zero requirement count is not mistaken for the absence of normative language. keyword_case says which capitalisation was found; reason names the structural cause when capitalisation is not the only one. role says whether the keyword is in modal position: filter on role=modal, but treat role=unknown as unresolved rather than as a rule, because the classifier is a shape heuristic and not a parser.",
      };
      warningsOut.push(...analysis.warnings.map((warning) => `candidates:${warning}`));
      if (analysis.candidates.length > 0) {
        warningsOut.push(
          `zero_or_few_requirements_but_${analysis.candidates.length}_non_strict_candidates:read_non_strict_candidates`,
        );
      }
    }

    const nextCursor =
      offset + rows.length < total
        ? encodeCursor({ o: offset + rows.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    return this.envelope(data, {
      snapshot,
      warnings: warningsOut,
      freshness,
      nextCursor,
      appliedLimits: { max_results: limit },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* references                                                              */
  /* ---------------------------------------------------------------------- */

  async references(input: ReferencesInput, context: RequestContext = {}): Promise<Envelope<Record<string, unknown>>> {
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const limit = clamp(
      input.max_results ?? this.config.limits.maxRelationPageSize,
      1,
      this.config.limits.maxRelationPageSize,
    );
    const generation = this.store.getGeneration();
    const binding = `${generation}|ref|${snapshot.id}|${input.relation ?? ""}|${input.resolution ?? ""}|${input.label ?? ""}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;
    const filter = {
      ...(input.relation ? { relation: input.relation } : {}),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(input.label ? { label: input.label } : {}),
    };
    const total = this.store.countReferences(snapshot.id, filter);
    const rows = this.store.getReferences(snapshot.id, { ...filter, limit, offset });
    const sectionNumbers = new Map(this.store.getSections(snapshot.id).map((section) => [section.id, section.number]));
    const data = {
      document: record,
      snapshot_id: snapshot.id,
      references: rows.map((reference) => ({
        ...reference,
        section: reference.section_id ? (sectionNumbers.get(reference.section_id) ?? null) : null,
        cited_by: input.include_cited_by === false ? [] : reference.cited_by,
        target_title: reference.target_rfc ? (this.store.getCatalog(reference.target_rfc)?.title ?? null) : null,
      })),
      total,
    };
    const nextCursor =
      offset + rows.length < total
        ? encodeCursor({ o: offset + rows.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    const warningsOut = [...warnings];
    if (!pinned) warningsOut.push("snapshot_not_explicitly_pinned");
    return this.envelope(data, {
      snapshot,
      warnings: warningsOut,
      freshness,
      nextCursor,
      appliedLimits: { max_results: limit },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* dependencies                                                            */
  /* ---------------------------------------------------------------------- */

  async dependencies(input: DependenciesInput, context: RequestContext = {}): Promise<Envelope<GraphResult>> {
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const depth = clamp(input.depth ?? this.config.limits.maxGraphDepth, 1, 3);
    const maxNodes = clamp(input.max_nodes ?? this.config.limits.maxGraphNodes, 2, 200);
    const maxEdges = clamp(input.max_edges ?? this.config.limits.maxGraphEdges, 1, 500);
    const direction = input.direction ?? "outgoing";
    const warningsOut = [...warnings];

    const references = this.store.getReferences(snapshot.id, { limit: 1000, offset: 0 });
    let inbound: {
      rfc: number;
      relation: string;
      evidence: { source: string; url: string | null; observed_at: string } | null;
    }[] = [];
    if (direction !== "outgoing" && !this.config.offline) {
      try {
        const relations = await this.datatracker.fetchRelations(
          record.rfc,
          { direction: "incoming", limit: this.config.limits.maxRelationPageSize },
          context.signal,
        );
        inbound = relations.relations.map((relation) => ({
          rfc: relation.rfc,
          relation: relation.relation,
          evidence: relation.evidence,
        }));
        this.store.replaceRelations(
          record.rfc,
          relations.relations.map((relation) => ({
            relation: relation.relation,
            target_rfc: relation.rfc,
            source: "datatracker",
            evidence: relation.evidence,
            observed_at: relation.evidence?.observed_at ?? isoNow(),
          })),
        );
        warningsOut.push(`inbound_relations_truncated_at_${relations.total}`);
      } catch (error) {
        warningsOut.push(`inbound_relations_unavailable:${codeOf(error)}`);
      }
    }

    const targets = new Set<number>();
    for (const reference of references) if (reference.target_rfc) targets.add(reference.target_rfc);
    for (const rfc of record.obsoletes) targets.add(rfc);
    for (const rfc of record.updated_by) targets.add(rfc);
    for (const relation of inbound) targets.add(relation.rfc);
    const titles = this.store.getTitles([...targets, record.rfc]);

    const graph = buildGraph({
      rootRfc: record.rfc,
      rootSnapshotId: snapshot.id,
      references,
      metadata: {
        obsoletes: record.obsoletes,
        obsoleted_by: record.obsoleted_by,
        updates: record.updates,
        updated_by: record.updated_by,
      },
      inbound: inbound.slice(0, maxEdges),
      titles,
      direction,
      depth,
      maxNodes,
      maxEdges,
      observedAt: snapshot.retrieved_at,
    });
    if (graph.unresolved.length > 0) warningsOut.push(`unresolved_reference_labels:${graph.unresolved.length}`);
    if (!pinned) warningsOut.push("snapshot_not_explicitly_pinned");
    const graphResult: GraphResult = {
      root: `doc:rfc-${record.rfc}`,
      direction,
      depth,
      nodes: graph.nodes,
      edges: graph.edges,
      truncated: graph.truncated,
      unresolved: graph.unresolved,
    };
    return this.envelope(graphResult, {
      snapshot,
      warnings: warningsOut,
      freshness,
      appliedLimits: { depth, max_nodes: maxNodes, max_edges: maxEdges },
      truncated: graph.truncated,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* diff                                                                    */
  /* ---------------------------------------------------------------------- */

  async diff(input: DiffInput, context: RequestContext = {}): Promise<Envelope<DiffResult>> {
    const left = await this.anchor(input.left, { refresh: input.left.rfc !== undefined, signal: context.signal });
    const right = await this.anchor(input.right, { refresh: input.right.rfc !== undefined, signal: context.signal });
    const mode = input.mode ?? "requirements";
    const maxChanges = clamp(input.max_changes ?? this.config.limits.maxDiffChanges, 1, 500);
    const leftSide = await this.diffSide(left.snapshot, left.record);
    const rightSide = await this.diffSide(right.snapshot, right.record);
    const result = diffDocuments({
      left: leftSide,
      right: rightSide,
      mode,
      maxChanges,
      maxOutputBytes: this.config.limits.maxOutputBytes,
    });
    const warnings: string[] = [];
    if (mode === "text") warnings.push("text_diff_is_not_a_semantic_diff");
    if (left.snapshot.rfc === right.snapshot.rfc && left.snapshot.id === right.snapshot.id) {
      warnings.push("both_sides_are_the_same_snapshot");
    }
    return this.envelope(result, {
      snapshot: right.snapshot,
      warnings,
      freshness: right.freshness,
      appliedLimits: { max_changes: maxChanges },
      truncated: result.truncated,
    });
  }

  private async diffSide(snapshot: Snapshot, record: CatalogRecord): Promise<DiffSide> {
    const sections = this.store.getSections(snapshot.id);
    const requirements = this.store.getRequirements(snapshot.id, { limit: 5000, offset: 0 });
    const references = this.store.getReferences(snapshot.id, { limit: 5000, offset: 0 });
    const raw = this.store.getSnapshotRaw(snapshot.id);
    const lines = raw ? raw.toString("utf8").split("\n") : [];
    return {
      documentId: record.document_id,
      snapshotId: snapshot.id,
      catalog: record,
      sections,
      requirements,
      references: references.map((reference) => ({
        label: reference.label,
        relation: reference.relation,
        target: reference.target,
      })),
      lines,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* errata                                                                  */
  /* ---------------------------------------------------------------------- */

  async errata(
    input: ErrataInput,
    context: RequestContext = {},
  ): Promise<
    Envelope<{
      errata: Erratum[];
      total: number;
      total_unfiltered: number;
      status_filter: ErrataStatus | "any" | null;
      available_statuses: Record<string, number>;
      note: string;
    }>
  > {
    const { snapshot, record, warnings, freshness } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    if (!this.store.hasErrata(record.rfc) && !this.config.offline) {
      try {
        const fetched = await this.editor.fetchErrata(record.rfc, context.signal);
        this.store.replaceErrata(record.rfc, fetched.errata);
        warnings.push(...fetched.warnings);
      } catch (error) {
        warnings.push(`errata_unavailable:${codeOf(error)}`);
      }
    }
    const limit = clamp(
      input.max_results ?? this.config.limits.maxRelationPageSize,
      1,
      this.config.limits.maxRelationPageSize,
    );
    const generation = this.store.getGeneration();
    // `any` and an absent filter are the same question, so they must produce the
    // same cursor: a caller paging with `any` and then without it stays on one
    // result set instead of silently restarting.
    const requested = input.status ?? null;
    const effective = requested !== null && requested.toLowerCase() === "any" ? null : requested;
    const binding = `${generation}|errata|${record.rfc}|${effective ?? ""}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;
    const result = this.store.getErrata(record.rfc, effective, limit, offset);
    const available = this.store.countErrataByStatus(record.rfc);
    const totalUnfiltered = Object.values(available).reduce((sum, value) => sum + value, 0);

    // An empty filtered answer is only interpretable next to what does exist. Without
    // this, `status=held_for_document_update` returning zero is indistinguishable from
    // an RFC that has no errata at all.
    if (result.total === 0 && totalUnfiltered > 0) {
      warnings.push(
        effective === null
          ? "errata_empty"
          : `no_errata_with_status:${effective}:available=${Object.entries(available)
              .filter(([, count]) => count > 0)
              .map(([status]) => status)
              .join(",")}`,
      );
    }
    const nextCursor =
      offset + result.rows.length < result.total
        ? encodeCursor({ o: offset + result.rows.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    return this.envelope(
      {
        errata: result.rows,
        total: result.total,
        total_unfiltered: totalUnfiltered,
        status_filter: (effective === null ? (requested === null ? null : "any") : canonicalErrataStatus(effective)) as
          ErrataStatus | "any" | null,
        available_statuses: available,
        note: "Errata are not incorporated into the TXT, PDF or XML publication versions of an RFC; this list is an overlay, never a patch.",
      },
      { snapshot, warnings, freshness, nextCursor, appliedLimits: { max_results: limit } },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* history                                                                 */
  /* ---------------------------------------------------------------------- */

  async history(
    input: HistoryInput,
    context: RequestContext = {},
  ): Promise<Envelope<{ entries: HistoryEntry[]; total: number; source: string }>> {
    const { snapshot, record, warnings, freshness } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    let sourceUrl = `https://datatracker.ietf.org/doc/rfc${record.rfc}/history/`;
    if (!this.store.hasHistory(record.rfc) && !this.config.offline) {
      try {
        const fetched = await this.datatracker.fetchHistory(record.rfc, 200, context.signal);
        this.store.replaceHistory(record.rfc, fetched.entries);
        sourceUrl = fetched.sourceUrl;
        warnings.push(...fetched.warnings);
      } catch (error) {
        warnings.push(`history_unavailable:${codeOf(error)}`);
      }
    }
    const limit = clamp(input.max_results ?? this.config.limits.maxCitationPageSize, 1, 200);
    const generation = this.store.getGeneration();
    const binding = `${generation}|history|${record.rfc}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;
    const result = this.store.getHistory(record.rfc, limit, offset);
    const nextCursor =
      offset + result.rows.length < result.total
        ? encodeCursor({ o: offset + result.rows.length, g: generation, b: binding }, this.cursorSecret)
        : null;
    return this.envelope(
      { entries: result.rows, total: result.total, source: sourceUrl },
      { snapshot, warnings, freshness, nextCursor, appliedLimits: { max_results: limit } },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* source assets                                                           */
  /* ---------------------------------------------------------------------- */

  async source(input: SourceInput, context: RequestContext = {}): Promise<Envelope<Record<string, unknown>>> {
    const { snapshot, record, warnings, freshness } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const format = input.format ?? "txt";
    const warningsOut = [...warnings];
    let asset = this.store.getAsset(snapshot.id, format);
    if (!asset && !this.config.offline) {
      try {
        const fetched = await this.editor.fetchPublication(record.rfc, format, context.signal);
        this.store.putAsset(snapshot.id, fetched);
        asset = this.store.getAsset(snapshot.id, format);
        warningsOut.push(...fetched.warnings);
      } catch (error) {
        throw new RfcMcpError("NOT_FOUND", `RFC ${record.rfc} has no ${format.toUpperCase()} representation`, {
          details: { rfc: record.rfc, format, reason: codeOf(error) },
          retryable: false,
          cause: error,
        });
      }
    }
    if (!asset) {
      throw new RfcMcpError("NOT_CACHED", `The ${format.toUpperCase()} asset is not cached and the server is offline`, {
        details: { rfc: record.rfc, format },
        retryable: false,
      });
    }
    const maxTextBytes = clamp(input.max_text_bytes ?? this.config.limits.maxOutputBytes, 0, 2 * 1024 * 1024);
    const data: Record<string, unknown> = {
      document_id: record.document_id,
      snapshot_id: snapshot.id,
      format: asset.format,
      content_type: asset.contentType,
      bytes: asset.bytes,
      sha256: asset.sha256,
      retrieved_at: asset.retrievedAt,
      source_url: asset.sourceUrl,
      etag: asset.etag,
      last_modified: asset.lastModified,
      canonical_urls: {
        rfc_editor: `https://www.rfc-editor.org/rfc/rfc${record.rfc}.${format}`,
        datatracker: `https://datatracker.ietf.org/doc/rfc${record.rfc}/`,
      },
    };
    if (input.include_text && (format === "txt" || format === "xml" || format === "html")) {
      const text = asset.body.subarray(0, maxTextBytes).toString("utf8");
      data.text = text;
      data.text_truncated = asset.bytes > maxTextBytes;
    }
    return this.envelope(data, {
      snapshot,
      warnings: warningsOut,
      freshness,
      appliedLimits: { max_text_bytes: maxTextBytes },
    });
  }

  /* ---------------------------------------------------------------------- */
  /* citations                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves a derived citation id back to the block that produced it. Search hits
   * and non-strict candidates are computed on demand rather than stored, so the id
   * is recomputed with the same identity function over the document's blocks; the
   * scan is bounded by the number of blocks in one snapshot.
   *
   * Both shapes are reconstructed because both are handed out with a citation id:
   * a search hit cites a whole block, a candidate cites one sentence at a keyword
   * offset. A candidate that could not be verified would break the server's one
   * standing promise about derived facts.
   */
  private findBlockByDerivedCitation(
    snapshotId: string,
    citation: string,
  ): { id: string; section_id: string; char_start: number; text: string; kind: string } | null {
    for (const block of this.store.listBlocks(snapshotId)) {
      if (
        citationId({
          snapshotId,
          blockId: block.id,
          byteStart: 0,
          quote: block.text,
        }) === citation
      ) {
        return block;
      }
      for (const sentence of splitSentences(block.text)) {
        for (const match of sentence.text.matchAll(/\S+/gu)) {
          const charStart = block.char_start + sentence.start + match.index;
          if (
            citationId({
              snapshotId,
              blockId: block.id,
              byteStart: charStart,
              quote: sentence.text,
            }) === citation
          ) {
            return { ...block, char_start: charStart, text: sentence.text };
          }
        }
      }
    }
    return null;
  }

  async verifyCitation(
    input: VerifyCitationInput,
    context: RequestContext = {},
  ): Promise<Envelope<{ verdict: CitationVerdict; matches: Citation[]; notes: string[] }>> {
    void context;
    const warnings: string[] = [];
    let snapshot: Snapshot | null = null;
    if (input.snapshot_id) {
      snapshot = this.store.getSnapshot(input.snapshot_id);
      if (!snapshot) {
        return this.envelope(
          { verdict: "not_found" as CitationVerdict, matches: [], notes: [`unknown snapshot ${input.snapshot_id}`] },
          { warnings },
        );
      }
    } else if (input.rfc !== undefined) {
      snapshot = this.store.getLatestSnapshot(input.rfc, "txt");
    }
    if (!snapshot) {
      return this.envelope(
        { verdict: "not_found" as CitationVerdict, matches: [], notes: ["no snapshot to verify against"] },
        { warnings },
      );
    }

    const raw = this.store.getSnapshotRaw(snapshot.id);
    if (!raw) {
      return this.envelope(
        { verdict: "integrity_failure" as CitationVerdict, matches: [], notes: ["snapshot bytes are missing"] },
        { warnings },
      );
    }
    if (sha256Hex(raw) !== snapshot.raw_sha256) {
      return this.envelope(
        { verdict: "integrity_failure" as CitationVerdict, matches: [], notes: ["snapshot content hash mismatch"] },
        { warnings },
      );
    }

    // Requirement and mention citations live in stored records. A text search hit is
    // not stored — its citation covers a whole block — so it is reconstructed here
    // from the same identity function rather than left unverifiable.
    let matches = this.store.findCitationMatches(
      snapshot.id,
      {
        ...(input.citation_id ? { citationId: input.citation_id } : {}),
        ...(input.quote_sha256 ? { quoteSha256: input.quote_sha256 } : {}),
        ...(input.block_id ? { blockId: input.block_id } : {}),
        ...(input.char_start !== undefined ? { charStart: input.char_start } : {}),
      },
      this.config.limits.maxCitationPageSize,
    );
    let resolvedFromBlock = false;
    if (matches.length === 0 && input.citation_id) {
      const block = this.findBlockByDerivedCitation(snapshot.id, input.citation_id);
      if (block) {
        matches = [
          {
            mention_id: null,
            block_id: block.id,
            section_id: block.section_id,
            char_start: block.char_start,
            exact_text: block.text,
            citation_id: input.citation_id,
            kind: "mention" as const,
          },
        ];
        resolvedFromBlock = true;
      }
    }

    const notes: string[] = [];
    let verdict: CitationVerdict;
    if (matches.length === 0) {
      verdict = "not_found";
      notes.push("no stored record matches the supplied locator or quote hash");
    } else if (matches.length > 1) {
      verdict = "ambiguous";
      notes.push(`${matches.length} stored records match; a locator is required to disambiguate`);
    } else {
      const match = matches[0]!;
      const block = this.store.getBlock(snapshot.id, match.block_id);
      if (!block) {
        verdict = "not_found";
        notes.push("referenced block is missing");
      } else {
        if (resolvedFromBlock) {
          notes.push(
            `citation recomputed from block ${block.id} (${block.kind}); no stored requirement or mention record carries this id`,
          );
        }
        const slice = raw.subarray(block.byte_start, block.byte_end).toString("utf8");
        if (slice.includes(match.exact_text)) {
          verdict = "verified";
          notes.push(
            `quote matches bytes ${block.byte_start}..${block.byte_end} (lines ${block.line_start}..${block.line_end})`,
          );
        } else if (decodedText(raw, block.char_start, block.char_end).includes(match.exact_text)) {
          // Invalid UTF-8 was repaired during parsing, so byte offsets drift;
          // character offsets into the decoded text remain exact.
          verdict = "verified";
          notes.push(
            `quote matches chars ${block.char_start}..${block.char_end} (lines ${block.line_start}..${block.line_end})`,
            "verified against the decoded text; byte offsets are approximate for this snapshot",
          );
        } else if (collapseWhitespace(slice).includes(collapseWhitespace(match.exact_text))) {
          // The only text the parser removes is page furniture, so a quote
          // that matches once whitespace is collapsed is intact.
          verdict = "verified";
          notes.push(
            `quote matches bytes ${block.byte_start}..${block.byte_end} (lines ${block.line_start}..${block.line_end})`,
            "quote spans dropped page furniture; it matches once whitespace is collapsed",
          );
        } else {
          verdict = "stale";
          notes.push("stored quote is not present at the recorded offsets in the current bytes");
        }
      }
    }

    const citations: Citation[] = matches.map((match) => {
      const block = this.store.getBlock(snapshot!.id, match.block_id);
      const section = this.store.getSectionById(snapshot!.id, match.section_id);
      return {
        citation_id: match.citation_id,
        document_id: `rfc-${snapshot!.rfc}`,
        snapshot_id: snapshot!.id,
        source_uri: snapshot!.source_url,
        locator: {
          section_path: section?.path ?? [],
          block_id: match.block_id,
          span: {
            byte_start: block?.byte_start ?? 0,
            byte_end: block?.byte_end ?? 0,
            char_start: block?.char_start ?? 0,
            char_end: block?.char_end ?? 0,
            codepoint_start: block?.codepoint_start ?? 0,
            codepoint_end: block?.codepoint_end ?? 0,
            line_start: block?.line_start ?? 0,
            line_end: block?.line_end ?? 0,
          },
        },
        quote: match.exact_text,
        quote_sha256: quoteHash(match.exact_text),
        observed_at: snapshot!.retrieved_at,
      };
    });

    return this.envelope(
      { verdict, matches: citations, notes },
      { snapshot, warnings, status: verdict === "verified" ? "ok" : verdict === "not_found" ? "degraded" : "partial" },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* status, capabilities, batch                                             */
  /* ---------------------------------------------------------------------- */

  async status(input: { include_failures?: boolean } = {}): Promise<Envelope<IndexStatus>> {
    const stats = this.store.status();
    const failures = input.include_failures ? this.store.recentFailures(10) : [];
    const state: IndexStatus["state"] = stats.snapshots > 0 || stats.last_catalog_sync !== null ? "ready" : "missing";
    const data: IndexStatus = {
      corpus_id: `rfc-mcp:${shortHash(this.store.path, 12)}`,
      state,
      index_generation: stats.index_generation,
      documents: {
        catalog: stats.catalog,
        snapshots: stats.snapshots,
        with_requirements: stats.with_requirements,
        stale: 0,
      },
      last_successful_sync: stats.last_document_sync,
      last_catalog_sync: stats.last_catalog_sync,
      parser_versions: stats.parser_versions,
      extractor_versions: stats.extractor_versions,
      offline: this.config.offline,
      failures: failures.map((failure) => ({ code: failure.code, at: failure.at, message: failure.message })),
    };
    const warnings: string[] = [];
    if (stats.last_catalog_sync === null) warnings.push("catalog_never_synced_run_sync_index");
    if (stats.catalog === 0) warnings.push("catalog_empty_run_sync_index");
    if (stats.snapshots === 0) warnings.push("no_documents_ingested_run_sync_rfc");
    return this.envelope(data, { warnings, freshness: this.config.offline ? "offline" : "cached" });
  }

  async capabilities(): Promise<Envelope<Record<string, unknown>>> {
    return this.envelope({
      contract: CONTRACT_VERSION,
      server: { name: this.config.productName, version: this.config.version },
      guarantees: [
        "Every analysis runs against a content-addressed immutable snapshot (snp_<hash>).",
        "Every derived fact carries a citation id that can be re-verified against the raw bytes.",
        "RFC text is treated as untrusted data, never as instructions.",
        "Errata are an overlay; they are never silently applied to publication text.",
        "No document text, metadata, or personal data is sent to any third party beyond the IETF/RFC Editor primary sources.",
      ],
      tools: [
        "capabilities",
        "resolve",
        "metadata",
        "read",
        "search",
        "requirements",
        "references",
        "dependencies",
        "diff",
        "errata",
        "history",
        "source",
        "verify_citation",
        "status",
        "batch",
      ],
      resources: [
        "rfc://index/status",
        "rfc://catalog/manifest",
        "rfc://snapshot/{snapshot_id}/metadata",
        "rfc://snapshot/{snapshot_id}/provenance",
        "rfc://snapshot/{snapshot_id}/outline",
        "rfc://snapshot/{snapshot_id}/sections/{section_id}",
        "rfc://snapshot/{snapshot_id}/blocks/{block_id}",
        "rfc://snapshot/{snapshot_id}/requirements/{requirement_id}",
        "rfc://snapshot/{snapshot_id}/references/{reference_id}",
        "rfc://snapshot/{snapshot_id}/citations/{citation_id}",
      ],
      prompts: ["brief", "requirements_audit", "compare", "dependency_review", "citation_check", "offline_review"],
      search_grammar: {
        free_text: true,
        quoted_phrase: true,
        filters: ["rfc:", "section:", "keyword:", "status:", "stream:", "author:", "relation:", "term:"],
        boolean_operators: {
          operators: ["OR", "AND", "NOT"],
          case_sensitive: true,
          note: "Upper case only. Lower-case or/and/not are ordinary words and are matched as text, because they occur inside RFC prose.",
          not_example: '"TSIG" OR "SIG(0)" NOT "TOFU"',
        },
        coverage: {
          catalog: "Every catalog entry: title, abstract, keywords, authors, status, stream.",
          text: "Only ingested documents. A zero-hit result from a partially ingested corpus is flagged in warnings; pass ensure_rfcs to ingest specific documents first.",
        },
        unsupported: ["raw SQL", "shell", "unbounded regex", "embedding search"],
      },
      reading_rules: [
        "A requirement count of 0 means no UPPER-CASE RFC 2119 keyword was found, not that a document states no requirements. Read requirements.non_strict_candidates before drawing that conclusion.",
        "non_strict_candidates is a lead list, not a contract. Filter on role=modal; role=unknown means the shape was not decidable without a parser and must be read, not assumed.",
        "A search result of 0 in text scope means the term is absent from the ingested documents, not from the RFC corpus. The coverage field states how much of the corpus was searched.",
        "An empty errata list is reported with the statuses that do have errata, so 'none of that status' and 'none at all' stay distinguishable.",
        "A read that lists blocks without source_map returns rows whose text is empty. Omit include entirely, or add source_map, to get the text.",
        "A snapshot id pins one derivation under one parser and extractor version. After a version bump the id is retired; the error names the document and its current id rather than reporting an unknown snapshot.",
      ],
      limits: this.config.limits,
      sources: [
        { name: "RFC Editor", hosts: ["www.rfc-editor.org"], role: "canonical metadata and publication files" },
        { name: "IETF Datatracker", hosts: ["datatracker.ietf.org"], role: "process metadata, relations, history" },
      ],
      policy: {
        http: "https only, allowlisted hosts, bounded size/time/concurrency, ETag revalidation, stale-on-error",
        xml: "DTD and entity declarations rejected; no XInclude resolution",
        privacy: "author email addresses are stripped at the source boundary",
        licensing: "RFC text is reproduced unmodified with attribution; see https://www.rfc-editor.org/series/rfc-use/",
      },
    });
  }

  async batch(input: BatchInput, context: RequestContext = {}): Promise<Envelope<Record<string, unknown>>> {
    if (input.operations.length === 0) {
      throw new RfcMcpError("INVALID_ARGUMENT", "operations must not be empty", { retryable: false });
    }
    if (input.operations.length > this.config.limits.maxBatchOperations) {
      throw new RfcMcpError(
        "LIMIT_EXCEEDED",
        `Batch is limited to ${this.config.limits.maxBatchOperations} operations`,
        {
          retryable: false,
        },
      );
    }
    const generationAtStart = this.store.getGeneration();
    const results: { op: string; status: string; data?: unknown; error?: unknown }[] = [];
    for (const operation of input.operations) {
      if (operation.op === "batch") {
        results.push({
          op: "batch",
          status: "failed",
          error: { code: "INVALID_ARGUMENT", message: "nested batch is not allowed" },
        });
        continue;
      }
      try {
        const data = await this.runOperation(operation, context);
        results.push({ op: operation.op, status: "ok", data });
      } catch (error) {
        results.push({
          op: operation.op,
          status: "failed",
          error: error instanceof RfcMcpError ? error.toJSON() : { code: "INTERNAL", message: String(error) },
        });
      }
    }
    const failed = results.filter((result) => result.status === "failed").length;
    return this.envelope(
      {
        results,
        complete: failed === 0,
        index_generation_at_start: generationAtStart,
        index_generation_now: this.store.getGeneration(),
      },
      {
        status: failed === 0 ? "ok" : failed === results.length ? "degraded" : "partial",
        appliedLimits: { max_batch_operations: this.config.limits.maxBatchOperations },
      },
    );
  }

  private async runOperation(operation: BatchOperation, context: RequestContext): Promise<unknown> {
    // Every operation is validated against the same schema as the tool it names, so
    // a batch cannot smuggle past a filter or a limit that the tool itself rejects.
    const { op, ...payload } = operation as { op: string } & Record<string, unknown>;
    const schema = BATCH_OPERATION_SCHEMAS[op];
    if (!schema) {
      throw new RfcMcpError("INVALID_ARGUMENT", `Unsupported batch operation: ${JSON.stringify(op)}`, {
        retryable: false,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const described = describeIssues(parsed.error, schema);
      throw new RfcMcpError("INVALID_ARGUMENT", `batch operation ${op}: ${described.message}`, {
        details: { op, problems: described.problems, unknown_keys: described.unknown_keys },
        retryable: false,
      });
    }
    const args = parsed.data;
    switch (op) {
      case "resolve":
        return (await this.resolve(args as ResolveInput, context)).data;
      case "metadata":
        return (await this.metadata(args as MetadataInput, context)).data;
      case "read":
        return (await this.read(args as ReadInput, context)).data;
      case "search":
        return (await this.search(args as SearchInput, context)).data;
      case "requirements":
        return (await this.requirements(args as RequirementsInput, context)).data;
      case "references":
        return (await this.references(args as ReferencesInput, context)).data;
      case "dependencies":
        return (await this.dependencies(args as DependenciesInput, context)).data;
      case "errata":
        return (await this.errata(args as ErrataInput, context)).data;
      case "history":
        return (await this.history(args as HistoryInput, context)).data;
      case "source":
        return (await this.source(args as SourceInput, context)).data;
      case "verify_citation":
        return (await this.verifyCitation(args as VerifyCitationInput, context)).data;
      case "status":
        return (
          await this.status({ include_failures: (args as { include_failures?: boolean }).include_failures === true })
        ).data;
      case "capabilities":
        return (await this.capabilities()).data;
      case "diff":
        return (await this.diff(args as DiffInput, context)).data;
      default:
        throw new RfcMcpError("INVALID_ARGUMENT", `Unsupported batch operation: ${JSON.stringify(op)}`, {
          retryable: false,
        });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Operator surface (CLI only, never a model-visible tool)                 */
  /* ---------------------------------------------------------------------- */

  async syncIndex(
    options: { signal?: AbortSignal } = {},
  ): Promise<{ inserted: number; updated: number; total: number }> {
    if (this.config.offline) {
      throw new RfcMcpError("UPSTREAM_BLOCKED", "Cannot sync the catalog in offline mode", { retryable: false });
    }
    let entries: Awaited<ReturnType<RfcEditorSource["fetchMiniIndex"]>>["entries"];
    let sourceUrl: string;
    try {
      ({ entries, sourceUrl } = await this.editor.fetchMiniIndex(options.signal));
    } catch (error) {
      throw new RfcMcpError(
        error instanceof RfcMcpError ? error.code : "UPSTREAM_UNAVAILABLE",
        "Catalog sync failed. The RFC Editor index is ~7 MB; raise RFC_MCP_INDEX_TIMEOUT_MS or retry.",
        { details: { ...(error instanceof RfcMcpError ? error.details : {}) }, cause: error },
      );
    }
    const records = entries.map((entry) => this.miniIndexToRecord(entry as unknown as Record<string, unknown>));
    const result = this.store.upsertCatalog(records);
    this.store.setMeta("last_catalog_sync", isoNow());
    this.store.setMeta("catalog_source_url", sourceUrl);
    this.logger.info("catalog.synced", { total: records.length, inserted: result.inserted, updated: result.updated });
    return { ...result, total: records.length };
  }

  async ingest(
    rfc: number,
    options: { refresh?: boolean; withXml?: boolean; signal?: AbortSignal },
  ): Promise<{ rfc: number; snapshot: string; changed: boolean; sections: number; requirements: number }> {
    const resolved = await this.ensureSnapshot(rfc, {
      refresh: options.refresh,
      withXml: options.withXml,
      signal: options.signal,
    });
    return {
      rfc,
      snapshot: resolved.snapshot.id,
      changed: true,
      sections: resolved.snapshot.section_count,
      requirements: resolved.snapshot.requirement_count,
    };
  }

  async ingestMany(
    rfcs: readonly number[],
    options: {
      refresh?: boolean;
      concurrency?: number;
      withXml?: boolean;
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
    },
  ): Promise<{ ok: number; failed: { rfc: number; code: string; message: string }[] }> {
    const failed: { rfc: number; code: string; message: string }[] = [];
    let done = 0;
    await mapWithConcurrency(rfcs, options.concurrency ?? this.config.maxConcurrency, async (rfc) => {
      try {
        await this.ingest(rfc, { refresh: options.refresh, withXml: options.withXml, signal: options.signal });
      } catch (error) {
        const code = codeOf(error);
        failed.push({ rfc, code, message: error instanceof Error ? error.message : String(error) });
        this.store.recordFailure(code, `rfc${rfc}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        done += 1;
        options.onProgress?.(done, rfcs.length);
      }
    });
    return { ok: rfcs.length - failed.length, failed };
  }

  /**
   * Re-derive the analysis of an already stored snapshot. Runs entirely
   * offline: the raw publication bytes are the only input, so a parser or
   * extractor version bump never requires re-fetching a document.
   */
  async reanalyze(rfc: number): Promise<{ rfc: number; from: string; to: string; changed: boolean }> {
    const previous = this.store.getLatestSnapshot(rfc, "txt");
    if (!previous) {
      throw new RfcMcpError("NOT_CACHED", `RFC ${rfc} has no stored snapshot to re-analyze`, {
        details: { rfc },
        retryable: false,
      });
    }
    const record = this.store.getCatalog(rfc);
    if (!record) {
      throw new RfcMcpError("CORPUS_UNAVAILABLE", `Catalog entry for RFC ${rfc} is missing`, { retryable: false });
    }
    const raw = this.store.getSnapshotRaw(previous.id);
    if (!raw) {
      throw new RfcMcpError("CORPUS_UNAVAILABLE", `Snapshot ${previous.id} has no stored bytes`, {
        retryable: false,
      });
    }
    const metadataHash = catalogHash(record);
    const snapshotId = `snp_${shortHash(
      `rfc${rfc}|txt|${previous.raw_sha256}|${metadataHash}|${this.config.parserVersion}|${this.config.extractorVersion}`,
    )}`;
    if (snapshotId === previous.id) {
      return { rfc, from: previous.id, to: previous.id, changed: false };
    }
    const parsed = parseRfcText({ rfc, snapshotId, raw, parserVersion: this.config.parserVersion });
    const normative = analyzeNormative({ snapshotId, rfc, sections: parsed.sections, blocks: parsed.blocks });
    const references = analyzeReferences({ snapshotId, rfc, sections: parsed.sections, blocks: parsed.blocks });
    this.store.commitDocument({
      record,
      snapshot: {
        id: snapshotId,
        rfc,
        format: "txt",
        rawSha256: previous.raw_sha256,
        bytes: previous.bytes,
        raw,
        retrievedAt: previous.retrieved_at,
        sourceUrl: previous.source_url,
        etag: previous.etag,
        lastModified: previous.last_modified,
        parserVersion: this.config.parserVersion,
        extractorVersion: this.config.extractorVersion,
        quality: parsed.quality,
        warnings: [...parsed.warnings, ...normative.warnings, ...references.warnings],
        metadataHash,
      },
      sections: parsed.sections,
      blocks: parsed.blocks,
      mentions: normative.mentions,
      requirements: normative.requirements,
      references: references.references,
    });
    this.logger.info("document.reanalyzed", { rfc, from: previous.id, to: snapshotId });
    return { rfc, from: previous.id, to: snapshotId, changed: true };
  }

  private miniIndexToRecord(entry: Record<string, unknown>): CatalogRecord {
    const number = typeof entry.number === "number" ? entry.number : Number.parseInt(String(entry.number), 10);
    const identifiers = Array.isArray(entry.identifiers)
      ? (entry.identifiers as { type?: unknown; value?: unknown }[])
          .filter((item) => typeof item.type === "string" && typeof item.value === "string")
          .map((item) => ({ type: item.type as string, value: item.value as string }))
      : [];
    const formats = Array.isArray(entry.formats)
      ? (entry.formats as { format?: unknown }[])
          .map((item) => (typeof item === "string" ? item : String((item as { format?: unknown }).format ?? "")))
          .filter(Boolean)
          .map((format) => format.toLowerCase())
      : [];
    const record = normalizeCommon(
      number,
      entry,
      isoNow(),
      `https://www.rfc-editor.org/api/v1/rfc-common/${number}.json`,
    );
    return {
      ...record,
      identifiers: identifiers.length > 0 ? identifiers : record.identifiers,
      formats: formats.length > 0 ? [...new Set(formats)].sort() : record.formats,
      subseries: Array.isArray(entry.subseries)
        ? (entry.subseries as { type?: unknown; number?: unknown }[])
            .filter((item) => typeof item.type === "string" && typeof item.number === "number")
            .map((item) => ({
              type: item.type as string,
              number: item.number as number,
              label: `${String(item.type).toUpperCase()} ${item.number as number}`,
            }))
        : record.subseries,
    };
  }
}

/* -------------------------------------------------------------------------- */

export type BatchOperation =
  | ({ op: "resolve" } & ResolveInput)
  | ({ op: "metadata" } & MetadataInput)
  | ({ op: "read" } & ReadInput)
  | ({ op: "search" } & SearchInput)
  | ({ op: "requirements" } & RequirementsInput)
  | ({ op: "references" } & ReferencesInput)
  | ({ op: "dependencies" } & DependenciesInput)
  | ({ op: "diff" } & DiffInput)
  | ({ op: "errata" } & ErrataInput)
  | ({ op: "history" } & HistoryInput)
  | ({ op: "source" } & SourceInput)
  | ({ op: "verify_citation" } & VerifyCitationInput)
  | { op: "status"; include_failures?: boolean }
  | { op: "capabilities" }
  | { op: "batch" };

/**
 * Query filters that mean something only for ingested text and therefore cannot be
 * applied to a catalog title/abstract search. Reported as a warning so a caller can
 * tell a broad answer from a scoped one.
 */
function unsupportedCatalogFilters(query: ParsedQuery): string[] {
  const unsupported: string[] = [];
  if (query.sectionPrefix !== null) unsupported.push("section");
  if (query.relation !== undefined) unsupported.push("relation");
  return unsupported;
}

const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

function decodedText(raw: Buffer, charStart: number, charEnd: number): string {
  return DECODER.decode(raw).slice(charStart, charEnd);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function codeOf(error: unknown): string {
  return error instanceof RfcMcpError ? error.code : "INTERNAL";
}

function stable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type { UpstreamMetadata };
