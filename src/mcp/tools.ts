/**
 * Tool surface.
 *
 * Names are short because OpenCode namespaces them as `rfc_<tool>`; every tool
 * is read-only, bounded, cancellable, and returns the same envelope shape:
 *
 *   { contract, status, data, provenance, warnings, next_cursor, limits }
 *
 * `status` describes the *operation*, never the RFC.
 *
 * Input schemas are declared once in `service/inputSchemas.ts` and validated here
 * before dispatch, so the MCP surface and the batch executor reject exactly the
 * same payloads. Validation is strict: an unknown key is an error, never a
 * silently dropped filter.
 */

import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { RfcMcpError, isRfcMcpError } from "../core/errors.js";
import { CONTRACT_VERSION, type Envelope } from "../core/types.js";
import type { RfcService } from "../service/rfcService.js";
import {
  BatchInputSchema,
  CapabilitiesInputSchema,
  DependenciesInputSchema,
  DiffInputSchema,
  ErrataInputSchema,
  HistoryInputSchema,
  MetadataInputSchema,
  ReadInputSchema,
  ReferencesInputSchema,
  RequirementsInputSchema,
  ResolveInputSchema,
  SearchInputSchema,
  SourceInputSchema,
  StatusInputSchema,
  VerifyCitationInputSchema,
  describeIssues,
} from "../service/inputSchemas.js";

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
    <S extends z.ZodType>(
      name: string,
      schema: S,
      run: (args: z.output<S>, signal: AbortSignal) => Promise<Envelope<unknown>>,
    ): AnyToolHandler =>
    async (args, ctx) => {
      try {
        const parsed = schema.safeParse(args ?? {});
        if (!parsed.success) {
          const described = describeIssues(parsed.error, schema);
          throw new RfcMcpError("INVALID_ARGUMENT", `${name}: ${described.message}`, {
            details: { tool: name, problems: described.problems, unknown_keys: described.unknown_keys },
            retryable: false,
          });
        }
        return envelopeResult(await run(parsed.data as z.output<S>, ctx.mcpReq.signal));
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
      inputSchema: CapabilitiesInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("capabilities", CapabilitiesInputSchema, async () => service.capabilities()),
  );

  server.registerTool(
    "resolve",
    {
      title: "Resolve an RFC to a pinned snapshot",
      description:
        "Turn any selector (rfc / document_id / uri) into an immutable, content-addressed snapshot. This is the only operation that resolves 'current'; every later read and analysis should reuse the returned snapshot_id. Ingests the document on first use and caches it.",
      inputSchema: ResolveInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("resolve", ResolveInputSchema, (args, signal) => service.resolve(args, { signal })),
  );

  server.registerTool(
    "metadata",
    {
      title: "Structured RFC metadata",
      description:
        "Title, authors, dates, status, stream, area, working group, keywords, identifiers (DOI), subseries and document relations (obsoletes / obsoleted-by / updates / updated-by). Author email addresses are never exposed.",
      inputSchema: MetadataInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("metadata", MetadataInputSchema, (args, signal) => service.metadata(args, { signal })),
  );

  server.registerTool(
    "read",
    {
      title: "Read a section, outline or raw byte slice",
      description:
        "Read one section (or subsection), the full outline, an RFCXML outline, or a bounded raw byte slice of the published text. Section numbers are exact ('7.4.1', 'Appendix A'); titles are also addressable. Source maps (byte/char/code-point/line offsets) are included for every block. Two text fields, do not confuse them: `text` is a verbatim slice whose offsets denote exactly that string, so on a pre-1990 RFC it still contains the printed page's running head and foot; `text_clean` is the same text with those lines emptied, and page_furniture_lines names them — copy from text_clean, cite from text. On `blocks`, the text is present only when `include` contains source_map; omitting `include` entirely returns it, and passing an explicit list without source_map returns empty text and a warning. max_output_bytes may be as low as 64; a small budget narrows the answer, reports truncated, and returns a byte_cursor.",
      inputSchema: ReadInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("read", ReadInputSchema, (args, signal) => service.read(args, { signal })),
  );

  server.registerTool(
    "search",
    {
      title: "Search the RFC catalog and ingested corpus",
      description:
        'Bounded search over catalog metadata (title, abstract, keywords, authors, status, stream) and, when documents are ingested, over section text. Grammar: free text, "exact phrase", filters rfc:9110 section:7.4 keyword:MUST status:std stream:IETF author:Fielding relation:normative, and the upper-case boolean operators OR, AND and NOT (lower-case or/and/not are ordinary words). Never exposes raw query syntax to the engine. Every text hit carries a citation_id that rfc_verify_citation accepts directly. The catalog covers all 9842 documents; text search covers only the ~121 ingested, so the response reports corpus.coverage and a zero-hit result from a partial corpus is flagged. For "which RFC describes X" pass ensure_top_catalog_hits: the catalog proposes the numbers and the server ingests them and reports their titles, which is safer than guessing a number and reading the wrong document; ensure_rfcs does the same when the numbers are already known. A text hit is not a requirement: matching is case-insensitive, so a lower-case "must" matches, and only `requirements` states whether a statement is normative. A filter that the chosen scope cannot honour is reported in warnings, never dropped silently.',
      inputSchema: SearchInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("search", SearchInputSchema, (args, signal) => service.search(args, { signal })),
  );

  server.registerTool(
    "requirements",
    {
      title: "Extract RFC 2119/8174 requirements",
      description:
        'List normative statements (MUST/MUST NOT/SHOULD/SHOULD NOT/MAY/REQUIRED/OPTIONAL, upper case per RFC 8174) with the exact quoted sentence, section, clause split (condition/actor/action/exception), parse status, confidence and a verifiable citation id. Code, tables, figures, references and quoted definitions are excluded by design and reported as mentions. Because the strict reading is upper-case only, a count of 0 is not evidence that a document states no requirements: non_strict_candidates lists the requirement-shaped statements that were rejected (RFC 1035\'s "Must be zero" in a field table, RFC 4033\'s lower-case "must"), ranked so the likeliest obligations come first and filterable server-side with role and shape. shape applies the action-verb test of RFC 2119 section 3: only a clause with an action verb can carry a requirement, so shape=description fails the specification\'s own criterion. role and shape both have an honest unknown/indeterminate value that must be read, not assumed. keyword_usage states whether the document disclaims or adopts the requirement language, which is what makes a zero explicable. For a document predating RFC 2119, include_provisional appends the surviving candidates to requirements under an explicit provisional flag; they never enter coverage.total_requirements. Coverage reports how many prose blocks were scanned. Quotes are never truncated.',
      inputSchema: RequirementsInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("requirements", RequirementsInputSchema, (args, signal) => service.requirements(args, { signal })),
  );

  server.registerTool(
    "references",
    {
      title: "List references with normative/informative classification",
      description:
        "Reference entries of a document with their label, resolved target (RFC/BCP/STD/FYI), relation (normative, informative, in_body), resolution state and every in-body citation site with offsets. A normative reference is not automatically a protocol dependency; the distinction is preserved.",
      inputSchema: ReferencesInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("references", ReferencesInputSchema, (args, signal) => service.references(args, { signal })),
  );

  server.registerTool(
    "dependencies",
    {
      title: "Bounded dependency graph",
      description:
        "Typed, bounded graph around one document: cites_normative, cites_informative, obsoletes/obsoleted_by, updates/updated_by, plus inbound relations from the IETF Datatracker. Every edge carries evidence; unresolved labels stay unresolved and are reported instead of being guessed.",
      inputSchema: DependenciesInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("dependencies", DependenciesInputSchema, (args, signal) => service.dependencies(args, { signal })),
  );

  server.registerTool(
    "diff",
    {
      title: "Diff two pinned RFC snapshots",
      description:
        "Compare two documents on one axis: text (line hunks, explicitly not a semantic diff), structure (added/removed/moved/renamed sections), requirements (added/removed/modality_changed), metadata, or references. Both sides must be pinned snapshots.",
      inputSchema: DiffInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("diff", DiffInputSchema, (args, signal) => service.diff(args, { signal })),
  );

  server.registerTool(
    "errata",
    {
      title: "Errata overlay for an RFC",
      description:
        "Verified, reported, rejected and held-for-document-update errata with section, original and corrected text. Errata are NOT incorporated into the published TXT/PDF/XML; this is an overlay, never a patch applied to the snapshot. Omit status, or pass 'any', for every status. A status filter reports available_statuses and total_unfiltered alongside the rows, and a filter that matches nothing names the statuses that do have errata, so an empty list is never ambiguous.",
      inputSchema: ErrataInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("errata", ErrataInputSchema, (args, signal) => service.errata(args, { signal })),
  );

  server.registerTool(
    "history",
    {
      title: "Document change history",
      description:
        "Datatracker change feed for the document (metadata edits, state transitions, errata actions) with timestamps and links. It is an operational history, not an official version history.",
      inputSchema: HistoryInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("history", HistoryInputSchema, (args, signal) => service.history(args, { signal })),
  );

  server.registerTool(
    "source",
    {
      title: "Fetch an official publication file",
      description:
        "Return the official TXT, XML, HTML or PDF representation of an RFC with its SHA-256, ETag, Last-Modified and canonical URLs. Text can be inlined for TXT/XML/HTML within a bounded size. RFC text is reproduced unmodified with attribution.",
      inputSchema: SourceInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("source", SourceInputSchema, (args, signal) => service.source(args, { signal })),
  );

  server.registerTool(
    "verify_citation",
    {
      title: "Verify a citation against the stored bytes",
      description:
        "Re-verify a citation id, quote hash or locator against the snapshot bytes. Verdicts: verified, stale, ambiguous, not_found, integrity_failure. Accepts the citation_id of a requirement, a mention or a text search hit. Pass the snapshot_id together with the citation_id: a citation is only meaningful against the exact bytes it was derived from. Use this before repeating any quoted requirement in an answer.",
      inputSchema: VerifyCitationInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("verify_citation", VerifyCitationInputSchema, (args, signal) => service.verifyCitation(args, { signal })),
  );

  server.registerTool(
    "status",
    {
      title: "Corpus status",
      description:
        "Local corpus health: catalog size, ingested snapshots, index generation, parser/extractor versions, last successful sync, offline mode and recent failures. Use it to decide whether a NOT_CACHED error is expected.",
      inputSchema: StatusInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("status", StatusInputSchema, async (args) =>
      service.status({ include_failures: args.include_failures === true }),
    ),
  );

  server.registerTool(
    "batch",
    {
      title: "Run several read-only operations in one call",
      description:
        "Compose up to 10 read-only operations (resolve, metadata, read, search, requirements, references, dependencies, diff, errata, history, source, verify_citation, status, capabilities). Nesting is rejected; each item reports its own status so one failure never hides the rest. Each operation is validated against the same schema as the tool it names. The corpus generation is pinned at the start of the batch.",
      inputSchema: BatchInputSchema,
      outputSchema: EnvelopeSchema,
      annotations: ANNOTATIONS,
    },
    guard("batch", BatchInputSchema, (args, signal) =>
      // The envelope schema is structural; each operation is validated against the
      // schema of the tool it names before dispatch.
      service.batch(args as unknown as Parameters<typeof service.batch>[0], { signal }),
    ),
  );
}
