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
  type Completeness,
  type CoverageVerdict,
  type DiffCoverage,
  type DiffCoverageSide,
  type DiffResult,
  type Envelope,
  type Erratum,
  type GraphResult,
  type HistoryEntry,
  type IndexStatus,
  type NormativeCandidate,
  type Provenance,
  type ReadResult,
  type ResolveResult,
  type SearchHit,
  type Section,
  type Snapshot,
} from "../core/types.js";
import { canonicalErrataStatus, type ErrataStatus } from "../core/types.js";
import { citationId, citationIdKind, quoteHash, stableCitationId, textHash } from "../analysis/citation.js";
import { diffDocuments, type DiffMode, type DiffSide } from "../analysis/diff.js";
import { analyzeReferences, buildGraph } from "../analysis/references.js";
import {
  analyzeDeclarativeSpecifications,
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
  /**
   * Ingest the top N catalog matches for this query before searching their text.
   *
   * This closes the discovery loop. `ensure_rfcs` needs numbers the caller already
   * has, which is no help for "which RFC describes X" over a corpus of 9842 entries
   * of which 121 are ingested — and guessing a number is how a caller ends up reading
   * RFC 4649 expecting DANE. The catalog indexes title, abstract, keywords, authors,
   * status and stream for every document, so it can propose the numbers.
   */
  readonly ensure_top_catalog_hits?: number;
  readonly max_results?: number;
  readonly cursor?: string;
  readonly context_chars?: number;
  readonly block_kinds?: string[];
}

/** One scope a search consulted, what it covers, and what it found there. */
export interface SearchScopeCoverage {
  readonly scope: "catalog" | "text";
  /** Documents that scope covers: every catalog entry, or the ingested documents. */
  readonly documents: number;
  /** The fields it matched on, in words. */
  readonly fields: string;
  /** Matches in that scope, or `null` where the scope was not searched. */
  readonly total: number | null;
}

export interface SearchCorpus {
  readonly generation: number;
  /** Documents in the scope the answer came from. */
  readonly documents: number;
  readonly catalog_documents: number;
  /**
   * Every scope this call consulted, as one string, including the ones that produced no
   * hits. It used to name the scope the answer came from and nothing else, so on the
   * auto path - where the catalog over all 9842 entries is searched first and the text
   * index second - a caller read a string about 159 documents and concluded the search
   * had been limited to them.
   */
  readonly coverage: string;
  /** The same thing, branchable. `coverage` is a sentence; this is the evidence. */
  readonly scopes: readonly SearchScopeCoverage[];
}

/**
 * What a zero-result search is a zero OF.
 *
 * The defect: `no_text_match` plus `coverage: "ingested_text_only:159/9842"` is returned
 * both for "this term is in no RFC" and for "this term is not in the 159 documents you
 * happen to have loaded", and the two responses are otherwise identical. A caller
 * therefore cannot conclude absence, which is the only reason to run the query.
 *
 * `consultable` is the field to branch on. It is true when every document the query could
 * have been answered from was actually searched: either the catalog was searched and found
 * nothing, or the query named its documents with `rfc:` and all of them are ingested. A
 * query that names RFC 2328, which is loaded, and finds nothing IS a statement about RFC
 * 2328; the same query naming an RFC that is not loaded is not a statement about anything.
 */
export interface SearchMiss {
  readonly consultable: boolean;
  readonly reason:
    | "named_documents_not_ingested"
    | "named_documents_searched"
    | "absent_from_the_catalog_and_from_every_ingested_document"
    | "documents_not_ingested"
    | "absent_from_every_ingested_document"
    | "absent_from_every_catalog_entry";
  readonly searched: readonly ("catalog" | "text")[];
  readonly ingested_documents: number;
  readonly catalog_documents: number;
  /** Catalog entries whose text no search can reach, which is what a corpus gap means. */
  readonly catalog_documents_without_text: number;
  readonly named_rfcs?: readonly number[];
  readonly named_rfcs_ingested?: readonly number[];
  readonly remedy: string;
}

export interface RequirementsInput extends Anchor {
  readonly scope?: string;
  readonly term?: string;
  readonly keyword?: string;
  /** Keep only candidates whose keyword is in modal position. */
  readonly role?: "modal" | "non_modal" | "unknown";
  /** Keep only candidates of this functional shape, under the action-verb test. */
  readonly shape?: "demand" | "description" | "list_introducer" | "indeterminate";
  /**
   * Include requirement-shaped statements the strict upper-case extractor rejected.
   * Default true: without them a count of 0 cannot be told apart from a parser gap.
   */
  readonly include_candidates?: boolean;
  /**
   * Also return the surviving candidates in `requirements`, each flagged
   * `provisional: true`. A document that predates RFC 2119 states its rules without
   * the keywords, and a caller building a compliance list needs them; they stay
   * out of `coverage.total_requirements` so no count is ever inflated.
   */
  readonly include_provisional?: boolean;
  readonly max_candidates?: number;
  /**
   * Cap on the keyword-free channel (`non_strict_candidates.declarative_specifications`).
   *
   * Separate from `max_candidates` because the two lists are different questions: one is
   * statements with a keyword in the wrong case, the other is specifications with no
   * keyword at all, and a document that runs out of budget on the first must not lose the
   * second. A clamp is reported in `warnings` the way `max_results`'s is.
   */
  readonly declarative_limit?: number;
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
  /**
   * Either kind of identifier. `cit_…` pins one derivation and is only `verified` against
   * it. `scit_…` is hashed from the RFC number, the section NUMBER and the exact text, so
   * it survives a re-derivation and resolves in more than one snapshot; resolving it
   * outside a snapshot that minted it is `stale`, not `verified`, because "this text is
   * still in the document" and "this text is in the document you pinned" are different
   * claims. A stable id is a hash and cannot be inverted, so resolving one needs `rfc`
   * and `section` as well; pass both.
   */
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

/**
 * What `verify_citation` answered, and which question it answered.
 *
 * `citation_id_kind` is the whole point of the field list. `verified` means "this
 * derivation" for a snapshot-scoped id and "this text, in a snapshot that minted it" for
 * a stable one, and a caller holding a contract line has to be able to tell which claim
 * it got. `minted_in` is the evidence for the stable case: the snapshots whose stored rows
 * carry the id, which is the only record of where a citation came from, because a parser
 * bump deletes the snapshot it retired.
 */
export interface VerifyCitationResult {
  readonly verdict: CitationVerdict;
  readonly matches: Citation[];
  readonly notes: string[];
  /** `unrecognized` covers "no id was given" and "the id matches neither shape". */
  readonly citation_id_kind: "snapshot_scoped" | "stable" | "unrecognized";
  readonly citation_id: string | null;
  /** Snapshots whose rows carry this stable id; always empty on the snapshot-scoped path. */
  readonly minted_in: string[];
}

/** One sentence of a section, located in the bytes of the snapshot. */
interface SentenceSpan {
  readonly text: string;
  readonly text_sha256: string;
  readonly block_id: string;
  readonly section_id: string;
  readonly char_start: number;
  readonly char_end: number;
  readonly byte_start: number;
  readonly byte_end: number;
  readonly line_start: number;
  readonly line_end: number;
}

const CURSOR_SECRET_ENV = "RFC_MCP_CURSOR_SECRET";

/**
 * The prefix every keyword-free warning carries, and the partition between the two
 * channels' warnings.
 *
 * `analyzeNormativeCandidates` returns one `warnings` array holding both channels', and
 * the extractor names each of its keyword-free warnings `declarative_…` while naming none
 * of its candidate warnings that way. So the split is exact, and it is made in one place
 * instead of by prefixing the whole array with `candidates:` - which is how a count taken
 * by the keyword-free pass over a document's prose arrived as
 * `candidates:declarative_list_item_excluded:40`.
 */
const DECLARATIVE_WARNING_PREFIX = "declarative_";

/** Ceiling on `declarative_limit`, matching `max_candidates`. */
const MAX_DECLARATIVE_LIMIT = 2000;

/**
 * The keyword-free channel, in the object it ships in.
 *
 * RFC 8174 section 2, restating RFC 2119, says of the eleven keywords: "a lot of
 * normative text does not use them and is still normative". These rows are that text, and
 * they are NOT requirements: they have no keyword, so RFC 8174 section 3 gives them no
 * force to be counted by, and nothing here enters `requirements` or
 * `coverage.total_requirements` with or without `include_provisional`. `basis` says which
 * published test the sentence passed - a quantity, a copula definition or a field default
 * - and it is not a strength: read the sentence. The selection rule and its exclusions are
 * published where they are implemented, and `declarative_excluded` counts what each one
 * dropped, because a filter nobody can see is not a filter.
 */
const DECLARATIVE_NOTE =
  "Prose that states a specification with no RFC 2119 keyword anywhere in the sentence, which RFC 8174 section 2 says is still normative. These are NOT requirements and are excluded from coverage.total_requirements; they are the only channel that can see a document that states its rules without the keyword language. Scanned over every block of the document, not only the ones a keyword appears in, so a paragraph whose only specification is a bound is reachable. `basis` names which test the sentence passed and is not a strength. Rows ship on page 1 only, as the candidate rows do; declarative_omitted_on_page is 0 on the page that carries them. The rows are truncated at declarative_limit, and declarative_truncated says so.";

/**
 * Warning keys that decide `coverage.completeness`, named once so the verdict and the
 * warning list are built from the same strings.
 *
 * The four are the reasons a caller can be given `partial` and the one it can be given
 * `unknown`. Each is also a warning key, which is what makes the anti-drift test
 * possible: every key in `completeness_warnings` must appear as a key in `warnings`.
 */
const NORMATIVE_IN_UNSCANNED = "normative_text_in_unscanned_blocks";
const UNSCANNED_MAY_CONTAIN_NORMATIVE = "unscanned_blocks_may_contain_normative_text";
const REQUIREMENT_ROWS_ARE_FRAGMENTS = "requirement_rows_are_fragments";
const ZERO_WITHOUT_KEYWORD_USAGE = "zero_requirements_without_a_keyword_usage_notice";
const COVERAGE_COUNTERS_UNRECONCILABLE = "coverage_counters_not_reconcilable";

/**
 * Skipped blocks the extractor declined on their KIND alone, which is the whole question
 * `keyword_bearing_blocks_skipped` cannot answer.
 *
 * A bibliography, an authors' address and an index are skipped by section, and nothing in
 * them is an obligation: a "MUST" in a reference entry is a citation quoting a document
 * that uses the word. They are reported in `blocks_skipped_by_kind` as `section:<kind>` and
 * they are NOT counted here - the design excludes them on purpose, and a counter that
 * counted them would be counting a design decision as a loss.
 *
 * A table, a figure and preformatted text are skipped on the block's kind, with no way to
 * look inside, and RFC 1035 writes "Z  Reserved for future use.  Must be zero in all
 * queries and responses." in a field-definition block. So is every kind except `heading`,
 * which is a title by construction. Written as "everything that is not a skipped section
 * and not a heading" rather than as an allowlist of the kinds measured so far, because a
 * false `partial` costs a reader one more line and a false `complete` costs them a contract.
 */
function skippedBlocksThatMayHoldNormativeText(byKind: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [kind, count] of Object.entries(byKind)) {
    if (kind.startsWith("section:") || kind === "heading") continue;
    total += count;
  }
  return total;
}

/**
 * `keyword_usage` in a completeness basis that did not run the probe.
 *
 * Distinct from `absent`, which is what the probe found. A diff reports each side's
 * completeness without loading its keyword blocks, and a basis that said `absent` would be
 * claiming a measurement nobody took.
 */
const KEYWORD_USAGE_NOT_MEASURED = "not_measured";

/**
 * A zero in catalog scope, which is a statement about every document that exists.
 *
 * The contrast the field is for: a zero in text scope from a corpus that holds 159 of
 * 9 842 documents is not a statement about the corpus, and the two responses used to be
 * indistinguishable. Here the catalog is the whole corpus, so `consultable` is true
 * without a measurement - and `remedy` says so instead of offering to ingest something.
 */
function catalogMiss(catalogDocuments: number, ingestedDocuments: number): SearchMiss {
  return {
    consultable: true,
    reason: "absent_from_every_catalog_entry",
    searched: ["catalog"],
    ingested_documents: ingestedDocuments,
    catalog_documents: catalogDocuments,
    catalog_documents_without_text: 0,
    remedy:
      "the term is in no title, abstract, keyword, author, status or stream of any catalogued document. A document absent from the catalog entirely is a different question this index cannot answer.",
  };
}

/**
 * What the diff's `coverage.note` says, in words, for the caller who has to act on it.
 *
 * A typed field says what happened; a caller still has to decide what to do about it, and
 * the three failure modes want three different actions. An empty side wants another axis.
 * A text-mode fallback wants a document pair under the ceiling. Two incomplete sides want
 * the caveat read before the finding is.
 */
function diffCoverageNote(input: {
  readonly mode: string;
  readonly reason: DiffCoverage["reason"];
  readonly left: DiffCoverageSide;
  readonly right: DiffCoverageSide;
  readonly lineHunks: number;
  readonly changes: number;
}): string {
  const pair = `left=${input.left.items} right=${input.right.items}`;
  switch (input.reason) {
    case "both_sides_contributed":
      return input.mode === "text"
        ? `Line hunks over the two published texts, not a semantic diff: the same sentence reworded is a deletion and an addition. ${input.lineHunks} hunk(s) in ${input.changes} change(s).`
        : `${input.mode} axis. ${pair} items compared, ${input.changes} change(s). coverage.clean is false when either side's extraction is incomplete, so read completeness before reading an empty result as "nothing changed".`;
    case "mode_fell_back_to_structure":
      return `mode "text" returned ${input.changes} structural change(s) and 0 line hunks, so the line diff did NOT run and nothing here is a text difference: the underlying pass gives up on documents over a per-side line ceiling and returns the structural diff, which is byte-identical to mode "structure" on the same pair. The changes are left in place because they are real. Diff two documents small enough for a line diff to run, or use mode "structure" and say that is what you are reading.`;
    case "texts_differ_but_no_line_hunk_was_produced":
      return 'The two snapshots have different published bytes and mode "text" produced no line hunk and no change at all, so the empty result is a question that was not asked rather than a finding that nothing changed.';
    case "left_contributed_nothing":
      return `Nothing to compare on the ${input.mode} axis: the left document contributed 0 items and the right contributed ${input.right.items}. An empty change list here is an unanswered question, not a finding that the two documents agree. Diff another axis - structure or references - or read the left document's non_strict_candidates, which is where a specification that states its rules without a keyword puts them.`;
    case "right_contributed_nothing":
      return `Nothing to compare on the ${input.mode} axis: the right document contributed 0 items and the left contributed ${input.left.items}. An empty change list here is an unanswered question, not a finding that the two documents agree.`;
    case "neither_side_contributed":
      return `Nothing to compare on the ${input.mode} axis: BOTH documents contributed 0 items, so an empty change list is the only possible answer and says nothing about whether the two documents agree. An unanswered question is not a finding of no change.`;
  }
}

/**
 * What the candidate list is, on the page that carries the rows.
 *
 * On later pages `non_strict_candidates.note` says where the rows are instead, and that
 * is the only difference between the two: the counts are identical on every page, so a
 * reader who pages does not get a different answer, only the same answer without the
 * bytes.
 */
const CANDIDATE_NOTE =
  "Requirement-shaped statements the strict upper-case extractor rejected, one row per statement (all its keywords are in `keywords`). Per RFC 8174 section 3 an uncapitalised keyword has no normative force, so these are NOT requirements; they are reported so a zero requirement count is not mistaken for the absence of normative language. keyword_case says which capitalisation was found; reason names the structural cause when capitalisation is not the only one. role says whether the keyword is in modal position. shape applies the action-verb test - a clause with no action verb cannot state an obligation - which is a widely used convention and NOT a rule of RFC 2119, whose section 3 is the list of keyword definitions; so shape=demand means the clause looked like an obligation, not that the specification requires one. role=unknown and shape=indeterminate are real answers, not passes — read them. continues_previous_block means a page break split the sentence and this row is only its second half; the full statement spans the previous block. Bibliographies, the authors' address and the index are excluded, as they are for the strict count. The rows are shipped on page 1 only; later pages carry the counts with an empty candidates array and omitted_on_page set to the page number.";

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

    // Two renderings, and which one is called `text` was decided against the hazard
    // rather than in favour of it. `text` used to be the verbatim slice, so on a
    // pre-1990 RFC it handed a caller the printed page's running head and a raw form
    // feed — and the obvious field to copy from was the one carrying printing
    // artefacts. Five review rounds reported it, and answering that it was by design
    // never made the next read any safer.
    //
    // The verbatim slice is not dropped and its span still denotes it: it is
    // `text_verbatim`, it is what `section` carries with its source map, and it is
    // what a byte-anchored caller needs. Citations do not depend on any of this —
    // `verify_citation` works on blocks, which have been furniture-free since
    // rfc-text-1.3.0. So the safe rendering takes the plain name and the exact one
    // takes the explicit one. `text_clean` is kept as an alias of `text` for callers
    // written against 0.2.0.
    const furnitureLines = resolvedSection.furniture_lines ?? [];
    const verbatim = resolvedSection.text;
    const rendered =
      furnitureLines.length > 0 ? blankLines(verbatim, furnitureLines, resolvedSection.line_start) : verbatim;
    if (furnitureLines.length > 0) {
      warningsOut.push(
        `section_text_had_page_furniture_removed_on_lines:${furnitureLines.join(",")}:text_verbatim_is_the_exact_slice`,
      );
    }
    let text = input.format === "structured" ? null : rendered;
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
            // The exact slice, for a caller anchoring to bytes. `text` is the same
            // content with the printing artefacts removed; both are reported so a
            // change in one is visible rather than silent.
            //
            // `text_fidelity` has to name `page_furniture_lines`, not merely promise
            // that the two renderings have equal line counts. Equal counts is true and
            // useless on its own: a caller reading only that sentence cannot learn
            // which lines were emptied, and the emptying is the reason both renderings
            // are on the response at all.
            text_verbatim: verbatim,
            text_sha256_verbatim: resolvedSection.text_sha256,
            text_clean: text,
            page_furniture_lines: furnitureLines,
            text_fidelity:
              "text has page furniture removed; text_verbatim is the byte-exact slice its char and byte span denote. Line counts are equal in both, and page_furniture_lines lists the line numbers emptied to get it.",
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
      corpus: SearchCorpus;
      miss?: SearchMiss;
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

    // "Which RFC describes X" over 9842 catalogued documents and 121 ingested ones
    // needs a proposal step, not a guessed number. The catalog covers every document,
    // so its top hits are the candidates to ingest. Reported with their titles, because
    // the failure this prevents is reading the wrong document and not noticing.
    let proposed: { rfc: number; title: string }[] = [];
    if (input.ensure_top_catalog_hits !== undefined && input.ensure_top_catalog_hits > 0 && match !== null) {
      const want = clamp(input.ensure_top_catalog_hits, 1, 20);
      const catalogue = this.store.searchCatalog({ match, limit: want, offset: 0 });
      proposed = catalogue.rows.map((row) => ({ rfc: row.rfc, title: row.title }));
      for (const candidate of proposed) {
        try {
          const resolved = await this.ensureSnapshot(candidate.rfc, { signal: context.signal });
          ensured.push(resolved.snapshot.rfc);
        } catch (error) {
          warnings.push(`ensure_catalog_hit_${candidate.rfc}_failed:${codeOf(error)}`);
        }
      }
      warnings.push(`ingested_top_catalog_hits:${proposed.map((entry) => entry.rfc).join(",")}`);
    }

    const generation = this.store.getGeneration();
    const binding = `${generation}|${input.scope ?? "auto"}|${stable(input.query)}|${limit}`;
    const offset = input.cursor ? decodeCursor(input.cursor, this.cursorSecret, binding).o : 0;

    let scope = input.scope ?? "auto";
    // The catalog probe `auto` runs before it falls back to text is a search over all
    // 9 842 catalogued documents, and its result is what chose the scope. It used to be
    // discarded, so a caller reading `corpus.coverage` on the fallback path saw a string
    // naming only the 159 ingested documents and concluded the search had been limited to
    // them - the opposite of what happened, and the conclusion the field exists to prevent.
    // It is kept, and reported, because it is half the evidence for what a zero means.
    let catalogProbed: number | null = null;
    if (scope === "auto") {
      if (match === null) scope = "catalog";
      else {
        catalogProbed = this.countCatalogMatches(match, query);
        scope = catalogProbed > 0 ? "catalog" : "text";
      }
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
            scopes: [
              {
                scope: "catalog",
                documents: catalogDocuments,
                fields: "title, abstract, keywords, authors, status, stream",
                total: result.total,
              },
            ],
          },
          ...(result.total === 0 ? { miss: catalogMiss(catalogDocuments, ingestedDocuments) } : {}),
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
    // Every scope this call consulted, with what it covers and what it found. The string
    // below names all of them too, but a string cannot be branched on and this can.
    const scopes: SearchScopeCoverage[] = [];
    if (catalogProbed !== null) {
      scopes.push({
        scope: "catalog",
        documents: catalogDocuments,
        fields: "title, abstract, keywords, authors, status, stream",
        total: catalogProbed,
      });
    }
    scopes.push({
      scope: "text",
      documents: ingestedDocuments,
      fields: "block text of the ingested documents only",
      total,
    });
    // A zero, and what it is a zero OF. The two cases a caller cannot otherwise tell apart
    // are measured, not guessed: "this term is in no document you can search" and "this
    // term is in no document you HAVE loaded", which are the same response and opposite
    // conclusions. The `rfc:` filter decides between them when it is present, because a
    // query that names its documents can say whether those documents were searched.
    const namedIngested = query.rfcs.filter((rfc) => this.store.getLatestSnapshot(rfc, "txt") !== null);
    const namedMissing = query.rfcs.filter((rfc) => this.store.getLatestSnapshot(rfc, "txt") === null);
    // `consultable` is true when every document the query could have been answered from was
    // actually searched, and it is deliberately NOT satisfied by a catalog search over all
    // 9 842 entries. The catalog is metadata: a term in no title or abstract is not a term
    // in no document, and 9 683 documents' TEXT was never searched. A free-text query is
    // answered by the text, so it is consultable only when the whole catalog's text is
    // indexed, or when the query named its documents with `rfc:` and all of them are
    // ingested. That is the distinction the old response could not express: `no_text_match`
    // plus a coverage string read the same for "no such thing" and "not in what you have".
    const wholeCorpusIndexed = catalogDocuments === 0 || ingestedDocuments >= catalogDocuments;
    const miss: SearchMiss | null =
      total === 0
        ? {
            consultable: (query.rfcs.length > 0 && namedMissing.length === 0) || wholeCorpusIndexed,
            // The reason has to agree with `consultable`: a caller reading the two together
            // must not find a zero described as inconclusive on one line and conclusive on
            // the next.
            reason:
              namedMissing.length > 0
                ? "named_documents_not_ingested"
                : query.rfcs.length > 0
                  ? "named_documents_searched"
                  : !wholeCorpusIndexed
                    ? "documents_not_ingested"
                    : catalogProbed === 0
                      ? "absent_from_the_catalog_and_from_every_ingested_document"
                      : "absent_from_every_ingested_document",
            searched: scopes.map((entry) => entry.scope),
            ingested_documents: ingestedDocuments,
            catalog_documents: catalogDocuments,
            catalog_documents_without_text: Math.max(0, catalogDocuments - ingestedDocuments),
            ...(query.rfcs.length > 0 ? { named_rfcs: query.rfcs, named_rfcs_ingested: namedIngested } : {}),
            // The remedy has to follow the verdict. Telling a caller to resolve a document
            // it already resolved, or to ingest a document that is already loaded, is the
            // same class of defect as a field that names the wrong scope: advice that
            // cannot be acted on is worse than no advice, because it costs a round trip to
            // discover.
            remedy:
              namedMissing.length > 0
                ? `resolve ${namedMissing.join(", ")} first, or pass ensure_rfcs: [${namedMissing.join(", ")}]`
                : query.rfcs.length > 0
                  ? `the term is absent from ${query.rfcs.join(", ")}, which ${namedIngested.length === query.rfcs.length ? "is ingested and was searched in full" : "could not be searched"}`
                  : !wholeCorpusIndexed
                    ? "resolve the RFC you mean first, or pass ensure_rfcs / ensure_top_catalog_hits"
                    : catalogProbed === 0
                      ? "the term is in no title, abstract, keyword, author, status or stream of any catalogued document, and in no ingested document. A document absent from the catalog entirely is a different question this index cannot answer."
                      : "the term is absent from every document that was searched",
          }
        : null;
    if (miss !== null) {
      warnings.push(
        `zero_results:${miss.reason}:consultable=${String(miss.consultable)}:searched=${miss.searched.join("+")}`,
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
          // Every scope this call consulted, not just the one it answered from. The old
          // value named the text index alone even on the auto path where the catalog had
          // already been searched over all 9842 documents, so a caller reading it
          // concluded the search was narrower than it was - the opposite of the truth, and
          // the inference the field exists to prevent.
          coverage: scopes
            .map((entry) =>
              entry.scope === "catalog"
                ? `catalog_titles_and_abstracts:${entry.documents}/${entry.documents}`
                : `ingested_text_only:${entry.documents}/${catalogDocuments}`,
            )
            .join("+"),
          scopes,
        },
        ...(miss === null ? {} : { miss }),
        ...(ensured.length > 0 ? { ensured_rfcs: ensured } : {}),
        ...(proposed.length > 0 ? { catalog_hits_ingested: proposed } : {}),
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
    corpus: SearchCorpus;
    miss?: SearchMiss;
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
    // The catalog IS the whole corpus here, so a zero is a statement about every document
    // that exists and `consultable` is unconditionally true. Which is the whole reason the
    // field exists: this path and the text path used to return the same shape for a zero,
    // and only one of them was entitled to the conclusion.
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
          scopes: [
            {
              scope: "catalog",
              documents: catalogDocuments,
              fields: "title, abstract, keywords, authors, status, stream",
              total: result.total,
            },
          ],
        },
        ...(result.total === 0 ? { miss: catalogMiss(catalogDocuments, this.store.status().snapshots) } : {}),
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

  /**
   * May a caller treat `coverage.total_requirements` as the document's normative content?
   *
   * The verdict every other number on the response is read through, and the reason it
   * exists: the tool's honesty lived in `warnings` and its assertions in `coverage`, and a
   * compliance contract is a machine-readable artefact, so it reads the assertions. A
   * caller who wanted to assert `total_requirements === 0` in a test had nothing to assert
   * on - 355 and 0 and 1 came back in the same shape, with the same
   * `keyword_bearing_blocks_skipped` field meaning "I checked" on a document that had not
   * been checked.
   *
   * Three values, from measured facts and never from advice, and all three reachable:
   *
   *   complete  every prose block was scanned, nothing was skipped out of a kind that could
   *             hold a rule, no emitted row is a fragment, and a zero carries a notice that
   *             says why it is zero.
   *   partial   a known loss exists. The basis names which.
   *   unknown   the stored counters cannot be reconciled with the block total, so the
   *             question was not asked of anything. Reachable because it happens: a corpus
   *             derived before the counters were recorded reports zeros, and a caller that
   *             read those zeros as "nothing was skipped" would be reading an absence of
   *             measurement as a measurement of absence.
   *
   * Measured over the 182-document corpus, no document reaches `complete`, and the reason
   * is not a near miss: every RFC contains at least one `table` or `preformatted` block,
   * and a block the extractor refuses to read on its KIND alone cannot be ruled out as
   * holding a rule. `keyword_bearing_blocks_skipped` cannot close that gap - a protocol
   * that states its obligations in a state-machine table carries no keyword to count - so
   * the verdict does not pretend otherwise. The honest answer for this corpus is `partial`
   * everywhere, and the number that says so is now on the response instead of being
   * something a reader has to derive from `blocks_skipped_by_kind`.
   */
  private completeness(input: {
    readonly snapshot: Snapshot;
    readonly counters: {
      readonly unscanned: number;
      readonly keywordBearing: number;
      readonly byKind: Record<string, number>;
    };
    readonly totalRequirements: number;
    readonly keywordUsageStance: string | null;
    readonly fragmentRows: number;
  }): CoverageVerdict {
    const { snapshot, counters } = input;
    const scanned = snapshot.prose_block_count;
    const blocks = snapshot.block_count;
    const mayHoldNormative = skippedBlocksThatMayHoldNormativeText(counters.byKind);
    // The counters are written in three columns by one function. If they do not add up to
    // the block total, two different builds wrote them, or none did, and the numbers
    // cannot be added to anything.
    const countersWritten = blocks > 0 && scanned > 0;
    const countersReconcile = scanned + counters.unscanned === blocks;
    const reasons: string[] = [];
    if (!countersWritten || !countersReconcile) {
      reasons.push(COVERAGE_COUNTERS_UNRECONCILABLE);
    } else {
      if (mayHoldNormative > 0) reasons.push(UNSCANNED_MAY_CONTAIN_NORMATIVE);
      if (counters.keywordBearing > 0) reasons.push(NORMATIVE_IN_UNSCANNED);
      if (input.fragmentRows > 0) reasons.push(REQUIREMENT_ROWS_ARE_FRAGMENTS);
      // The certificate of absence. A document that is not about the requirement language
      // cannot produce a confident `complete` on a zero count, because the extractor has
      // no way to tell "this RFC states no requirements" from "this RFC states them in a
      // form the extractor does not read". `keyword_usage` is that notice, and it is
      // absent on exactly the documents where a zero needs explaining: measured on the
      // corpus, RFC 2328 and RFC 959 have 0 and 1 requirements and no notice, while 5321,
      // 8446 and 9110 all have one. A zero WITH the notice is explicable and stays
      // eligible; a zero without it is a gap, and it says so.
      if (
        input.totalRequirements === 0 &&
        (input.keywordUsageStance === null || input.keywordUsageStance === KEYWORD_USAGE_NOT_MEASURED)
      ) {
        reasons.push(ZERO_WITHOUT_KEYWORD_USAGE);
      }
    }
    const completeness: Completeness = reasons.includes(COVERAGE_COUNTERS_UNRECONCILABLE)
      ? "unknown"
      : reasons.length > 0
        ? "partial"
        : "complete";
    const basis = [
      "scope:document",
      `prose_blocks:${blocks}`,
      `scanned:${scanned}`,
      `skipped:${counters.unscanned}`,
      `may_hold_normative:${mayHoldNormative}`,
      `keyword_bearing_skipped:${counters.keywordBearing}`,
      `fragment_rows:${input.fragmentRows}`,
      `total_requirements:${input.totalRequirements}`,
      `keyword_usage:${input.keywordUsageStance ?? "absent"}`,
    ].join(" ");
    return { completeness, basis, reasons };
  }

  async requirements(
    input: RequirementsInput,
    context: RequestContext = {},
  ): Promise<Envelope<Record<string, unknown>>> {
    void context;
    const { snapshot, record, warnings, freshness, pinned } = await this.anchor(input, {
      refresh: input.refresh,
      signal: context.signal,
    });
    const asked = input.max_results;
    const ceiling = this.config.limits.maxPageSize;
    const limit = clamp(asked ?? Math.min(this.config.limits.maxSearchResults, ceiling), 1, ceiling);
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
    // A clamp that is not reported is indistinguishable from a smaller corpus. The
    // caller asked for 500 rows and got 200; the response says so rather than leaving
    // `limits.applied` as the only place it shows up.
    if (asked !== undefined && asked > limit) {
      warningsOut.push(`max_results_clamped:${asked}->${limit}:max_results_accepts_up_to_${ceiling}`);
    }

    // The loss counter, raised on every response and not only at re-derivation: tables
    // and preformatted text are out of scope by design, so a specification that states
    // its rules in a field table reports a low count, and a caller can only tell that
    // apart from an absence if the response says how much keyword-bearing text was not
    // read.
    //
    // Read through `ensureLossCounters` rather than off the snapshot row, because the
    // counter is a function of the keyword predicate and not of the snapshot identity: a
    // corpus whose counters were written by a case-sensitive probe keeps reporting the
    // smaller number through every re-derive, and the only documented remedy is a version
    // bump that re-mints every pinned id. `repaired` says the number was recomputed here
    // rather than read, so a caller comparing counters across documents knows the two
    // sides are not two derivations of the same rule.
    const counters = this.store.ensureLossCounters(snapshot.id);
    if (counters === null) {
      throw new RfcMcpError("CORPUS_UNAVAILABLE", `Snapshot row for ${snapshot.id} is missing`, { retryable: false });
    }
    if (counters.repaired) {
      warningsOut.push(
        `loss_counters_recomputed:${counters.keywordBearing}_keyword_bearing_of_${counters.unscanned}_skipped:an_earlier_build_counted_keywords_case_sensitively`,
      );
    }
    const keywordBearingSkipped = counters.keywordBearing;
    if (keywordBearingSkipped > 0) {
      warningsOut.push(
        `normative_text_in_unscanned_blocks:${keywordBearingSkipped}:out_of_scope_by_design:see_coverage_keyword_bearing_blocks_skipped`,
      );
    }
    const mayHoldNormative = skippedBlocksThatMayHoldNormativeText(counters.byKind);
    if (mayHoldNormative > 0) {
      warningsOut.push(
        `unscanned_blocks_may_contain_normative_text:${mayHoldNormative}:blocks_the_extractor_refuses_to_read_on_their_kind_alone:see_coverage_completeness`,
      );
    }
    // A row a page break cut in half is emitted today as `complete` with `confidence: 0.9`
    // and no flag, on 274 rows across 38 documents. The extractor's own diagnosis for it
    // (Y2) specifies `parse_status: "fragment"`, which does not exist yet, so this counts
    // rows that DECLARE themselves fragments: 0 today, and 0 is the true answer to that
    // question rather than a claim that the document has none.
    const fragmentRows = this.store.countFragmentRequirements(snapshot.id, filter);
    if (fragmentRows > 0) {
      warningsOut.push(
        `requirement_rows_are_fragments:${fragmentRows}:parse_status_fragment:the_sentence_continues_in_another_block:do_not_quote_these_as_whole_statements`,
      );
    }

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
        blocks_skipped: counters.unscanned,
        blocks_skipped_by_kind: counters.byKind,
        // Blocks skipped out of a kind that could hold a rule. Distinct from the counter
        // below, and the two answer different questions: this one says how much text the
        // extractor declined on its KIND alone, and the counter says how much of that text
        // holds a keyword. A protocol that states its obligations in a state-machine table
        // has no keyword to count, so only this number sees it - and it is why the verdict
        // below is `partial` on 182 of 182 documents in the corpus.
        may_contain_normative_blocks_skipped: mayHoldNormative,
        // The loss counter. Tables and preformatted text are out of scope by design, so a
        // specification that states its rules in a field table reports a low count; a
        // caller can only tell that apart from an absence if the response says how much
        // keyword-bearing text was not read. Any capitalisation, because the candidate pass
        // reads any capitalisation: counting only the upper case made the counter blind to
        // the pass it exists to account for, and 448 blocks became 1 471.
        keyword_bearing_blocks_skipped: keywordBearingSkipped,
        keyword_bearing_note:
          "An RFC 2119 keyword in ANY capitalisation, because the candidate pass reads any capitalisation. A keyword inside a bibliography entry counts here too - the counter cannot tell a modal in a citation from a modal in a rule - so blocks_skipped_by_kind is what separates the two.",
        unscanned_note:
          "Blocks that are not prose are not scanned. keyword_bearing_blocks_skipped is how many of them carry an RFC 2119 keyword in any capitalisation, and may_contain_normative_blocks_skipped is how many were declined on their kind alone, which is the larger question and the one a keyword-free specification hides behind. Read coverage.completeness before treating a low total_requirements as the document's whole normative content.",
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
    if (total === 0 && usage.length === 0) {
      warningsOut.push(
        "zero_requirements_without_a_keyword_usage_notice:the_document_neither_adopts_nor_disclaims_rfc2119:no_count_can_be_treated_as_its_nominal_content",
      );
    }

    // The verdict, computed last and written into the coverage object built above, because
    // it needs the keyword-usage notice and that is only known once the block selector has
    // run. Written in place for the same reason `provisional_returned` is: one object, one
    // set of numbers, and a caller reading `coverage` never has to know in which order the
    // response was assembled.
    const verdict = this.completeness({
      snapshot,
      counters,
      totalRequirements: total,
      keywordUsageStance: usage[0]?.stance ?? null,
      fragmentRows,
    });
    const coverageOut = data.coverage as Record<string, unknown>;
    coverageOut.completeness = verdict.completeness;
    coverageOut.completeness_basis = verdict.basis;
    // The reasons, as the warning keys they are also emitted under. A caller that sees
    // `partial` and wants the why finds it in one place, and a test can assert that every
    // key here is a key in `warnings` - which is the whole point: the verdict is computed
    // from the same strings the warnings are built from, so the two cannot drift.
    coverageOut.completeness_warnings = verdict.reasons;
    // A reason whose warning is not already on the response is emitted bare, with no
    // count. That is deliberate and not an oversight: the reason is a key, the detail is
    // in completeness_basis next to the numbers it is derived from, and a warning that
    // repeated the basis would be a second place for the same numbers to disagree.
    const warned = new Set(warningsOut.map((warning) => warning.split(":")[0]!));
    for (const reason of verdict.reasons) {
      if (warned.has(reason)) continue;
      warningsOut.push(reason);
      warned.add(reason);
    }
    // Reported in limits.applied as well as in the warning, because a caller reading the
    // envelope's limits and a caller reading warnings are different readers and the clamp
    // has to be visible to both.
    let appliedDeclarativeLimit: number | null = null;
    if (input.include_candidates !== false) {
      const sections = this.store.getSections(snapshot.id);
      // A candidate list that ignored `scope` would answer a different question
      // than the requirement list beside it, and the two are read together.
      const scopeSections = input.scope
        ? sections.filter((section) => section.number === input.scope || section.number.startsWith(`${input.scope}.`))
        : sections;
      const scopeIds = new Set(scopeSections.map((section) => section.id));
      // Every block of the snapshot, not the ones a keyword appears in. The keyword-free
      // pass is the only channel that has to see a block with no keyword in it, which is
      // exactly the block the keyword selector throws away.
      const allBlocks = this.store.listBlocks(snapshot.id);
      const analysis = analyzeNormativeCandidates({
        snapshotId: snapshot.id,
        rfc: record.rfc,
        sections: scopeSections,
        blocks: keywordBlocks.filter((block) => scopeIds.has(block.section_id)),
        ...(input.max_candidates !== undefined ? { limit: input.max_candidates } : {}),
      });

      // The keyword-free channel, on prose blocks on its own terms.
      //
      // It was unreachable through the service: `analyzeNormativeCandidates` runs the pass
      // internally, over whatever blocks IT is handed, and the service hands it the blocks
      // whose text matches `%must%` and ten other stems. A paragraph whose only
      // specification is "the maximum total length of a command line … is 512 octets"
      // matches none of them, so the sentence that RFC 8174 section 2 calls normative
      // without a keyword never reached the analysis. The extractor's own note says the fix
      // is to call `analyzeDeclarativeSpecifications` with the snapshot's blocks, and that
      // call is made here rather than by loosening the block selector, because the selector
      // is the candidate channel's business: a keyword-free sentence belongs to neither.
      //
      // Measured over the 182-document corpus: 348 rows reachable before, 1 286 after, and
      // the three sentences the extractor's documentation names - RFC 5321's 512 octets,
      // RFC 8484's 65535 bytes and RFC 5322's 998 character limit - all of which were
      // unreachable through the service.
      const askedDeclarative = input.declarative_limit;
      const declarativeCeiling = MAX_DECLARATIVE_LIMIT;
      const declarativeLimit = clamp(askedDeclarative ?? declarativeCeiling, 1, declarativeCeiling);
      appliedDeclarativeLimit = declarativeLimit;
      if (askedDeclarative !== undefined && askedDeclarative > declarativeLimit) {
        // The same shape as the max_results clamp: a clamp that is not reported is
        // indistinguishable from a smaller corpus.
        warningsOut.push(
          `declarative_limit_clamped:${askedDeclarative}->${declarativeLimit}:declarative_limit_accepts_up_to_${declarativeCeiling}`,
        );
      }
      const declarative = analyzeDeclarativeSpecifications({
        snapshotId: snapshot.id,
        rfc: record.rfc,
        sections: scopeSections,
        blocks: allBlocks.filter((block) => scopeIds.has(block.section_id)),
        limit: declarativeLimit,
      });
      const sectionById = new Map(sections.map((section) => [section.id, section.number]));
      // Document order is the worst possible order for a lead list: the first page
      // of RFC 1035 opened on "The optional completion services ... have been
      // deleted". Rank by how likely a statement is to state an obligation, so the
      // page a caller reads first is the page worth reading. Ties keep document
      // order, so the ranking is a reordering and never a reordering-with-loss.
      const ranked = [...analysis.candidates].sort(
        (a, b) => this.candidateRank(b) - this.candidateRank(a) || a.char_start - b.char_start,
      );
      const filtered = ranked.filter(
        (candidate) =>
          (input.role === undefined || candidate.role === input.role) &&
          (input.shape === undefined || candidate.shape === input.shape),
      );
      const bySection: Record<string, number> = {};
      for (const candidate of filtered) {
        const key = sectionById.get(candidate.section_id) ?? candidate.section_id;
        bySection[key] = (bySection[key] ?? 0) + 1;
      }
      const byShapeFiltered: Record<string, number> = {};
      const byRoleFiltered: Record<string, number> = {};
      for (const candidate of filtered) {
        byShapeFiltered[candidate.shape] = (byShapeFiltered[candidate.shape] ?? 0) + 1;
        byRoleFiltered[candidate.role] = (byRoleFiltered[candidate.role] ?? 0) + 1;
      }
      // A page break splits a sentence, and the second half is not a statement. It is
      // reported in its own key rather than mixed into the list a caller reads, because
      // "in this memo, and may be datagrams." is not something the RFC said and a
      // compliance list must not contain it as though it had. Nothing is dropped: the
      // text and the block it continues into are both named.
      const whole = filtered.filter((candidate) => !candidate.continues_previous_block);
      const fragments = filtered.filter((candidate) => candidate.continues_previous_block);
      const filterApplied = input.role !== undefined || input.shape !== undefined;
      const withSection = (candidate: (typeof filtered)[number]) => {
        const section = sectionById.get(candidate.section_id) ?? null;
        return {
          ...candidate,
          section,
          // The id that outlives a parser bump. Candidates are derived on demand, so this
          // is minted here rather than read back: a candidate is a lead a reader copies a
          // sentence out of, and a sentence quoted into a contract two years later has to
          // be checkable against a re-derived document, not only against the derivation
          // that happened to be on disk when it was copied.
          stable_citation_id:
            section === null
              ? ""
              : stableCitationId({ rfc: record.rfc, sectionNumber: section, quote: candidate.exact_text }),
        };
      };
      // The counts and the filters are properties of the whole document, so they are on
      // every page. The ROWS are not: they were re-shipped whole on page 2 and every page
      // after, up to 2000 of them, and reading a 995-requirement document cost 29 seconds
      // of which the requirement rows are a rounding error. Page 1 carries them; later
      // pages carry a stub that says where they are, because a caller that pages and finds
      // an empty list has to be able to tell "there are none" from "they were on the page
      // before" and there is no input today that asks for them on a later page.
      const page = Math.floor(offset / limit) + 1;
      const candidateTotals = {
        total: analysis.candidates.length,
        returned: whole.length,
        filters: {
          role: input.role ?? null,
          shape: input.shape ?? null,
          note: filterApplied
            ? "Filters are applied server-side; the counts below describe the filtered set, and `total` still describes the document."
            : "No candidate filter applied. Narrow with role and shape; role=modal AND shape=demand is the set that can state an obligation.",
        },
        by_keyword: analysis.by_keyword,
        by_keyword_case: analysis.by_case,
        by_reason: analysis.by_reason,
        by_role: byRoleFiltered,
        by_shape: byShapeFiltered,
        by_section: bySection,
        scanned_blocks: analysis.scanned_blocks,
        unreadable_blocks: analysis.unreadable_blocks,
        sentence_fragments: fragments.length,
        ordering: "ranked: shape=demand first, then role=modal, then upper-case keywords, then document order",
        // The keyword-free channel's own numbers, in the object the two channels are read
        // together in. Never inside `candidates`: these rows have no keyword, so anything
        // that filters on one cannot see them, and folding them in would let a count that
        // means "upper-case modals" absorb sentences that state a rule in prose.
        declarative_total: declarative.declarative_specifications.length,
        declarative_truncated: declarative.declarative_specifications_truncated,
        declarative_by_basis: declarative.declarative_by_basis,
        declarative_excluded: declarative.declarative_excluded,
        declarative_blocks_scanned: allBlocks.length,
        declarative_note: DECLARATIVE_NOTE,
      };
      const declarativeRows = declarative.declarative_specifications.map((row) => {
        const section = sectionById.get(row.section_id) ?? null;
        return {
          ...row,
          section,
          // The id that outlives a parser bump, minted here for the same reason candidates
          // carry one: this is a sentence a reader copies into a contract, and a contract
          // that cannot be re-verified after a re-derivation is a contract nobody can check.
          stable_citation_id:
            section === null
              ? ""
              : stableCitationId({ rfc: record.rfc, sectionNumber: section, quote: row.exact_text }),
        };
      });
      // The rows follow the candidate rows' paging rule, and the rule is decided per channel:
      // an empty list and an omitted list have to be distinguishable, and `whole.length`
      // says nothing about the declarative channel. Two states, one field, as with
      // `omitted_on_page`: 0 is "these rows are on this page", N is "they were on page 1".
      const shipDeclarative = page === 1 || declarativeRows.length === 0;
      // `whole.length === 0` forces the full object on every page, because there is
      // nothing to omit: a stub saying "the 0 candidate rows are on page 1" contradicts
      // the contract line that says only a stub sets omitted_on_page above 0, and a
      // caller branching on that field would read an omission that did not happen.
      if (page === 1 || whole.length === 0) {
        data.non_strict_candidates = {
          ...candidateTotals,
          candidates: whole.map(withSection),
          declarative_specifications: shipDeclarative ? declarativeRows : [],
          declarative_omitted_on_page: shipDeclarative ? 0 : page,
          // Present only when a page break split a sentence. Each entry is the second
          // half of a statement whose first half is in an earlier block of the same
          // section; read it together with that block or not at all.
          ...(fragments.length > 0
            ? {
                fragments: fragments.map((candidate) => ({
                  ...withSection(candidate),
                  continues_from_block: candidate.block_id,
                  note: "Second half of a sentence split by a page break. The first half is in an earlier block of the same section.",
                })),
              }
            : {}),
          omitted_on_page: 0,
          note: CANDIDATE_NOTE,
        };
      } else {
        data.non_strict_candidates = {
          ...candidateTotals,
          candidates: [],
          declarative_specifications: [],
          declarative_omitted_on_page: page,
          ...(fragments.length > 0
            ? {
                fragments: [],
              }
            : {}),
          omitted_on_page: page,
          note: `The ${whole.length} candidate rows and the ${declarativeRows.length} keyword-free rows are complete on page 1 and are not repeated on later pages, which is where the bytes of a 995-requirement document were being spent twice. Every count above still describes the whole document and is identical to page 1. To get the rows again, repeat this call with max_results=${limit} and no cursor. omitted_on_page and declarative_omitted_on_page are 0 on the page that carries them. Field semantics are as documented on page 1.`,
        };
      }
      // The two channels' warnings, each under its own name.
      //
      // `analyzeNormativeCandidates` returns the candidate warnings and the keyword-free
      // ones in one array, and every keyword-free warning is named `declarative_…` by the
      // extractor. Prefixing the whole array with `candidates:` therefore arrived as
      // `candidates:declarative_list_item_excluded:40`, which is a lie about where the
      // number came from: it was counted by a different pass over a different block set.
      // The extractor names every one of its keyword-free warnings `declarative_…` and none
      // of its candidate warnings that way, so the partition is exact and it is made HERE,
      // in one place, from that prefix.
      //
      // The keyword-free warnings the service keeps are the ones from the pass it ran
      // itself over the whole document, not the ones the internal pass produced over the
      // keyword blocks: two numbers for the same question, describing different block sets,
      // is how a response ends up contradicting itself.
      for (const warning of analysis.warnings) {
        if (warning.startsWith(DECLARATIVE_WARNING_PREFIX)) continue;
        warningsOut.push(`candidates:${warning}`);
      }
      warningsOut.push(...declarative.warnings);
      // In `coverage` and never in `total_requirements`. The extractor's own requirement
      // for this channel is that its size is a number of its own, and a caller who has to
      // add two arrays together to learn that a document states rules without keywords has
      // been handed the arithmetic instead of the answer.
      (data.coverage as Record<string, unknown>).declarative_specifications =
        declarative.declarative_specifications.length;
      if (analysis.candidates.length > 0) {
        warningsOut.push(
          `zero_or_few_requirements_but_${analysis.candidates.length}_non_strict_candidates:read_non_strict_candidates`,
        );
      }
      if (page > 1 && whole.length > 0) {
        warningsOut.push(
          `non_strict_candidate_rows_omitted_on_page_${page}:${whole.length}_rows_are_on_page_1:repeat_with_max_results_and_no_cursor`,
        );
      }
      // A compliance list for a document that predates RFC 2119 needs the candidates
      // in the requirement list itself. They are appended under an explicit flag so a
      // count can never quietly absorb them. They are candidates, so they follow the
      // same paging rule: 2000 rows on every page is the cost this is removing.
      if (input.include_provisional === true) {
        const provisional = whole.map((candidate) => ({
          ...withSection(candidate),
          provisional: true as const,
          parse_status: "provisional" as const,
          confidence: candidate.role === "modal" && candidate.shape === "demand" ? 0.6 : 0.3,
        }));
        const coverage = data.coverage as Record<string, unknown>;
        if (page === 1) {
          data.requirements = [...keywordFiltered, ...provisional];
          coverage.provisional_returned = provisional.length;
          warningsOut.push(
            `provisional_entries_included:${provisional.length}:not_rfc2119_requirements_excluded_from_total`,
          );
        } else {
          data.requirements = keywordFiltered;
          coverage.provisional_returned = 0;
          coverage.provisional_omitted_on_page = page;
          // The warning has to name what happened on THIS page. It used to be pushed
          // unconditionally with the whole-document count, so a caller parsing warnings
          // was told 148 provisional entries were included on a page that carried none -
          // 49 wrong machine-readable warnings on one read of RFC 3261. A warning that
          // contradicts the response it is attached to is worse than no warning.
          warningsOut.push(
            `provisional_entries_omitted_on_page_${page}:${provisional.length}_rows_are_on_page_1:repeat_with_max_results_and_no_cursor`,
          );
        }
        coverage.provisional_note =
          "Provisional entries are requirement-shaped statements the strict extractor rejected. They are NOT RFC 2119 requirements and are excluded from total_requirements. They are candidates, so page 2 and later carry none of them and say so here; repeat the call with max_results and no cursor to get them.";
        warningsOut.push(
          `provisional_entries_included:${provisional.length}:not_rfc2119_requirements_excluded_from_total`,
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
      appliedLimits: {
        max_results: limit,
        // Absent rather than 0 when the channel did not run: "capped at 0" and "not asked
        // for" are different states, and a caller reading limits.applied cannot tell them
        // apart if both arrive as a number.
        ...(appliedDeclarativeLimit === null ? {} : { declarative_limit: appliedDeclarativeLimit }),
      },
    });
  }

  /* ---------------------------------------------------------------------- */
  /**
   * How likely a candidate is to state an obligation. Higher sorts first.
   *
   * `shape` is weighted above `role` because it is the criterion the specification
   * itself states, and above case because RFC 8174's capitalisation rule is a matter
   * of record rather than of judgement.
   */
  private candidateRank(candidate: NormativeCandidate): number {
    const shape = candidate.shape === "demand" ? 8 : candidate.shape === "indeterminate" ? 3 : 0;
    const role = candidate.role === "modal" ? 4 : candidate.role === "unknown" ? 1 : 0;
    const letterCase = candidate.keyword_case === "upper" ? 2 : candidate.keyword_case === "title" ? 1 : 0;
    return shape + role + letterCase;
  }

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
    const coverage = this.diffCoverage({
      mode,
      result,
      left: { snapshot: left.snapshot, record: left.record, side: leftSide },
      right: { snapshot: right.snapshot, record: right.record, side: rightSide },
    });
    const warnings: string[] = [];
    if (mode === "text") warnings.push("text_diff_is_not_a_semantic_diff");
    if (left.snapshot.rfc === right.snapshot.rfc && left.snapshot.id === right.snapshot.id) {
      warnings.push("both_sides_are_the_same_snapshot");
    }
    // Every reason the comparison did not answer the question, as a warning as well as a
    // field. The field is what a test asserts on; the warning is what a reader who never
    // looks at fields sees, and an operation that could not answer must not be `ok`.
    for (const reason of coverage.reason === "both_sides_contributed" ? [] : [coverage.reason]) {
      warnings.push(`diff_unanswered:${reason}:${mode}_mode`);
    }
    return this.envelope(
      { ...result, coverage },
      {
        snapshot: right.snapshot,
        warnings,
        freshness: right.freshness,
        status: coverage.verdict === "unanswered" ? "partial" : undefined,
        appliedLimits: { max_changes: maxChanges },
        truncated: result.truncated,
      },
    );
  }

  /**
   * What the diff actually compared, and whether the empty answer is a finding.
   *
   * The response this replaces: `diff(2178, 2328, mode: "requirements")` returned
   * `changes: []`, `summary: {}`, `truncated: false`, `status: "ok"` and no warnings, and
   * both documents have zero extracted requirements. RFC 2178 is the 1991 OSPF draft and
   * RFC 2328 the 1998 Internet Standard, so the one response in the whole walkthrough that
   * is indistinguishable from a real finding told a routing engineer the standard changed
   * nothing. A diff between two empty extractions is not a clean diff; it is a question
   * nobody ran, and it is reported as one.
   *
   * `text` mode needs its own decision because it produces a different failure. It compares
   * lines up to a ceiling of 2 000 per side, and above that it silently returns the
   * structural diff under a `text` label: measured, `diff(5246, 8446, mode: "text")`
   * returns 107 changes and every one of them is `section_renamed`, `section_added`,
   * `section_removed` or `section_moved`, byte-identical to `mode: "structure"` on the same
   * pair, with the only warning saying the diff is not semantic. Both documents are far
   * over the ceiling - 5 828 and 8 964 lines - so the line diff did not run.
   *
   * That is a real limitation and it is a defect, not a naming problem, and the defect is
   * in `src/analysis/diff.ts`, which this service does not own: the pass writes
   * `documents_too_large_for_line_diff_use_structure_mode` into a local `notes` array that
   * `DiffResult` has no field for, so the explanation is computed and thrown away. What is
   * fixed here is the part this service owns: the fallback is DETECTED from the response it
   * produced - a `text` diff whose changes are not `text_hunk` did not run a line diff - and
   * the response says so in a field and a warning, with the structure changes left in place
   * rather than discarded, because they are real and a caller asking a second question can
   * use them.
   */
  private diffCoverage(input: {
    readonly mode: DiffMode;
    readonly result: DiffResult;
    readonly left: { snapshot: Snapshot; record: CatalogRecord; side: DiffSide };
    readonly right: { snapshot: Snapshot; record: CatalogRecord; side: DiffSide };
  }): DiffCoverage {
    const itemsFor = (side: DiffSide): number => {
      switch (input.mode) {
        case "requirements":
          return side.requirements.length;
        case "structure":
          return side.sections.length;
        case "references":
          return side.references.length;
        case "text":
          return side.lines.length;
        case "metadata":
          // A catalog record is not derived from the text, so there is always something to
          // compare even when every field is identical. Counting zero here would report
          // "this document has no metadata", which is not a state a document can be in.
          return 1;
      }
    };
    const side = (side: { snapshot: Snapshot; record: CatalogRecord; side: DiffSide }): DiffCoverageSide => {
      const items = itemsFor(side.side);
      const counters = this.store.ensureLossCounters(side.snapshot.id);
      const verdict = this.completeness({
        snapshot: side.snapshot,
        counters: counters ?? { unscanned: 0, keywordBearing: 0, byKind: {} },
        totalRequirements: side.side.requirements.length,
        // Not measured here, and said so in the basis rather than reported as `absent`:
        // this call does not run the keyword-usage probe, and a basis that claimed the
        // probe had run and found nothing would be a second false statement on a response
        // whose whole purpose is to stop making them.
        keywordUsageStance: KEYWORD_USAGE_NOT_MEASURED,
        fragmentRows: this.store.countFragmentRequirements(side.snapshot.id, {}),
      });
      return {
        document_id: side.record.document_id,
        snapshot_id: side.snapshot.id,
        items,
        completeness: verdict.completeness,
        basis: verdict.basis,
      };
    };
    const left = side(input.left);
    const right = side(input.right);
    const lineHunks = input.result.changes.filter((change) => change.kind === "text_hunk").length;
    // The ceiling is inside `diff.ts` and is not exported, so the fallback is read off the
    // response rather than recomputed from a constant that could drift from it: in `text`
    // mode a line diff produces `text_hunk` and nothing else, so any other kind of change
    // is proof that the line diff did not run. The second case is the one that is not a
    // proof but a contradiction: no change at all, while the two documents' bytes differ.
    const fellBack = input.mode === "text" && input.result.changes.length > 0 && lineHunks === 0;
    const silentTextMiss =
      input.mode === "text" &&
      input.result.changes.length === 0 &&
      input.left.snapshot.raw_sha256 !== input.right.snapshot.raw_sha256;
    let reason: DiffCoverage["reason"] = "both_sides_contributed";
    if (fellBack) reason = "mode_fell_back_to_structure";
    else if (silentTextMiss) reason = "texts_differ_but_no_line_hunk_was_produced";
    else if (left.items === 0 && right.items === 0) reason = "neither_side_contributed";
    else if (left.items === 0) reason = "left_contributed_nothing";
    else if (right.items === 0) reason = "right_contributed_nothing";
    const unanswered = reason !== "both_sides_contributed";
    const verdict: DiffCoverage["verdict"] = unanswered
      ? "unanswered"
      : input.result.changes.length === 0
        ? "no_differences"
        : "differences";
    // `clean` is the evidence gate, and it is the same gate for every mode that compares
    // something DERIVED from the text: a diff of two documents whose requirement lists are
    // known to be partial is not a clean diff however few changes it found.
    // `metadata` is the one mode that compares a stored record rather than a derivation, so
    // for it the gate is the contribution alone.
    const clean =
      !unanswered &&
      (input.mode === "metadata" || (left.completeness === "complete" && right.completeness === "complete"));
    return {
      mode: input.mode,
      left,
      right,
      items: { left: left.items, right: right.items },
      verdict,
      reason,
      clean,
      note: diffCoverageNote({
        mode: input.mode,
        reason,
        left,
        right,
        lineHunks,
        changes: input.result.changes.length,
      }),
    };
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

  /**
   * Every sentence of a section, with the byte span it occupies.
   *
   * The span is the SENTENCE's, not the block's, because that is what a caller holding a
   * stable id is asking about: the block is a layout artefact of the parse and moves when
   * the parser moves, the sentence does not. Line numbers are the block's, because
   * nothing records where inside a block a sentence starts and reporting the block's range
   * is honest where inventing a line would not be.
   */
  private sectionSentences(snapshotId: string, section: Section): SentenceSpan[] {
    const out: SentenceSpan[] = [];
    for (const block of this.store.getBlocksForSection(snapshotId, section.id)) {
      for (const sentence of splitSentences(block.text)) {
        const charStart = block.char_start + sentence.start;
        out.push({
          text: sentence.text,
          // The same function the parser wrote into blocks.text_sha256, so a stored
          // block hash and a derived sentence hash are one value and can be compared.
          text_sha256: textHash(sentence.text),
          block_id: block.id,
          section_id: block.section_id,
          char_start: charStart,
          char_end: charStart + sentence.text.length,
          byte_start: byteOffsetInBlock(block, charStart),
          byte_end: byteOffsetInBlock(block, charStart + sentence.text.length),
          line_start: block.line_start,
          line_end: block.line_end,
        });
      }
    }
    return out;
  }

  /**
   * Resolve a re-derivation-stable id against the pinned snapshot.
   *
   * A stable id is a hash of (rfc, section number, exact text, occurrence) and a hash
   * cannot be inverted, so resolution is by recomputation: every sentence of the named
   * section is re-hashed under each occurrence index its text could occupy, and the one
   * that reproduces the id names the text. The scan is bounded by the blocks of one
   * section, the same bound `findBlockByDerivedCitation` already works under.
   *
   * Three verdicts, and the third is the one that is easy to get wrong. One place in the
   * section: `verified` if this snapshot minted the id, `stale` if it did not — the text
   * is still in the document, and saying so is the whole point of a stable id, but it is
   * not the derivation the citation was recorded against. More than one place:
   * `ambiguous`, with every span named, because the id carries no block and no offset and
   * a first-match answer would hand a caller one of two places it never chose.
   * `block_id` and `char_start`, both already accepted, are how a caller narrows it.
   */
  /**
   * The offsets of one record inside its block, in all four units.
   *
   * A citation is a promise that a place in the document holds a particular piece of text.
   * Handing back the block's extent instead of the record's keeps the promise only in the
   * weak sense that the text is *somewhere* in there - and when two records share a block,
   * which happens whenever a paragraph states two obligations, the two citations become
   * indistinguishable. The line numbers are counted from the block rather than taken from
   * it, for the same reason: a block's `line_start`/`line_end` bracket the whole paragraph.
   */
  private recordSpan(
    block: Block | null | undefined,
    charStart: number,
    charLength: number,
  ): Citation["locator"]["span"] {
    if (!block) {
      return {
        byte_start: 0,
        byte_end: 0,
        char_start: charStart,
        char_end: charStart,
        codepoint_start: 0,
        codepoint_end: 0,
        line_start: 0,
        line_end: 0,
      };
    }
    const from = Math.max(0, Math.min(block.text.length, charStart - block.char_start));
    const to = Math.max(from, Math.min(block.text.length, from + charLength));
    const before = block.text.slice(0, from);
    const through = block.text.slice(0, to);
    const lineOf = (offset: number): number => {
      let line = block.line_start;
      for (let i = 0; i < offset && i < block.text.length; i += 1) {
        if (block.text[i] === "\n") line += 1;
      }
      return line;
    };
    return {
      byte_start: byteOffsetInBlock(block, charStart),
      byte_end: byteOffsetInBlock(block, charStart + charLength),
      char_start: charStart,
      char_end: charStart + charLength,
      codepoint_start: block.codepoint_start + codePointCount(before),
      codepoint_end: block.codepoint_start + codePointCount(through),
      line_start: lineOf(from),
      line_end: lineOf(to),
    };
  }

  private verifyStableCitation(
    input: VerifyCitationInput,
    snapshot: Snapshot,
    warnings: string[],
  ): Envelope<VerifyCitationResult> {
    const stableId = input.citation_id!;
    const rfc = input.rfc ?? snapshot.rfc;
    const notes: string[] = [
      "stable citation id (scit_): hashed from the RFC number, the section NUMBER and the exact text, so it survives a re-derivation. cit_ is a function of one derivation's snapshot, block id and byte offset and does not. The stable id names a sentence, not a place in the document.",
    ];
    const origins = this.store.stableCitationOrigins(stableId);
    // A sentence is a requirement AND a mention, so the same id is in both tables. The
    // answer names a snapshot, not a row.
    const mintedIn = [...new Set(origins.map((origin) => origin.snapshot_id))];
    if (input.rfc !== undefined && input.rfc !== snapshot.rfc) {
      warnings.push(`rfc_does_not_match_pinned_snapshot:asked_for_rfc${input.rfc}:pinned_is_rfc${snapshot.rfc}`);
      notes.push(`the id was resolved against the pinned snapshot, which is RFC ${snapshot.rfc}, not RFC ${rfc}.`);
    }

    const answer = (verdict: CitationVerdict, matches: Citation[], extra: string[]): Envelope<VerifyCitationResult> =>
      this.envelope(
        {
          verdict,
          matches,
          notes: [...notes, ...extra],
          citation_id: stableId,
          citation_id_kind: "stable" as const,
          minted_in: mintedIn,
        },
        {
          snapshot,
          warnings,
          status: verdict === "verified" ? "ok" : verdict === "not_found" ? "degraded" : "partial",
        },
      );

    const sectionNumber = input.section;
    if (sectionNumber === undefined) {
      return answer(
        "not_found",
        [],
        [
          "a stable id names a section as well as a text, so `section` is required to resolve it: pass the section number the quote came from ('4.3.1', 'Appendix A'). It cannot be recovered from the id, and resolving against a guessed section would answer a different question than the one asked.",
        ],
      );
    }
    const sections = this.store.getSectionsByNumber(snapshot.id, sectionNumber);
    if (sections.length === 0) {
      return answer(
        "not_found",
        [],
        [`section ${sectionNumber} is not in the pinned snapshot of RFC ${snapshot.rfc}, so nothing was searched`],
      );
    }

    // A section number is not unique in a snapshot - RFC 1350 has ten sections numbered
    // "2" - so every section the number names is searched, not just the first. The id
    // names a number and a sentence, and a number that names ten sections does not pick
    // one of them for us. Whichever section produced the match is reported, and a
    // sentence that reproduces in more than one of them is reported as ambiguous below
    // rather than resolved to whichever came first.
    let section: (typeof sections)[number] = sections[0]!;
    let groups = new Map<string, SentenceSpan[]>();
    let matched: SentenceSpan[] | null = null;
    for (const candidate of sections) {
      const candidateGroups = new Map<string, SentenceSpan[]>();
      for (const sentence of this.sectionSentences(snapshot.id, candidate)) {
        const group = candidateGroups.get(sentence.text_sha256);
        if (group) group.push(sentence);
        else candidateGroups.set(sentence.text_sha256, [sentence]);
      }
      const hit = findStableMatch(candidateGroups, rfc, sectionNumber, stableId);
      if (hit) {
        section = candidate;
        groups = candidateGroups;
        matched = hit;
        break;
      }
      if (groups.size === 0) groups = candidateGroups;
    }
    if (!matched) {
      let examined = 0;
      for (const candidate of sections)
        examined += new Set(this.sectionSentences(snapshot.id, candidate).map((s) => s.text_sha256)).size;
      return answer(
        "not_found",
        [],
        [
          `no sentence in RFC ${rfc} section ${sectionNumber} reproduces this id. ${examined} distinct sentences were examined across ${sections.length === 1 ? "that section" : `the ${sections.length} sections that number names`}, each under every occurrence index its text could occupy.`,
        ],
      );
    }

    const named = (list: readonly SentenceSpan[]): string =>
      list.map((span) => `bytes ${span.byte_start}..${span.byte_end} of block ${span.block_id}`).join(" and ");
    let spans = matched;
    if (input.block_id !== undefined) {
      const narrowed = spans.filter((span) => span.block_id === input.block_id);
      if (narrowed.length === 0) {
        return answer(
          "not_found",
          [],
          [`the text is in RFC ${rfc} section ${sectionNumber} at ${named(spans)}, and not in block ${input.block_id}`],
        );
      }
      spans = narrowed;
    }
    if (spans.length > 1 && input.char_start !== undefined) {
      const narrowed = spans.filter((span) => span.char_start === input.char_start);
      if (narrowed.length > 0) spans = narrowed;
    }

    const citation = (span: SentenceSpan): Citation => ({
      citation_id: stableId,
      document_id: `rfc-${snapshot.rfc}`,
      snapshot_id: snapshot.id,
      source_uri: snapshot.source_url,
      locator: {
        section_path: section.path,
        block_id: span.block_id,
        span: {
          byte_start: span.byte_start,
          byte_end: span.byte_end,
          char_start: span.char_start,
          char_end: span.char_end,
          // Nothing records the code-point offset of a sentence inside a block, and
          // deriving one from a possibly repaired decode would be a number nobody checked.
          codepoint_start: 0,
          codepoint_end: 0,
          line_start: span.line_start,
          line_end: span.line_end,
        },
      },
      quote: span.text,
      quote_sha256: quoteHash(span.text),
      observed_at: snapshot.retrieved_at,
    });

    if (spans.length > 1) {
      return answer("ambiguous", spans.map(citation), [
        `the same sentence appears ${spans.length} times in RFC ${rfc} section ${sectionNumber}, at ${named(spans)}. The id names a sentence and a section, not a place in the document, so every place is reported rather than the first one. Narrow it with block_id or char_start; both are accepted by this call.`,
      ]);
    }

    const span = spans[0]!;
    const where = `bytes ${span.byte_start}..${span.byte_end} (block ${span.block_id}, lines ${span.line_start}..${span.line_end})`;
    const here = origins.filter((origin) => origin.snapshot_id === snapshot.id);
    if (here.length > 0) {
      return answer(
        "verified",
        [citation(span)],
        [
          `text matches ${where} in the pinned snapshot and a ${[...new Set(here.map((origin) => origin.kind))].join(" and ")} row in this snapshot carries this id: minted here, and still here.`,
        ],
      );
    }
    if (mintedIn.length > 0) {
      return answer(
        "stale",
        [citation(span)],
        [
          `text matches ${where} in the pinned snapshot, so the quoted sentence is still in the document, but no row in it was minted with this id: it was minted in ${mintedIn.join(", ")}. Same document, different derivation, which is what a parser bump produces. The claim is "still in the document", not "in the derivation you pinned"; re-read under the current id for that.`,
        ],
      );
    }
    return answer(
      "stale",
      [citation(span)],
      [
        `text matches ${where} in the pinned snapshot, but no stored row carries this id, so its provenance is unrecorded and the claim cannot be made stronger than "this text is in the snapshot you pinned". Two causes, and which one applies is not decidable from the id: a candidate row is derived per query and never stored by design, so its id is always unrecorded here; a requirement or mention written before this id existed needs reanalyze --all. Read the row again to get a fresh id either way.`,
      ],
    );
  }

  async verifyCitation(
    input: VerifyCitationInput,
    context: RequestContext = {},
  ): Promise<Envelope<VerifyCitationResult>> {
    void context;
    const warnings: string[] = [];
    const kind: VerifyCitationResult["citation_id_kind"] =
      input.citation_id === undefined ? "unrecognized" : citationIdKind(input.citation_id);
    let snapshot: Snapshot | null = null;
    if (input.snapshot_id) {
      snapshot = this.store.getSnapshot(input.snapshot_id);
      if (!snapshot) {
        return this.envelope(
          {
            verdict: "not_found" as CitationVerdict,
            matches: [],
            notes: [`unknown snapshot ${input.snapshot_id}`],
            citation_id: input.citation_id ?? null,
            citation_id_kind: kind,
            minted_in: [],
          },
          { warnings },
        );
      }
    } else if (input.rfc !== undefined) {
      snapshot = this.store.getLatestSnapshot(input.rfc, "txt");
    }
    if (!snapshot) {
      return this.envelope(
        {
          verdict: "not_found" as CitationVerdict,
          matches: [],
          notes: ["no snapshot to verify against"],
          citation_id: input.citation_id ?? null,
          citation_id_kind: kind,
          minted_in: [],
        },
        { warnings },
      );
    }

    const raw = this.store.getSnapshotRaw(snapshot.id);
    if (!raw) {
      return this.envelope(
        {
          verdict: "integrity_failure" as CitationVerdict,
          matches: [],
          notes: ["snapshot bytes are missing"],
          citation_id: input.citation_id ?? null,
          citation_id_kind: kind,
          minted_in: [],
        },
        { warnings },
      );
    }
    if (sha256Hex(raw) !== snapshot.raw_sha256) {
      return this.envelope(
        {
          verdict: "integrity_failure" as CitationVerdict,
          matches: [],
          notes: ["snapshot content hash mismatch"],
          citation_id: input.citation_id ?? null,
          citation_id_kind: kind,
          minted_in: [],
        },
        { warnings },
      );
    }

    // The two identifier kinds answer two different questions and are not interchangeable.
    // A stable id is resolved against the section it names rather than against a stored
    // record, because no stored record can be looked up by an id that is required to
    // outlive every one of them. The integrity checks above still run first: a stable id
    // that resolves against bytes which do not hash to the snapshot is an integrity
    // failure, not a verified quote.
    if (kind === "stable") return this.verifyStableCitation(input, snapshot, warnings);

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
          // The RECORD's own offsets, not the block's. Measured: with the block's span
          // here, 15 of 27 `ambiguous` answers named the same place twice - two records in
          // one block produced two citations with identical locators, so the response said
          // "this sentence appears twice" while handing over one address twice. An
          // `ambiguous` verdict whose spans cannot be told apart does not let the caller
          // disambiguate, which is the only reason to report it.
          span: this.recordSpan(block, match.char_start, match.exact_text.length),
        },
        quote: match.exact_text,
        quote_sha256: quoteHash(match.exact_text),
        observed_at: snapshot!.retrieved_at,
      };
    });

    return this.envelope(
      {
        verdict,
        matches: citations,
        notes,
        // Named on every answer, because a verdict is not comparable across the two
        // identifier kinds: `verified` on a cit_ means "this derivation", and on an scit_
        // it means "this text, in a snapshot that minted it". A caller that cannot tell
        // which one it asked about cannot act on the verdict.
        citation_id: input.citation_id ?? null,
        citation_id_kind: kind,
        minted_in: [],
      },
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
          reported:
            "corpus.scopes lists every scope a call consulted with the documents it covers and the total it found there; corpus.coverage is the same thing as one string. A zero-hit result also carries `miss`, whose consultable field says whether the search could have answered the question at all.",
        },
        unsupported: ["raw SQL", "shell", "unbounded regex", "embedding search"],
      },
      reading_rules: [
        "A requirement count of 0 means no UPPER-CASE RFC 2119 keyword was found, not that a document states no requirements. Read requirements.non_strict_candidates before drawing that conclusion.",
        "non_strict_candidates is a lead list, not a contract. Filter on role=modal; role=unknown means the shape was not decidable without a parser and must be read, not assumed.",
        "A search result of 0 in text scope means the term is absent from the ingested documents, not from the RFC corpus. corpus.scopes names every scope the call consulted and corpus.coverage summarises them; on the auto path the catalog over all 9842 entries is searched first and the text index second, and a caller reading only one of those concludes the search was narrower than it was.",
        "A zero-result search carries `miss`, and miss.consultable is the field to branch on. It is true when every document the query could have been answered from was actually searched: either the catalog was searched and found nothing, or the query named its documents with rfc: and all of them are ingested. False means the document holding the term may simply not be loaded, and miss.remedy says what to load. 'No such thing' and 'not in what you have' used to be the same response.",
        "An empty errata list is reported with the statuses that do have errata, so 'none of that status' and 'none at all' stay distinguishable.",
        "A read that lists blocks without source_map returns rows whose text is empty. Omit include entirely, or add source_map, to get the text.",
        "read.text is the section's content with page furniture removed; text_verbatim is the byte-exact slice its span denotes, and page_furniture_lines lists the emptied line numbers. Copy from text, anchor to text_verbatim.",
        "A snapshot id pins one derivation under one parser and extractor version. After a version bump the id is retired; the error names the document and its current id rather than reporting an unknown snapshot.",
        "There are two citation ids and they answer different questions. citation_id (cit_) pins one derivation and is only verified against it. stable_citation_id (scit_) is hashed from the RFC number, the section NUMBER and the exact text, so it survives a re-derivation: 94 of 100 pinned snapshots in a 100-protocol corpus had to be re-pinned after a routine parser bump, and a citation recorded against them could not be re-verified afterwards. verify_citation accepts both, names which it was given in citation_id_kind, and reports a stable id that resolves outside the snapshot that minted it as stale rather than verified: 'this text is still in the document' and 'this text is in the document you pinned' are different claims. A stable id is a hash and cannot be inverted, so it needs rfc and section to resolve; a sentence that appears twice in one section is ambiguous and both byte spans are returned.",
        "non_strict_candidates ships its rows on page 1 only. Page 2 and later carry the same counts with an empty candidates array, omitted_on_page set to the page number, and a note saying where the rows are. Re-request with max_results and no cursor to get them again. An empty candidate list and a stub are distinguishable: only a stub sets omitted_on_page above 0. The keyword-free rows follow the same rule under declarative_omitted_on_page.",
        "A low total_requirements has a knowable cause and the response says which. coverage.keyword_bearing_blocks_skipped counts blocks that were not read and carry an RFC 2119 keyword in ANY capitalisation, and a requirements response for such a document raises the warning normative_text_in_unscanned_blocks:N. Tables, figures and preformatted text are out of scope by design, so a table-driven specification reports a low count as a known gap rather than as an absence.",
        "requirements.coverage.completeness is the verdict a caller branches on, and it is the answer to 'may I treat total_requirements as this document's normative content?'. complete: every prose block was scanned, nothing was skipped out of a kind that could hold a rule, no emitted row is a fragment, and a zero carries a keyword-usage notice saying why. partial: a known loss exists. unknown: the counters that would answer it were never recorded, or were recorded by two different rules and do not reconcile - so the question was not asked of anything. completeness_basis is a space-separated list of key:value pairs, every value a number or a name, in a fixed order, and completeness_warnings holds the warning keys that produced the verdict; each of them also appears in warnings, so the verdict and the warnings cannot disagree. Measured over a 182-document corpus, NO document reaches complete, and that is the finding rather than a near miss: every RFC contains at least one table or preformatted block, and a block refused on its kind alone cannot be ruled out as holding a rule.",
        "non_strict_candidates.declarative_specifications is the keyword-free channel: prose that states a specification with no RFC 2119 keyword anywhere in the sentence, which RFC 8174 section 2 says is still normative. It is scanned over every block of the document, not only the blocks a keyword appears in, which is what makes a paragraph whose only specification is a bound reachable. These are NOT requirements and never enter total_requirements; coverage.declarative_specifications is their count as a number of its own. basis names which test the sentence passed and is not a strength. declarative_excluded counts what each published exclusion dropped, because a filter nobody can see is not a filter. Cap them with declarative_limit; a clamp is reported the way max_results' is.",
        'A diff reports what it compared in diff.coverage, and an empty change list is not a finding until you read it. coverage.verdict is `unanswered` when a side contributed nothing to compare on that mode or when the mode did not run the comparison it names - diff(2178, 2328, mode:"requirements") is the case that motivated it, and both OSPF documents have zero extracted requirements, so an empty successful response there told a routing engineer the 1998 standard changed nothing against the 1991 draft. An `unanswered` diff is never status ok. coverage.clean is true only when both sides are complete and both contributed, so an empty result from two lossy sides is marked as not clean rather than as agreement. mode:"text" compares LINES and not semantics, and above a per-side line ceiling the underlying pass returns the structural diff instead: the response then says so in coverage.reason = mode_fell_back_to_structure, leaves the structure changes in place, and changes of kind section_* under a text mode are never text differences.',
      ],
      parse_notes: [
        // The single most surprising property of this parser, and the reason a reach
        // reported for one RFC means nothing until you know the decade it was typeset
        // in. Per-snapshot counts are in the snapshot's warnings; the contract has to
        // say what the counts mean before the caller has one in hand.
        "Section discovery recognises numbered subsection titles that are set by indentation and titles set with an underline, because RFCs published before about 2010 were typeset rather than generated. How many titles each rule recovered is reported per snapshot in warnings as indented_subsection_headings_recognised:N and underlined_headings_recognised:N, and a document whose warnings carry neither is expected to be in the modern generated format.",
        "A block of a document's masthead is read as prose and its centred title as a heading, because both used to be read as notation: a masthead's two columns are three spaces apart, and looksLikeNotation reads a run of spaces at any indent as a table. The discriminator is that a masthead's second column is right-aligned on a repeated edge while a data table's is ragged. This matters beyond tidiness - while every RFC had at least one skipped block of a kind that could hold a rule, coverage.completeness could never be `complete` for any document, so the verdict was vacuous.",
        "An indented subsection title is not counted as unread text, and a table of contents entry is not a section: a heading line is excluded from the blocks that may contain normative text, and a number lifted from the middle of a sentence does not open a section. RFC 876 filed 93% of itself under such numbers before this, and a document whose text shows a heading its outline omits is reported by the bench as a dangling heading rather than silently unreachable.",
      ],
      ingest_notes: [
        // A 200 carrying the wrong body is the one upstream failure that used to become a
        // document. It needs no adversary: a 503 error page was stored as an RFC, analysed
        // as one, and its requirements verified, quoting `<p>The server MUST be restarted.`
        // Every other guarantee here is downstream of a citation resolving to the right
        // bytes, so the check is at the boundary where the bytes enter rather than in the
        // parser, and it is documented here because a caller deciding whether to retry
        // needs to know the failure is a contract violation and not a network hiccup.
        "A body that is not the rendition that was requested is refused and nothing is stored, with the retryable error code UPSTREAM_CONTRACT. The bytes are the gate and the content-type is corroboration: a missing content-type is tolerated, because a proxy may strip one, but a body that sniffs as markup or as binary is refused. Measured before this check: an HTML 503 page became a document with status ok, two requirements at parse_status complete, and verify_citation returning verified.",
      ],
      limits: this.config.limits,
      limits_notes: {
        maxQuoteChars:
          "Advertised for compatibility and NOT enforced. No quote is ever truncated: a quote that no longer matches its bytes could not be verified, and the corpus contains requirement sentences of 2697 characters. Use read(max_output_bytes) with its byte_cursor to page through a long section instead.",
        maxContextChars: "Enforced on search snippets, and overridable per call with context_chars (40..2000).",
        maxOutputBytes:
          "Enforced on read. A small budget narrows the answer and reports truncated; it never fails the call.",
        // The loss counters, in the same block as the limits, because they are what a
        // caller reads to decide whether a limit was hit or a document said nothing. A
        // low total_requirements is uninterpretable without them: tables, figures and
        // preformatted text are out of scope by design, so a specification that states
        // its rules in a field table reports a low count, and until the response said how
        // much keyword-bearing text went unread nothing distinguished that from an
        // absence. Corpus-wide, 278 non-prose blocks carry an RFC 2119 keyword and none
        // of them is scanned; RFC 1122: 312 blocks skipped, 19 of them keyword-bearing.
        keywordBearingBlocksSkipped:
          "Not a limit: a reported number. Every requirements response carries coverage.keyword_bearing_blocks_skipped, which is how many blocks the normative extractor did not read carry an RFC 2119 keyword in ANY capitalisation - the same predicate the candidate pass selects its blocks with, because the two used to disagree on case and the counter was blind to everything the candidate pass drops. It is written to the snapshot row at derivation time and never counted per query, because counting it cost 29 500 ms on RFC 3261; a corpus whose counters were written by the older case-sensitive predicate has them recomputed once, on read, and says so in the warning loss_counters_recomputed. Read it before concluding that a low coverage.total_requirements means the document states little, and read coverage.completeness for the verdict rather than deriving one from this number: a specification that states its rules in a state-machine table carries no keyword for this counter to find.",
        normativeTextInUnscannedBlocks:
          "Not a limit: a warning template. A requirements response for a document with keyword_bearing_blocks_skipped > 0 carries the warning normative_text_in_unscanned_blocks:N, where N is that count, meaning N blocks hold an RFC 2119 keyword and were not read. out_of_scope_by_design is part of the warning text: tables, figures, preformatted text and the references section are excluded by design, not by a parser failure. Read those blocks with read(section=…, include=[blocks, source_map]) or a text search over the section before concluding a document states no requirement.",
      },
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

/**
 * Find the sentence group a stable citation id names, by recomputation.
 *
 * A hash cannot be inverted, so the id's inputs are re-derived from the section's own
 * sentences: every distinct text is hashed under every occurrence index it could occupy
 * in that section. The occurrence index is carried in the id, and every row in the corpus
 * mints with index 0, so a sentence that stands twice in one section has ONE id with two
 * referents - the whole group is returned and the caller is told it is ambiguous, rather
 * than this function choosing the first.
 */
function findStableMatch(
  groups: Map<string, SentenceSpan[]>,
  rfc: number,
  sectionNumber: string,
  stableId: string,
): SentenceSpan[] | null {
  for (const group of groups.values()) {
    const quote = group[0]!.text;
    for (let occurrence = 0; occurrence < group.length; occurrence += 1) {
      if (stableCitationId({ rfc, sectionNumber, quote, occurrence }) === stableId) return group;
    }
  }
  return null;
}

function decodedText(raw: Buffer, charStart: number, charEnd: number): string {
  return DECODER.decode(raw).slice(charStart, charEnd);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Byte offset of an absolute character offset inside a block.
 *
 * Block text is a verbatim slice of the publication bytes, so the offset of anything in
 * it is the block's byte start plus the byte length of the text before it. The extractor
 * computes the same thing for its own spans; this is the reader's half of it, and it has
 * to agree with `blocks.byte_start` or a stable id would resolve to a span that is off by
 * however many multi-byte characters precede it.
 */
function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function byteOffsetInBlock(block: Block, absoluteChar: number): number {
  const relative = Math.max(0, Math.min(block.text.length, absoluteChar - block.char_start));
  return block.byte_start + Buffer.byteLength(block.text.slice(0, relative), "utf8");
}

function codeOf(error: unknown): string {
  return error instanceof RfcMcpError ? error.code : "INTERNAL";
}

function stable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type { UpstreamMetadata };
