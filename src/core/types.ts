/**
 * Domain model. The shape of this file is the public contract of the server:
 * every tool, resource and prompt returns these structures verbatim.
 */

import type { XmlDocumentOutline } from "../parse/rfcXml.js";

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
}

/* -------------------------------------------------------------------------- */
/* Normative language (RFC 2119 / RFC 8174)                                    */
/* -------------------------------------------------------------------------- */

export type NormativeStrength = "absolute" | "recommendation" | "optional";
export type NormativePolarity = "positive" | "negative";

export const NORMATIVE_TERMS = Object.freeze({
  "MUST NOT": { strength: "absolute", polarity: "negative" },
  "SHALL NOT": { strength: "absolute", polarity: "negative" },
  "SHOULD NOT": { strength: "recommendation", polarity: "negative" },
  "NOT RECOMMENDED": { strength: "recommendation", polarity: "negative" },
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
}

export interface RequirementClause {
  readonly actor: string | null;
  readonly condition: string | null;
  readonly action: string | null;
  readonly exception: string | null;
}

export interface Requirement extends NormativeMention {
  readonly clause: RequirementClause;
  readonly parse_status: "complete" | "partial" | "heuristic";
  readonly confidence: number;
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
  readonly status: string;
  readonly type: string | null;
  readonly section: string | null;
  readonly original_text: string | null;
  readonly corrected_text: string | null;
  readonly notes: string | null;
  readonly submitted_at: string | null;
  readonly updated_at: string | null;
  readonly url: string;
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

export type CitationVerdict = "verified" | "stale" | "ambiguous" | "not_found" | "integrity_failure";

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

export interface DiffResult {
  readonly left: { readonly document_id: string; readonly snapshot_id: string };
  readonly right: { readonly document_id: string; readonly snapshot_id: string };
  readonly mode: string;
  readonly base: string;
  readonly changes: readonly DiffChange[];
  readonly summary: Record<string, number>;
  readonly truncated: boolean;
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
