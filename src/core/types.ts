/**
 * Domain model. The shape of this file is the public contract of the server:
 * every tool, resource and prompt returns these structures verbatim.
 */

import type { XmlDocumentOutline } from "../parse/rfcXml.js";
import type { DiffRun } from "../analysis/diff.js";

export const CONTRACT_VERSION = "ietf-rfc/1" as const;

/**
 * Re-exported so the domain model stays self-contained: a consumer of `ReadResult`
 * needs the RFCXML outline shape without reaching into the parser.
 */
export type { XmlDocumentOutline, XmlOutlineSection } from "../parse/rfcXml.js";

export type OperationStatus = "ok" | "partial" | "degraded";

export type Freshness = "current" | "cached" | "stale" | "offline";

export type ParseQuality = "complete" | "degraded";

export interface Provenance {
  readonly corpus_id: string;
  readonly index_generation: number;
  readonly parser_version: string;
  readonly extractor_version: string;
  readonly observed_at: string;
  readonly source_urls: readonly string[];
  readonly freshness: Freshness;
}

export interface Envelope<T> {
  readonly contract: typeof CONTRACT_VERSION;
  readonly status: OperationStatus;
  readonly data: T;
  readonly provenance: Provenance;
  readonly warnings: readonly string[];
  readonly next_cursor: string | null;
  readonly limits: {
    readonly applied: Readonly<Record<string, number>>;
    readonly truncated: boolean;
  };
}

export interface ErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
  };
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

export interface NamedRef {
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly acronym?: string;
  readonly type?: string;
}

export interface DocumentRef {
  readonly number: number;
  readonly title: string;
  readonly doc_id?: string;
}

export interface Author {
  readonly name: string;
  readonly is_editor?: boolean;
  /** Affiliation is public; email addresses are intentionally never exposed. */
  readonly affiliation?: string;
}

export interface SubseriesRef {
  readonly type: "std" | "bcp" | "fyi" | string;
  readonly number: number;
  readonly label: string;
}

export interface CatalogRecord {
  readonly document_id: string;
  readonly rfc: number;
  readonly title: string;
  readonly abstract: string | null;
  readonly published: string | null;
  readonly pages: number | null;
  readonly status: NamedRef | null;
  readonly stream: NamedRef | null;
  readonly area: NamedRef | null;
  readonly group: NamedRef | null;
  readonly keywords: readonly string[];
  readonly authors: readonly Author[];
  readonly obsoletes: readonly number[];
  readonly obsoleted_by: readonly number[];
  readonly updates: readonly number[];
  readonly updated_by: readonly number[];
  readonly subseries: readonly SubseriesRef[];
  readonly identifiers: readonly { readonly type: string; readonly value: string }[];
  readonly formats: readonly string[];
  readonly doi: string | null;
  readonly canonical_url: string;
  readonly source_url: string;
  readonly observed_at: string;
  readonly content_hash: string;
}

/* -------------------------------------------------------------------------- */
/* Snapshots, sections, blocks                                                 */
/* -------------------------------------------------------------------------- */

export type SectionKind =
  "front_matter" | "body" | "appendix" | "references" | "authors" | "index" | "status" | "unknown";

export type BlockKind =
  "paragraph" | "list_item" | "preformatted" | "table" | "figure" | "reference_entry" | "heading" | "unknown";

/**
 * Locator offsets are reported in three units so a quote can be reproduced
 * from the raw bytes, from JavaScript characters, or from Unicode code points.
 */
export interface Span {
  readonly byte_start: number;
  readonly byte_end: number;
  readonly char_start: number;
  readonly char_end: number;
  readonly codepoint_start: number;
  readonly codepoint_end: number;
  readonly line_start: number;
  readonly line_end: number;
}

export interface Section extends Span {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly number: string;
  readonly title: string;
  readonly kind: SectionKind;
  readonly parent_id: string | null;
  readonly ordinal: number;
  readonly path: readonly string[];
  readonly text: string;
  readonly text_sha256: string;
  /**
   * Absolute line numbers inside `text` that hold page furniture rather than
   * content. `text` is a verbatim slice, so those lines are still present in it;
   * this list is what lets a caller render the section without them.
   */
  readonly furniture_lines: readonly number[];
}

export interface Block extends Span {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly section_id: string;
  readonly ordinal: number;
  readonly kind: BlockKind;
  readonly text: string;
  readonly text_sha256: string;
}

export interface Snapshot {
  readonly id: string;
  readonly rfc: number;
  readonly format: "txt" | "xml";
  readonly raw_sha256: string;
  readonly bytes: number;
  readonly retrieved_at: string;
  readonly source_url: string;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly parser_version: string;
  readonly extractor_version: string;
  readonly quality: ParseQuality;
  readonly warnings: readonly string[];
  readonly metadata_hash: string;
  readonly section_count: number;
  readonly block_count: number;
  readonly requirement_count: number;
  readonly reference_count: number;
  /** Blocks the normative extractor reads; the denominator behind a requirement count. */
  readonly prose_block_count: number;
  /**
   * Blocks the normative extractor does NOT read, and how many of them carry an RFC 2119
   * keyword.
   *
   * Stored on the snapshot rather than counted per query. Counting it in SQL cost 5.7
   * seconds on RFC 3261 - there is no index on `blocks.snapshot_id`, so the query scanned
   * all 53 530 blocks in the corpus on every `requirements` call - which is a far worse
   * problem than the silent loss it was meant to remove. The loss is a property of the
   * derivation, not of the question, so it belongs where the derivation is written.
   */
  readonly unscanned_block_count: number;
  readonly keyword_bearing_unscanned_block_count: number;
  /** The same loss broken down by block kind, e.g. `{ table: 140, preformatted: 136 }`. */
  readonly unscanned_block_kinds: Readonly<Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/* Normative language (RFC 2119 / RFC 8174)                                    */
/* -------------------------------------------------------------------------- */

export type NormativeStrength = "absolute" | "recommendation" | "optional";
export type NormativePolarity = "positive" | "negative";

/**
 * How an RFC 2119 keyword functions in the clause it governs.
 *
 * This is the action-verb test, and it is a CONVENTION, not a rule of the
 * specification. A text search of RFC 2119 and of RFC 8174 for "action verb" returns
 * nothing in either: RFC 2119 section 3 is the list of keyword definitions and RFC 8174
 * section 3 is IANA Considerations. An earlier version of this file cited "RFC 2119
 * section 3, rules 1, 2 and 4" and quoted them; the quotation was invented and the
 * citation was wrong. What RFC 2119 does say is in section 6, on guidance in the use of
 * the imperatives, and it addresses the author rather than the parser.
 *
 * The test itself is sound as a heuristic - a clause with no action verb cannot state an
 * obligation, so the presence of one is the spec's own intent even though the spec does
 * not say so. It is applied as a one-sided filter: a row that fails it is `description`,
 * and a row that cannot be decided is `indeterminate`. `demand` is the only shape that
 * can state an obligation, and reading that as "the tool says this is an obligation" is
 * reading more than the classifier knows.
 */
export type RequirementShape = "demand" | "description" | "list_introducer" | "indeterminate";

export const NORMATIVE_TERMS = Object.freeze({
  "MUST NOT": { strength: "absolute", polarity: "negative" },
  "SHALL NOT": { strength: "absolute", polarity: "negative" },
  "SHOULD NOT": { strength: "recommendation", polarity: "negative" },
  "NOT RECOMMENDED": { strength: "recommendation", polarity: "negative" },
  // RFC 2119 §3.8 defines MAY NOT as the negative of MAY, and it is as normative a
  // construct as MUST NOT. It was missing from this vocabulary, which meant a sentence
  // carrying an upper-case `MAY NOT` matched the positive `MAY` and was reported as an
  // opportunity where the RFC states a prohibition. One vocabulary: every negative form
  // of a keyword is here, so a caller filtering `polarity: "negative"` finds all of them.
  "MAY NOT": { strength: "optional", polarity: "negative" },
  MUST: { strength: "absolute", polarity: "positive" },
  SHALL: { strength: "absolute", polarity: "positive" },
  REQUIRED: { strength: "absolute", polarity: "positive" },
  SHOULD: { strength: "recommendation", polarity: "positive" },
  RECOMMENDED: { strength: "recommendation", polarity: "positive" },
  MAY: { strength: "optional", polarity: "positive" },
  OPTIONAL: { strength: "optional", polarity: "positive" },
} as const satisfies Record<string, { strength: NormativeStrength; polarity: NormativePolarity }>);

export type NormativeTerm = keyof typeof NORMATIVE_TERMS;

export type MentionDisposition = "requirement" | "definition" | "context" | "ignored";

export interface NormativeMention {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly section_id: string;
  readonly block_id: string;
  readonly term: NormativeTerm;
  readonly strength: NormativeStrength;
  readonly polarity: NormativePolarity;
  readonly exact_text: string;
  readonly span: Pick<
    Span,
    | "byte_start"
    | "byte_end"
    | "char_start"
    | "char_end"
    | "codepoint_start"
    | "codepoint_end"
    | "line_start"
    | "line_end"
  >;
  readonly context: string;
  readonly disposition: MentionDisposition;
  readonly flags: readonly string[];
  readonly citation_id: string;
  /**
   * The re-derivation-stable companion to `citation_id`, absent on the in-memory object
   * the extractor builds and always present on anything read back from the store.
   *
   * `citation_id` is a function of (snapshot, block, byte offset) — all three of which a
   * parser bump replaces, so all three of which a citation recorded in a contract cannot
   * outlive. This hashes what a re-parse does not change: the RFC number, the section
   * NUMBER and the exact quoted text. A parser bump invalidated 94 of 100 pinned
   * snapshots in a 100-protocol corpus, and every citation written against them came
   * back `not_found` with nothing in the response to say what the text had been.
   *
   * The store computes it on write, not the extractor, because the section number is not
   * on the row: it is on the section the block belongs to, and only the store sees both.
   *
   * Optional in the type only because the extractor's own object literal cannot be
   * required to carry a field it does not know how to compute. Every value that leaves a
   * tool carries it.
   */
  readonly stable_citation_id?: string;
}

export interface RequirementClause {
  readonly actor: string | null;
  readonly condition: string | null;
  readonly action: string | null;
  readonly exception: string | null;
}

export interface Requirement extends NormativeMention {
  /**
   * Every RFC 2119 keyword in the statement, each with its own classification.
   *
   * A requirement is a *statement*, not a keyword occurrence, and the strict extractor
   * used to disagree with the candidate extractor about that. The candidate list was
   * fixed to one row per statement in an earlier round; the strict list was not, so
   * "EMTU_R MUST be greater than or equal to 576, SHOULD be either configurable or
   * indefinite, and SHOULD be greater than or equal to the MTU of the connection" came
   * back three times, and `coverage.total_requirements` counted one sentence as three
   * requirements. Across the corpus 1 411 of 11 640 strict rows - 12.1%, in 96 of 119
   * documents - repeated a sentence already present in the same list.
   *
   * `term`, `polarity` and `strength` describe the FIRST keyword, which is what a
   * caller filtering on `term` has always meant. `keywords` carries the rest, so
   * collapsing loses nothing and "does this statement contain a SHOULD" is still
   * answerable.
   */
  readonly keywords: readonly {
    readonly term: NormativeTerm;
    readonly strength: NormativeStrength;
    readonly polarity: NormativePolarity;
    readonly char_start: number;
    readonly char_end: number;
  }[];
  readonly clause: RequirementClause;
  readonly parse_status: "complete" | "partial" | "heuristic";
  readonly confidence: number;
  // `stable_citation_id` is inherited from NormativeMention above rather than repeated
  // here, and it matters most on this row: a requirement is what a compliance list is
  // built from and what a contract quotes, so it is the row whose identifier most needs
  // to still resolve after the next parser bump.
}

/**
 * A requirement-shaped statement the strict extractor deliberately did not promote:
 * a keyword in lower or title case, or a normative sentence inside a table, figure
 * or field definition.
 *
 * RFC 8174 §3 gives "MUST" no effect unless it is capitalised, so these are not
 * requirements. They are reported because their absence is not evidence either: a
 * caller asking "what must a server do" needs to see that RFC 1035 says "Must be
 * zero" in a header-field table even though the count of requirements is 0.
 */
export interface NormativeCandidate {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly section_id: string;
  readonly block_id: string;
  /**
   * Every RFC 2119 keyword in the sentence, each with its own classification.
   *
   * A candidate is a *statement*, not a keyword occurrence. Emitting one row per
   * occurrence listed the same sentence several times and, because the action-verb
   * test reads the clause that follows the keyword, could file one sentence under two
   * different shapes at once — a caller filtering on `shape` then had to decide which
   * of two rows described the real statement. The keywords stay in the record, so
   * collapsing loses nothing.
   */
  readonly keywords: readonly {
    readonly keyword: string;
    readonly keyword_case: "upper" | "title" | "lower";
    readonly role: "modal" | "non_modal" | "unknown";
    readonly shape: RequirementShape;
    readonly char_start: number;
    readonly length: number;
  }[];
  /**
   * True when the sentence begins in an earlier block, because a page break split it.
   *
   * A block is a contiguous byte range, so a sentence running across a page break
   * becomes two blocks and the second opens mid-clause — "in this memo, and may be
   * datagrams." The text is not wrong; it is simply not a whole statement, and a
   * caller must not be handed it as one.
   */
  readonly continues_previous_block: boolean;
  /** The keyword exactly as written, e.g. "Must", "must", "shall". */
  readonly keyword: string;
  /**
   * The capitalisation the strict extractor requires and this candidate lacks.
   * RFC 8174 section 3 gives an uncapitalised keyword no normative force.
   */
  readonly keyword_case: "upper" | "title" | "lower";
  /**
   * Whether the keyword is in modal position. `unknown` means the shape is not one
   * the classifier claims to know, and is the honest default: a caller must be able
   * to see how much of the list was decided and discount the rest.
   */
  readonly role: "modal" | "non_modal" | "unknown";
  /**
   * How the keyword functions in its clause, under the action-verb test - a convention
   * rather than a rule of the specification; see the note below.
   * section 3 (restated by RFC 8174 section 3). `demand` is the only shape that can
   * state an obligation; `description` fails the specification's own test.
   */
  readonly shape: RequirementShape;
  /**
   * Why the strict extractor left it out, when capitalisation was not the reason:
   * the block is not prose, or the section defines the requirement language. A
   * candidate can be both uncapitalised and non-prose; `reason` names the
   * structural one, because that is what a reader has to act on.
   */
  readonly reason: "non_prose_block" | "definition_section" | null;
  readonly exact_text: string;
  readonly context: string;
  readonly span: Pick<Span, "byte_start" | "byte_end" | "char_start" | "char_end" | "line_start" | "line_end">;
  /** Absolute character offset of the keyword, for stable ordering. */
  readonly char_start: number;
  readonly citation_id: string;
  /**
   * The re-derivation-stable companion to `citation_id`, filled in on the way out and
   * never `""` for a candidate the server produced.
   *
   * Candidates are the rows a reader copies a sentence out of, and a lead list is exactly
   * the kind of artefact that ends up quoted in a contract two years later. The
   * snapshot-scoped id is useless to that reader after a parser bump; this one is not.
   * Candidates are derived on demand rather than stored, which is why the field is
   * optional in the type: the extractor's object literal does not compute it.
   */
  readonly stable_citation_id?: string;
}

/**
 * Which mechanical test a keyword-free specification passed.
 *
 * The list is published so a caller can see how much of the list each test decided,
 * and so a row can be read for what it is. It is not a claim of obligation: `basis`
 * says the sentence stated a quantity or a value, nothing more.
 */
export type DeclarativeBasis = "numeric-bound" | "copula-definition" | "field-default";

/**
 * A specification stated without an RFC 2119 keyword anywhere in the sentence.
 *
 * RFC 8174 section 2, restating RFC 2119, says of these words: "normative text does
 * not require the use of these key words. They are used for clarity and consistency
 * when that's what's wanted, but a lot of normative text does not use them and is
 * still normative." So a specification that binds an implementor without a modal is
 * ordinary, and a keyword-only extractor cannot see it: on a 100-protocol golden set
 * 13 such statements were found by hand and none of them was reachable by any
 * analysis this server runs.
 *
 * There is deliberately no `keyword`, no `keyword_case` and no polarity here. A row
 * that pretended to have one would be counted by anything that filters on a keyword,
 * and the whole point of this list is that it is NOT a requirements list.
 */
export interface DeclarativeSpecification {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly section_id: string;
  readonly block_id: string;
  /** The sentence, verbatim, exactly as a citation over it would verify. */
  readonly exact_text: string;
  /** Which test this sentence passed. Read it; it is not a strength. */
  readonly basis: DeclarativeBasis;
  /**
   * The whole sentence, not a keyword inside it.
   *
   * A candidate row's span covers its keyword because that is the thing it is about.
   * There is no keyword here, and a span four letters wide would verify nothing about
   * what a caller would quote.
   */
  readonly span: Pick<Span, "byte_start" | "byte_end" | "char_start" | "char_end" | "line_start" | "line_end">;
  /** Absolute character offset of the sentence, for stable ordering. */
  readonly char_start: number;
  readonly citation_id: string;
}

export interface NormativeCandidateAnalysis {
  readonly candidates: readonly NormativeCandidate[];
  readonly by_keyword: Readonly<Record<string, number>>;
  readonly by_case: Readonly<Record<string, number>>;
  readonly by_reason: Readonly<Record<string, number>>;
  readonly by_role: Readonly<Record<string, number>>;
  readonly by_shape: Readonly<Record<string, number>>;
  /**
   * Prose that states a specification with no RFC 2119 keyword in it at all.
   *
   * Reported beside the candidate list and never inside it: these rows are binding on
   * an implementor in substance, and RFC 8174 section 3 gives them no keyword to be
   * counted by, so nothing here may reach `coverage.total_requirements` or
   * `requirements`, with or without `include_provisional`. The selection rule and its
   * cap are documented where it is implemented.
   */
  readonly declarative_specifications: readonly DeclarativeSpecification[];
  /** True when `declarative_specifications` stopped at its cap. */
  readonly declarative_specifications_truncated: boolean;
  /** How many rows each published test decided, so the list can be discounted. */
  readonly declarative_by_basis: Readonly<Record<string, number>>;
  /** Blocks that could not be read as text at all; a coverage hole, not an absence. */
  readonly unreadable_blocks: number;
  readonly scanned_blocks: number;
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* References and dependency graph                                            */
/* -------------------------------------------------------------------------- */

export type ReferenceRelation = "normative" | "informative" | "in_body" | "metadata";
/**
 * `external` means the entry cites something that is not an IETF document and whose
 * identity was recovered from the entry text (a standard designation, a publisher, a
 * URL). It is deliberately distinct from `unresolved`, which means the target could
 * not be identified at all — conflating the two would report a cited NIST standard as
 * a parsing failure.
 */
export type ReferenceResolution = "exact" | "ambiguous" | "external" | "unresolved" | "not_attempted";

/** Identity of a cited non-IETF document, recovered from the reference entry text. */
export interface ExternalReferenceIdentity {
  /** What the designation denotes, not what format it was written in. */
  readonly kind: "standard" | "url" | "publication";
  /** The designation as it should be cited, e.g. `FIPS 197`, `ISO/IEC 10646:2003`. */
  readonly id: string;
  readonly publisher: string | null;
  readonly year: number | null;
}

export interface ReferenceRecord {
  readonly id: string;
  readonly snapshot_id: string;
  readonly rfc: number;
  readonly section_id: string | null;
  readonly ordinal: number;
  readonly label: string;
  readonly raw_text: string;
  readonly relation: ReferenceRelation;
  readonly target_kind: "rfc" | "subseries" | "external" | "other" | "unknown";
  readonly target: string | null;
  readonly target_rfc: number | null;
  readonly resolution: ReferenceResolution;
  readonly external: ExternalReferenceIdentity | null;
  readonly cited_by: readonly { readonly block_id: string; readonly section_id: string; readonly offset: number }[];
}

export type EdgeType =
  | "cites_normative"
  | "cites_informative"
  | "cites_external"
  | "uses_bcp14"
  | "updates"
  | "updated_by"
  | "obsoletes"
  | "obsoleted_by"
  | "is_also"
  | "see_also"
  | "inferred";

export interface GraphNode {
  readonly id: string;
  readonly kind: "document";
  readonly rfc: number | null;
  readonly title: string | null;
  readonly resolution: "resolved" | "unresolved" | "stub";
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly relation: string;
  readonly evidence: { readonly source: string; readonly url: string | null; readonly observed_at: string } | null;
}

export interface GraphResult {
  readonly root: string;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly depth: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: boolean;
  readonly unresolved: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Errata, history, citations, assets                                         */
/* -------------------------------------------------------------------------- */

export interface Erratum {
  readonly errata_id: string;
  readonly rfc: number;
  readonly status: ErrataStatus;
  readonly type: string | null;
  readonly section: string | null;
  readonly original_text: string | null;
  readonly corrected_text: string | null;
  readonly notes: string | null;
  readonly submitted_at: string | null;
  readonly updated_at: string | null;
  readonly url: string;
}

/**
 * Erratum status, canonicalized to the same snake_case vocabulary the `errata`
 * input schema accepts.
 *
 * The RFC Editor ships `errata_status_code` as display text
 * ("Held for Document Update"), so a corpus written without normalization stores a
 * value no schema enum can name. A `status=held_for_document_update` filter then
 * matches nothing and reports an empty list, which is indistinguishable from "this
 * RFC has no errata of that status". `canonicalErrataStatus` is the single place
 * that decides which spelling is canonical; `errataStatusFilter` resolves a caller's
 * value against it so both spellings keep working.
 */
export type ErrataStatus = "verified" | "reported" | "rejected" | "held_for_document_update" | "unknown";

export const ERRATA_STATUSES: readonly ErrataStatus[] = Object.freeze([
  "verified",
  "reported",
  "rejected",
  "held_for_document_update",
  "unknown",
]);

/** Lower case, spaces and hyphens collapsed to underscores. */
export function canonicalErrataStatus(value: string | null | undefined): ErrataStatus {
  const slug = (value ?? "")
    .toLowerCase()
    .replace(/[\s-]+/gu, "_")
    .trim();
  return (ERRATA_STATUSES as readonly string[]).includes(slug) ? (slug as ErrataStatus) : "unknown";
}

/**
 * Resolve a requested status to a SQL match expression over `errata.status`, or
 * `null` for "every status".
 *
 * Legacy rows hold display text, current rows hold the slug, so the predicate has
 * to accept both. `any` is the explicit spelling of "no filter"; it must never
 * reach SQL as the literal string "any".
 */
export function errataStatusFilter(value: string | null | undefined): { clause: string; parameter: string } | null {
  if (value === null || value === undefined || value === "" || value.toLowerCase() === "any") return null;
  const slug = canonicalErrataStatus(value);
  return { clause: "lower(replace(replace(status, ' ', '_'), '-', '_')) = ?", parameter: slug };
}

export interface HistoryEntry {
  readonly id: string;
  readonly rfc: number;
  readonly title: string;
  readonly summary: string;
  readonly published_at: string | null;
  readonly author: string | null;
  readonly url: string;
}

export interface Citation {
  readonly citation_id: string;
  readonly document_id: string;
  readonly snapshot_id: string;
  readonly source_uri: string;
  readonly locator: {
    readonly section_path: readonly string[];
    readonly block_id: string;
    readonly span: Span;
  };
  readonly quote: string;
  readonly quote_sha256: string;
  readonly observed_at: string;
}

/**
 * What `verify_citation` could establish.
 *
 * The two identifier kinds answer different questions and the verdicts mean different
 * things for each. A snapshot-scoped id (`cit_…`) is `verified` only against the exact
 * derivation it was minted from. A re-derivation-stable id (`scit_…`) names a sentence
 * in a section, so it resolves in more than one snapshot by design — and resolving it
 * anywhere other than a snapshot that minted it is `stale`, not `verified`, because
 * "this text is still in the document" and "this text is in the document you pinned" are
 * different claims and a caller holding a contract line needs to know which one it got.
 */
export type CitationVerdict = "verified" | "stale" | "ambiguous" | "not_found" | "integrity_failure";

/**
 * Whether a count may be read as a document's whole content, as opposed to how much of it
 * a pass could see.
 *
 * The distinction the enum exists for: `partial` says a known amount was not read, and
 * `unknown` says the question was not asked of anything - the numbers that would answer it
 * were never recorded, or were recorded by two different rules and do not reconcile. Both
 * used to be reported as a successful response holding a number, which is how a
 * specification that states its rules in a table came to certify itself clean.
 */
export type Completeness = "complete" | "partial" | "unknown";

/** A `Completeness` with the measured facts it was derived from, and the reasons. */
export interface CoverageVerdict {
  readonly completeness: Completeness;
  /** `key:value` pairs, every value a number or a name, in a fixed order. */
  readonly basis: string;
  /** Warning keys, each of which also appears in the response's `warnings`. */
  readonly reasons: readonly string[];
}

export interface SourceAsset {
  readonly document_id: string;
  readonly snapshot_id: string | null;
  readonly format: string;
  readonly content_type: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly retrieved_at: string;
  readonly source_url: string;
  readonly etag: string | null;
  readonly last_modified: string | null;
}

/* -------------------------------------------------------------------------- */
/* Operation payloads                                                          */
/* -------------------------------------------------------------------------- */

export interface ResolveResult {
  readonly document: CatalogRecord;
  readonly snapshot: Snapshot;
  readonly available_formats: readonly string[];
  readonly analyses: {
    readonly requirements_extracted: boolean;
    readonly references_extracted: boolean;
    readonly warnings: readonly string[];
  };
}

export interface ReadResult {
  readonly document: CatalogRecord;
  readonly snapshot: Snapshot;
  readonly target: {
    readonly kind: "section" | "outline" | "blocks" | "raw_slice" | "xml_outline";
    readonly section: string | null;
    readonly block_id: string | null;
  };
  readonly section: Section | null;
  readonly blocks: readonly Block[];
  readonly text: string | null;
  readonly outline: readonly Section[] | null;
  /**
   * Present for `target: "xml_outline"` only: the authoritative RFCXML structure.
   * `outline` stays null there because it describes the plain-text parse, and the two
   * are deliberately not merged.
   */
  readonly xml_outline?: XmlDocumentOutline | null;
  /**
   * The section's content with printing artefacts removed. This is what `text` holds.
   *
   * `text_verbatim` is the byte-exact slice that the section's char and byte span
   * denote, and `text_clean` is an alias of `text` kept for callers written against
   * 0.2.0. Line counts are equal in both, so they compare line for line.
   */
  readonly text_verbatim?: string;
  readonly text_sha256_verbatim?: string;
  readonly text_clean?: string;
  readonly page_furniture_lines?: readonly number[];
  readonly text_fidelity?: string;
  readonly truncated: boolean;
  readonly byte_cursor: number | null;
}

export interface SearchHit {
  readonly document_id: string;
  readonly rfc: number;
  readonly title: string;
  readonly snapshot_id?: string;
  readonly section_id?: string | null;
  readonly section_path?: readonly string[];
  readonly block_id?: string | null;
  readonly match_field: "text" | "title" | "abstract" | "keywords" | "authors" | "status" | "stream";
  readonly snippet: string;
  readonly highlight_spans: readonly { readonly start: number; readonly end: number }[];
  readonly citation_id: string | null;
  readonly score: number;
}

export interface CitationMatch {
  readonly citation_id: string;
  readonly document_id: string;
  readonly snapshot_id: string;
  readonly section_id: string;
  readonly section_path: readonly string[];
  readonly block_id: string;
  readonly span: Span;
  readonly excerpt: string;
}

export interface DiffChange {
  readonly id: string;
  readonly kind: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly before_citation_id: string | null;
  readonly after_citation_id: string | null;
  readonly notes: readonly string[];
}

/**
 * What a diff actually compared, and whether that comparison is an answer.
 *
 * The failure this exists for: `diff(2178, 2328, mode: "requirements")` returned
 * `changes: []`, `summary: {}`, `truncated: false`, `status: "ok"` and no warnings, because
 * both documents have zero extracted requirements. An empty successful response is shaped
 * exactly like a finding of "nothing changed", and `status: "ok"` is an assertion - so a
 * routing engineer asking what the 1998 Internet Standard changed against the 1991 draft
 * they implemented was told the answer was nothing. A diff between two empty extractions
 * is not a clean diff; it is a question nobody ran.
 *
 * `verdict` says whether the comparison ran at all, and `clean` says whether its result may
 * be read as the whole answer. They are separate because they fail separately: an empty
 * side is `unanswered` whatever the coverage says, and a comparison that ran on two lossy
 * sides is a real answer with a caveat, which downgrading to a failure would only bury.
 */
export interface DiffCoverage {
  readonly mode: string;
  readonly left: DiffCoverageSide;
  readonly right: DiffCoverageSide;
  /** Items each side contributed on this mode. Zero on either side makes the diff unanswered. */
  readonly items: { readonly left: number; readonly right: number };
  /**
   * `unanswered` when a side contributed nothing to compare, or when the mode did not run
   * the comparison it names. `differences` / `no_differences` when it did.
   */
  readonly verdict: "unanswered" | "differences" | "no_differences";
  /** The machine-readable cause of an `unanswered` verdict. */
  readonly reason:
    | "both_sides_contributed"
    | "left_contributed_nothing"
    | "right_contributed_nothing"
    | "neither_side_contributed"
    | "mode_fell_back_to_structure"
    | "texts_differ_but_no_line_hunk_was_produced";
  /** True only when both sides are `complete` and both contributed. */
  readonly clean: boolean;
  /** What this mode does not cover, in words, for a caller who has to act on the answer. */
  readonly note: string;
}

export interface DiffCoverageSide {
  readonly document_id: string;
  readonly snapshot_id: string;
  /** Requirements, sections, references or lines, whichever the mode compares. */
  readonly items: number;
  readonly completeness: Completeness;
  /** `key:value` pairs, the same grammar `requirements.coverage.completeness_basis` uses. */
  readonly basis: string;
}

export interface DiffResult {
  readonly left: { readonly document_id: string; readonly snapshot_id: string };
  readonly right: { readonly document_id: string; readonly snapshot_id: string };
  readonly mode: string;
  readonly base: string;
  readonly changes: readonly DiffChange[];
  readonly summary: Record<string, number>;
  readonly truncated: boolean;
  /**
   * What was compared and whether the empty answer is a finding. Optional only because
   * `diffDocuments` in `src/analysis/diff.ts` builds a `DiffResult` and does not know about
   * it; every response that leaves the service carries it.
   */
  readonly coverage?: DiffCoverage;
  /**
   * Whether the mode that was asked for is the mode that ran.
   *
   * `mode: "text"` over documents larger than the line-diff ceiling falls back to a
   * structural diff, and before this field existed the reason was computed and then
   * discarded into a local array with nowhere to go. A caller asking for a text diff and
   * receiving a list of section renames had no way to tell that no line diff ran - the
   * response said `status: "ok"`, and `diff(5246, 8446, "text")` was byte-identical to
   * `mode: "structure"`. Measured: RFC 5246 is 5 828 lines, 8446 is 8 964, 2178 is 11 820,
   * 2328 is 12 202, all over the 2 000-line ceiling.
   */
  readonly run?: DiffRun;
}

export interface IndexStatus {
  readonly corpus_id: string;
  readonly state: "ready" | "stale" | "missing" | "degraded";
  readonly index_generation: number;
  readonly documents: {
    readonly catalog: number;
    readonly snapshots: number;
    readonly with_requirements: number;
    readonly stale: number;
  };
  readonly last_successful_sync: string | null;
  readonly last_catalog_sync: string | null;
  readonly parser_versions: readonly string[];
  readonly extractor_versions: readonly string[];
  readonly offline: boolean;
  readonly failures: readonly { readonly code: string; readonly at: string; readonly message: string }[];
}
