/**
 * Wire-level input schemas.
 *
 * One definition per operation, shared by the MCP tool surface and the batch
 * executor so that a payload is validated identically on both paths. Every schema
 * is strict on purpose: an unknown or misspelled key is rejected instead of being
 * dropped, because a silently ignored filter turns a filtered question into an
 * unfiltered answer while still looking like a success. That is the one class of
 * divergence this server must never produce.
 *
 * Each schema is annotated with the service input interface it describes, so a
 * change to an interface that is not mirrored here fails the type check.
 */

import { z } from "zod";

import type {
  DependenciesInput,
  DiffInput,
  ErrataInput,
  HistoryInput,
  MetadataInput,
  ReadInput,
  ReferencesInput,
  RequirementsInput,
  ResolveInput,
  SearchInput,
  SourceInput,
  VerifyCitationInput,
} from "./rfcService.js";

const AnchorShape = {
  rfc: z.number().int().min(1).max(99_999).optional().describe("RFC number, 1..99999"),
  snapshot_id: z
    .string()
    .regex(/^snp_[0-9a-f]{24}$/u)
    .optional()
    .describe("Pinned snapshot id from resolve(); preferred over rfc for reproducibility"),
};

const PageShape = {
  max_results: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional().describe("Opaque cursor from a previous response's next_cursor"),
};

export const CapabilitiesInputSchema = z.strictObject({});

export const ResolveInputSchema: z.ZodType<ResolveInput> = z.strictObject({
  rfc: z.union([z.number().int().min(1).max(99_999), z.string().regex(/^[Rr][Ff][Cc]?\d{1,5}$/u)]).optional(),
  document_id: z
    .string()
    .regex(/^rfc-\d{1,5}$/u)
    .optional(),
  uri: z.string().max(512).optional().describe("Any official RFC URL or info page URL"),
  refresh: z.boolean().optional().describe("Re-fetch upstream even when a snapshot exists"),
  with_xml: z.boolean().optional().describe("Also cache the RFCXML asset for xml_outline reads"),
});

export const MetadataInputSchema: z.ZodType<MetadataInput> = z.strictObject({
  ...AnchorShape,
  include: z
    .array(z.enum(["relations", "series", "errata_summary", "identifiers"]))
    .optional()
    .describe("Which metadata groups to include (default: relations, series, identifiers)"),
  refresh: z.boolean().optional(),
});

export const ReadInputSchema: z.ZodType<ReadInput> = z.strictObject({
  ...AnchorShape,
  target: z
    .enum(["section", "outline", "xml_outline", "raw_slice", "blocks"])
    .optional()
    .describe("section (default) | outline | xml_outline | raw_slice | blocks"),
  section: z.string().max(32).optional().describe("Section number, e.g. '7.4.1' or 'Appendix A'"),
  section_id: z.string().optional().describe("Section id from an outline read"),
  block_id: z.string().optional(),
  include: z
    .array(z.enum(["text", "blocks", "outline", "source_map", "subsections"]))
    .optional()
    .describe("Default: text, blocks, source_map"),
  format: z.enum(["structured", "text"]).optional(),
  max_output_bytes: z
    .number()
    .int()
    .min(64)
    .max(4 * 1024 * 1024)
    .optional()
    .describe("Byte budget for the response body (min 64). Use raw_slice + offset_bytes for large documents."),
  offset_bytes: z.number().int().min(0).optional().describe("Only for target=raw_slice"),
  refresh: z.boolean().optional(),
});

export const SearchInputSchema: z.ZodType<SearchInput> = z.strictObject({
  query: z
    .string()
    .min(2)
    .max(2000)
    .describe(
      "Free text and quoted phrases, ANDed. Upper-case OR / AND / NOT are boolean operators; lower-case or/and/not are literal words.",
    ),
  scope: z.enum(["auto", "catalog", "text"]).optional().describe("auto (default) prefers catalog hits, then text"),
  ensure_rfcs: z
    .array(z.number().int().min(1).max(99_999))
    .max(20)
    .optional()
    .describe("Ingest these RFCs before searching; text search only covers ingested documents"),
  ...PageShape,
  context_chars: z.number().int().min(40).max(2000).optional(),
  block_kinds: z.array(z.string()).optional().describe("Restrict text search to block kinds, e.g. ['paragraph']"),
});

export const RequirementsInputSchema: z.ZodType<RequirementsInput> = z.strictObject({
  ...AnchorShape,
  scope: z.string().max(32).optional().describe("Restrict to a section number or prefix, e.g. '7' or '7.4'"),
  term: z.string().max(32).optional().describe("Exact keyword filter, e.g. MUST NOT"),
  keyword: z.string().max(64).optional().describe("Substring filter over the requirement text"),
  ...PageShape,
  include_mentions: z.boolean().optional().describe("Include non-requirement mentions (default true)"),
  include_candidates: z
    .boolean()
    .optional()
    .describe(
      "Include requirement-shaped statements the strict upper-case extractor rejected, e.g. 'Must be zero' (default true). Read these before concluding a document states no requirements.",
    ),
  max_candidates: z.number().int().min(1).max(2000).optional().describe("Cap on non-strict candidates (default 500)"),
  refresh: z.boolean().optional(),
});

export const ReferencesInputSchema: z.ZodType<ReferencesInput> = z.strictObject({
  ...AnchorShape,
  relation: z.enum(["normative", "informative", "in_body", "metadata"]).optional(),
  resolution: z.enum(["exact", "ambiguous", "external", "unresolved", "not_attempted"]).optional(),
  label: z.string().max(80).optional(),
  ...PageShape,
  include_cited_by: z.boolean().optional(),
  refresh: z.boolean().optional(),
});

export const DependenciesInputSchema: z.ZodType<DependenciesInput> = z.strictObject({
  ...AnchorShape,
  direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  max_nodes: z.number().int().min(2).max(200).optional(),
  max_edges: z.number().int().min(1).max(500).optional(),
  include_inferred: z.boolean().optional().describe("Reserved; inferred edges are never produced today"),
  refresh_relations: z.boolean().optional(),
  refresh: z.boolean().optional(),
});

export const DiffInputSchema: z.ZodType<DiffInput> = z.strictObject({
  left: z.strictObject(AnchorShape),
  right: z.strictObject(AnchorShape),
  mode: z.enum(["text", "structure", "requirements", "metadata", "references"]).optional(),
  max_changes: z.number().int().min(1).max(500).optional(),
  include_unchanged: z.boolean().optional(),
});

export const ErrataInputSchema: z.ZodType<ErrataInput> = z.strictObject({
  ...AnchorShape,
  status: z
    .enum(["verified", "reported", "rejected", "held_for_document_update", "any"])
    .optional()
    .describe("Erratum status, or 'any' for every status (the default). The response reports available_statuses."),
  ...PageShape,
  refresh: z.boolean().optional(),
});

export const HistoryInputSchema: z.ZodType<HistoryInput> = z.strictObject({
  ...AnchorShape,
  ...PageShape,
  refresh: z.boolean().optional(),
});

export const SourceInputSchema: z.ZodType<SourceInput> = z.strictObject({
  ...AnchorShape,
  format: z.enum(["txt", "xml", "html", "pdf"]).optional(),
  include_text: z.boolean().optional(),
  max_text_bytes: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 * 1024)
    .optional(),
  refresh: z.boolean().optional(),
});

export const VerifyCitationInputSchema: z.ZodType<VerifyCitationInput> = z.strictObject({
  citation_id: z.string().max(96).optional(),
  snapshot_id: z
    .string()
    .regex(/^snp_[0-9a-f]{24}$/u)
    .optional(),
  rfc: z.number().int().min(1).max(99_999).optional(),
  block_id: z.string().optional(),
  char_start: z.number().int().min(0).optional(),
  quote_sha256: z
    .string()
    .regex(/^(sha256:)?[0-9a-f]{64}$/u)
    .optional(),
  section: z.string().max(32).optional(),
});

export const StatusInputSchema = z.strictObject({
  include_failures: z.boolean().optional(),
});

/**
 * The batch envelope is validated structurally here; each operation is validated
 * against the schema of the tool it names before it is dispatched.
 */
export const BatchInputSchema = z.strictObject({
  operations: z
    .array(z.looseObject({ op: z.string().min(1) }))
    .min(1)
    .max(10),
});

/** Schemas addressable by batch operation name. `batch` itself is rejected. */
export const BATCH_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  resolve: ResolveInputSchema,
  metadata: MetadataInputSchema,
  read: ReadInputSchema,
  search: SearchInputSchema,
  requirements: RequirementsInputSchema,
  references: ReferencesInputSchema,
  dependencies: DependenciesInputSchema,
  diff: DiffInputSchema,
  errata: ErrataInputSchema,
  history: HistoryInputSchema,
  source: SourceInputSchema,
  verify_citation: VerifyCitationInputSchema,
  status: StatusInputSchema,
  capabilities: CapabilitiesInputSchema,
};

/** Accepted keys of a strict object schema, used to build actionable errors. */
export function allowedKeys(schema: z.ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape).sort() : [];
}

export interface ArgumentProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * Turns a validation failure into a caller-facing problem list. Unknown keys are
 * reported separately from invalid values because they are almost always a
 * misspelling, and the allowed names are echoed back so the call can be corrected
 * without consulting the schema.
 */
export function describeIssues(
  error: z.ZodError,
  schema: z.ZodType,
): {
  message: string;
  problems: readonly ArgumentProblem[];
  unknown_keys: readonly string[];
} {
  const unknown: string[] = [];
  const problems: ArgumentProblem[] = [];
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "(root)";
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) unknown.push(key);
      continue;
    }
    problems.push({ path, message: issue.message });
  }
  const known = allowedKeys(schema);
  const parts: string[] = [];
  if (unknown.length > 0) {
    parts.push(`unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  }
  if (problems.length > 0) {
    parts.push(
      `invalid ${problems.length > 1 ? "arguments" : "argument"}: ${problems
        .map((problem) => `${problem.path} ${problem.message}`)
        .join("; ")}`,
    );
  }
  const message = `${parts.join(" | ")}${known.length > 0 ? `. Accepted arguments: ${known.join(", ")}` : ""}`;
  return { message, problems, unknown_keys: unknown };
}
