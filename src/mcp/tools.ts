/**
 * Tool surface.
 *
 * Names are short because OpenCode namespaces them as `rfc_<tool>`; every tool
 * is read-only, bounded, cancellable, and returns the same envelope shape:
 *
 *   { contract, status, data, provenance, warnings, next_cursor, limits }
 *
 * `status` describes the *operation*, never the RFC.
 */

import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { RfcMcpError, isRfcMcpError } from "../core/errors.js";
import { CONTRACT_VERSION, type Envelope } from "../core/types.js";
import type {
  BatchInput,
  DependenciesInput,
  DiffInput,
  ErrataInput,
  HistoryInput,
  MetadataInput,
  ReadInput,
  ReferencesInput,
  RequirementsInput,
  ResolveInput,
  RfcService,
  SearchInput,
  SourceInput,
  VerifyCitationInput,
} from "../service/rfcService.js";

const ProvenanceSchema = z.object({
  corpus_id: z.string(),
  index_generation: z.number().int().nonnegative(),
  parser_version: z.string(),
  extractor_version: z.string(),
  observed_at: z.string(),
  source_urls: z.array(z.string()),
  freshness: z.enum(["current", "cached", "stale", "offline"]),
});

const EnvelopeSchema = z.object({
  contract: z.literal(CONTRACT_VERSION),
  status: z.enum(["ok", "partial", "degraded"]),
  data: z.record(z.string(), z.unknown()),
  provenance: ProvenanceSchema,
  warnings: z.array(z.string()),
  next_cursor: z.string().nullable(),
  limits: z.object({
    applied: z.record(z.string(), z.number()),
    truncated: z.boolean(),
  }),
});

const ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

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

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/* The SDK infers handler argument types from the zod schema; the wrapper below
 * is intentionally untyped at the boundary and strict everywhere else. */
type AnyToolHandler = (args: any, ctx: { mcpReq: { signal: AbortSignal } }) => Promise<ToolResult>;

function envelopeResult(envelope: Envelope<unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

function errorResult(error: unknown): ToolResult {
  const payload = isRfcMcpError(error)
    ? { contract: CONTRACT_VERSION, status: "degraded", error: error.toJSON() }
    : {
        contract: CONTRACT_VERSION,
        status: "degraded",
        error: { code: "INTERNAL", message: "Unexpected server error", retryable: true },
      };
  if (!isRfcMcpError(error)) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", event: "tool.unhandled", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
}

export function registerTools(server: McpServer, service: RfcService): void {
  const guard =
    <A, T>(run: (args: A, signal: AbortSignal) => Promise<Envelope<T>>): AnyToolHandler =>
    async (args, ctx) => {
      try {
        return envelopeResult(await run(args as unknown as A, ctx.mcpReq.signal));
      } catch (error) {
        return errorResult(error);
      }
    };

  server.registerTool(
    "capabilities",
    {
      title: "Server capabilities and contract",
      description:
        "Self-describing contract: guarantees, tools, resources, prompts, search grammar, limits, upstream sources and policy. Call this first in an unfamiliar session.",
      inputSchema: z.strictObject({}),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard(async () => service.capabilities()),
  );

  server.registerTool(
    "resolve",
    {
      title: "Resolve an RFC to a pinned snapshot",
      description:
        "Turn any selector (rfc / document_id / uri) into an immutable, content-addressed snapshot. This is the only operation that resolves 'current'; every later read and analysis should reuse the returned snapshot_id. Ingests the document on first use and caches it.",
      inputSchema: z.strictObject({
        rfc: z.union([z.number().int().min(1).max(99_999), z.string().regex(/^[Rr][Ff][Cc]?\d{1,5}$/u)]).optional(),
        document_id: z
          .string()
          .regex(/^rfc-\d{1,5}$/u)
          .optional(),
        uri: z.string().max(512).optional().describe("Any official RFC URL or info page URL"),
        refresh: z.boolean().optional().describe("Re-fetch upstream even when a snapshot exists"),
        with_xml: z.boolean().optional().describe("Also cache the RFCXML asset for xml_outline reads"),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: ResolveInput, signal) => service.resolve(args, { signal })),
  );

  server.registerTool(
    "metadata",
    {
      title: "Structured RFC metadata",
      description:
        "Title, authors, dates, status, stream, area, working group, keywords, identifiers (DOI), subseries and document relations (obsoletes / obsoleted-by / updates / updated-by). Author email addresses are never exposed.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        include: z
          .array(z.enum(["relations", "series", "errata_summary", "identifiers"]))
          .optional()
          .describe("Which metadata groups to include (default: relations, series, identifiers)"),
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: MetadataInput, signal) => service.metadata(args, { signal })),
  );

  server.registerTool(
    "read",
    {
      title: "Read a section, outline or raw byte slice",
      description:
        "Read one section (or subsection), the full outline, an RFCXML outline, or a bounded raw byte slice of the published text. Section numbers are exact ('7.4.1', 'Appendix A'); titles are also addressable. Source maps (byte/char/code-point/line offsets) are included for every block.",
      inputSchema: z.strictObject({
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
          .min(1024)
          .max(4 * 1024 * 1024)
          .optional(),
        offset_bytes: z.number().int().min(0).optional().describe("Only for target=raw_slice"),
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: ReadInput, signal) => service.read(args, { signal })),
  );

  server.registerTool(
    "search",
    {
      title: "Search the RFC catalog and ingested corpus",
      description:
        'Bounded search over catalog metadata (title, abstract, keywords, authors, status, stream) and, when documents are ingested, over section text. Grammar: free text, "exact phrase", and filters rfc:9110 section:7.4 keyword:MUST status:std stream:IETF author:Fielding relation:normative. Never exposes raw query syntax to the engine.',
      inputSchema: z.strictObject({
        query: z.string().min(2).max(2000),
        scope: z
          .enum(["auto", "catalog", "text"])
          .optional()
          .describe("auto (default) prefers catalog hits, then text"),
        ...PageShape,
        context_chars: z.number().int().min(40).max(2000).optional(),
        block_kinds: z.array(z.string()).optional().describe("Restrict text search to block kinds, e.g. ['paragraph']"),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: SearchInput, signal) => service.search(args, { signal })),
  );

  server.registerTool(
    "requirements",
    {
      title: "Extract RFC 2119/8174 requirements",
      description:
        "List normative statements (MUST/MUST NOT/SHOULD/SHOULD NOT/MAY/REQUIRED/OPTIONAL, upper case per RFC 8174) with the exact quoted sentence, section, clause split (condition/actor/action/exception), parse status, confidence and a verifiable citation id. Code, tables, figures, references and quoted definitions are excluded by design and reported as mentions.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        scope: z.string().max(32).optional().describe("Restrict to a section number or prefix, e.g. '7' or '7.4'"),
        term: z.string().max(32).optional().describe("Exact keyword filter, e.g. MUST NOT"),
        keyword: z.string().max(64).optional().describe("Substring filter over the requirement text"),
        ...PageShape,
        include_mentions: z.boolean().optional().describe("Include non-requirement mentions (default true)"),
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: RequirementsInput, signal) => service.requirements(args, { signal })),
  );

  server.registerTool(
    "references",
    {
      title: "List references with normative/informative classification",
      description:
        "Reference entries of a document with their label, resolved target (RFC/BCP/STD/FYI), relation (normative, informative, in_body), resolution state and every in-body citation site with offsets. A normative reference is not automatically a protocol dependency; the distinction is preserved.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        relation: z.enum(["normative", "informative", "in_body", "metadata"]).optional(),
        resolution: z.enum(["exact", "ambiguous", "unresolved", "not_attempted"]).optional(),
        label: z.string().max(80).optional(),
        ...PageShape,
        include_cited_by: z.boolean().optional(),
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: ReferencesInput, signal) => service.references(args, { signal })),
  );

  server.registerTool(
    "dependencies",
    {
      title: "Bounded dependency graph",
      description:
        "Typed, bounded graph around one document: cites_normative, cites_informative, obsoletes/obsoleted_by, updates/updated_by, plus inbound relations from the IETF Datatracker. Every edge carries evidence; unresolved labels stay unresolved and are reported instead of being guessed.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        direction: z.enum(["outgoing", "incoming", "both"]).optional(),
        depth: z.number().int().min(1).max(3).optional(),
        max_nodes: z.number().int().min(2).max(200).optional(),
        max_edges: z.number().int().min(1).max(500).optional(),
        include_inferred: z.boolean().optional().describe("Reserved; inferred edges are never produced today"),
        refresh_relations: z.boolean().optional(),
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: DependenciesInput, signal) => service.dependencies(args, { signal })),
  );

  server.registerTool(
    "diff",
    {
      title: "Diff two pinned RFC snapshots",
      description:
        "Compare two documents on one axis: text (line hunks, explicitly not a semantic diff), structure (added/removed/moved/renamed sections), requirements (added/removed/modality_changed), metadata, or references. Both sides must be pinned snapshots.",
      inputSchema: z.strictObject({
        left: z.strictObject(AnchorShape),
        right: z.strictObject(AnchorShape),
        mode: z.enum(["text", "structure", "requirements", "metadata", "references"]).optional(),
        max_changes: z.number().int().min(1).max(500).optional(),
        include_unchanged: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: DiffInput, signal) => service.diff(args, { signal })),
  );

  server.registerTool(
    "errata",
    {
      title: "Errata overlay for an RFC",
      description:
        "Verified, reported, rejected and held-for-document-update errata with section, original and corrected text. Errata are NOT incorporated into the published TXT/PDF/XML; this is an overlay, never a patch applied to the snapshot.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        status: z.enum(["verified", "reported", "rejected", "held_for_document_update", "any"]).optional(),
        ...PageShape,
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: ErrataInput, signal) => service.errata(args, { signal })),
  );

  server.registerTool(
    "history",
    {
      title: "Document change history",
      description:
        "Datatracker change feed for the document (metadata edits, state transitions, errata actions) with timestamps and links. It is an operational history, not an official version history.",
      inputSchema: z.strictObject({
        ...AnchorShape,
        ...PageShape,
        refresh: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: HistoryInput, signal) => service.history(args, { signal })),
  );

  server.registerTool(
    "source",
    {
      title: "Fetch an official publication file",
      description:
        "Return the official TXT, XML, HTML or PDF representation of an RFC with its SHA-256, ETag, Last-Modified and canonical URLs. Text can be inlined for TXT/XML/HTML within a bounded size. RFC text is reproduced unmodified with attribution.",
      inputSchema: z.strictObject({
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
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: SourceInput, signal) => service.source(args, { signal })),
  );

  server.registerTool(
    "verify_citation",
    {
      title: "Verify a citation against the stored bytes",
      description:
        "Re-verify a citation id, quote hash or locator against the snapshot bytes. Verdicts: verified, stale, ambiguous, not_found, integrity_failure. Use this before repeating any quoted requirement in an answer.",
      inputSchema: z.strictObject({
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
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: VerifyCitationInput, signal) => service.verifyCitation(args, { signal })),
  );

  server.registerTool(
    "status",
    {
      title: "Corpus status",
      description:
        "Local corpus health: catalog size, ingested snapshots, index generation, parser/extractor versions, last successful sync, offline mode and recent failures. Use it to decide whether a NOT_CACHED error is expected.",
      inputSchema: z.strictObject({
        include_failures: z.boolean().optional(),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: { include_failures?: boolean }) =>
      service.status({ include_failures: args.include_failures === true }),
    ),
  );

  server.registerTool(
    "batch",
    {
      title: "Run several read-only operations in one call",
      description:
        "Compose up to 10 read-only operations (resolve, metadata, read, search, requirements, references, dependencies, diff, errata, history, source, verify_citation, status, capabilities). Nesting is rejected; each item reports its own status so one failure never hides the rest. The corpus generation is pinned at the start of the batch.",
      inputSchema: z.strictObject({
        operations: z
          .array(z.looseObject({ op: z.string().min(1) }))
          .min(1)
          .max(10),
      }),
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard((args: BatchInput, signal) => service.batch(args, { signal })),
  );
}

export { RfcMcpError };
