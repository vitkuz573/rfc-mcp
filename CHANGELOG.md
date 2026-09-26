# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `errata` no longer returns an empty list for `status: "any"`, and `status:
  "held_for_document_update"` now matches. The filter was passed to SQL verbatim, so the
  explicit "every status" value matched nothing, and the enum's snake_case spelling never
  equalled the display text the RFC Editor ships (`held for document update`) — 16 of
  RFC 1035's 29 errata were unreachable through any value the schema accepts. Status is
  canonicalized in one place (`canonicalErrataStatus`), both spellings resolve, and every
  response carries `status_filter`, `total_unfiltered` and `available_statuses`, so an empty
  result names the statuses that do have errata instead of looking like an RFC without any.
- The text search grammar has the boolean operators it was documented as lacking. `OR`, `AND`
  and `NOT` are recognised in upper case only, because a lower-case `or` is a word that occurs
  inside RFC prose and reinterpreting it would change the meaning of an ordinary search. Every
  response flags which operator was applied.
- Text search states its own coverage. `corpus` now reports `catalog_documents` and a
  `ingested_text_only:<n>/<m>` string, and a zero-hit result from a partially ingested corpus
  is flagged, so "the term is absent from what I loaded" can no longer be read as "the term is
  absent from the RFC corpus". `ensure_rfcs` ingests up to 20 named documents before searching.
- `requirements` reports what the strict extractor rejected. A count of 0 could not be told
  apart from a parser gap: RFC 1035 writes "Z  Reserved for future use.  Must be zero in all
  queries and responses" and RFC 4033 uses a lower-case "must" throughout, and neither is a
  requirement by the letter of RFC 8174 §3 — yet both bind an implementer.
  `non_strict_candidates` lists them with `keyword_case`, the structural `reason`, and `role`
  (`modal` / `non_modal` / `unknown`) so vocabulary false positives such as "the recommended
  method" can be filtered out. `role: "unknown"` means the shape was not decidable without a
  parser and is never folded into either bucket. Candidates are not requirements and never
  enter their count. `coverage.prose_blocks_scanned` states how much of the document was read.
- List markers no longer leak into a parsed clause. RFC 2822 markers reached the extractor
  attached, so the actor read `o  The RRSIG RR and the RRset` — 81 stored rows in the DNS
  corpus. Markers are stripped, the hard-wrapped layout of a clause is collapsed, and
  `list_marker_stripped_from_clause` records that it happened. `exact_text` and the offsets
  still address the original bytes, so every citation remains verifiable.
- `read` accepts `max_output_bytes` from 64 instead of 1024. The floor was a page size, not a
  byte budget, and rejected a question the server can answer exactly; truncation was already
  reported, so a small budget narrows an answer instead of failing it.
- A read that lists blocks without `source_map` now warns. Such a response carries block rows
  whose `text` is empty, which is a success that answers a different question than the one
  asked; the default (`include` omitted) is unaffected and still returns the text.
- A retired snapshot id explains itself. A rule-version bump re-derives every document under
  a new id, and a caller holding an older pin got a bare `NOT_FOUND`. Retired ids are recorded
  in `snapshot_redirects` and the error now names the document and its current id.
- Page furniture is recognised in both publication eras. RFCs predating the current plain-text
  format carry a running head (`Mockapetris      [Page 26]`) and a running foot
  (`RFC 1035   Domain Implementation and Specification   November 1987`); neither matched the
  anchored patterns, so each became a paragraph block of its own and split the field table
  around it — 2545 such blocks in the corpus. The running foot is pinned by requiring a month
  and a four-digit year as its last two fields, so a body line that merely mentions a page
  number still survives. Dropped lines are counted in the parse warnings.
- `verify_citation` resolves a candidate's citation. Candidate citations are computed on
  demand, so the id was not among the stored records and verification returned `not_found` for
  a fact the server had just handed out. The id is now recomputed over the block's sentences,
  the same way a search hit's is.
- `reanalyze --all` re-derives every ingested document from stored bytes, which is the
  counterpart of a parser or extractor version bump. Run it after bumping either version;
  enumerating every RFC by hand was the step most likely to be forgotten.

### Added

- `non_strict_candidates` on `requirements` (see above).
- `by_role` on the candidate analysis, so a caller can see how much of the list was actually
  decided and discount the rest.
- `prose_block_count` on a snapshot, with a migration backfill, so a requirement count is
  reported next to the number of blocks it was derived from.

### Changed

- Parser `rfc-text-1.2.0` → `rfc-text-1.3.0`, extractor `normative-2119-8174-1.4.0` →
  `normative-2119-8174-1.5.0`. Both are part of snapshot identity by design, so every
  `snp_<hash>` minted under the old versions is retired. `reanalyze --all` re-derives the
  corpus from stored bytes without re-fetching anything.

- `resolve` with `with_xml` now stores the RFCXML asset for a document that is already cached.
  The flag was only honoured on the path that re-derives a document, so on an already-ingested
  RFC it returned the cached snapshot without the asset and the following
  `read(target: "xml_outline")` failed with `NOT_CACHED` — while telling the caller to
  re-resolve with `with_xml`, advice that could not change anything. The asset is not part of
  snapshot identity, so it is attached to the existing snapshot rather than minting a new one.
- An `xml_outline` read on a document the RFC Editor publishes without RFCXML now fails with
  `NOT_FOUND` and states that no such representation exists. It previously returned the same
  `NOT_CACHED` as an unstored asset, which asked a caller to retry a request that could never
  succeed. Across the corpus, 9 of the DNS-family documents are in this state: the editor
  returns 404 for their `.xml`, and the catalog correctly lists no `xml` format for them.

- Text search no longer fails with `INTERNAL` when a `section:` filter or `block_kinds` is
  combined with a query: the FTS5 subquery referenced the table by name while the outer query
  aliased it, which SQLite could not resolve.
- `total` and `next_cursor` of a filtered text search are now computed with the same filters as
  the returned rows. `countBlockMatches` accepted `section_prefix` and `block_kinds` and then
  ignored them, so totals were inflated and pagination never terminated.
- A catalog refresh no longer destroys ingested documents. `upsertCatalogInner` deleted and
  re-inserted the catalog row, and since `snapshots.rfc` references `catalog(rfc)` with
  `ON DELETE CASCADE` that silently removed every snapshot, section, block, requirement and asset
  of the affected RFCs — a full `sync` would have emptied the corpus. The row is now updated in
  place.
- The FTS5 index no longer accumulates rows for deleted snapshots. FTS5 virtual tables ignore
  foreign keys, so the cascade never reached `blocks_fts`; each re-ingest leaked a full text
  index, which inflated totals, skewed bm25 ranking and could surface a `snapshot_id` that no
  longer existed. The index is now purged per RFC on replacement, `vacuum` removes stale rows, and
  search only returns rows whose snapshot is still present.
- `refresh: true` actually re-fetches. The HTTP layer supported conditional revalidation, but
  nothing set the flag, so a fresh TTL cache answered the request while the response claimed the
  document was resolved from upstream.
- Re-observing unchanged bytes no longer mints a new `snapshot_id`. The metadata hash covered
  `observed_at`, so identical content produced a different id depending on when it was fetched.
- Citations returned by `rfc_search` are verifiable. They cover a whole block rather than a stored
  requirement record, so `rfc_verify_citation` now resolves them against the block bytes instead of
  reporting `not_found`.
- Unknown or misspelled tool arguments are rejected with `INVALID_ARGUMENT` instead of being
  silently dropped, and the message lists the accepted names. Every `batch` operation is validated
  against the schema of the tool it names.
- Catalog search no longer fails with a SQL syntax error when a `status:` or `stream:` facet is
  combined with a text term: the facet clause was appended as a second `WHERE`.
- `rfc:`, `status:` and `stream:` now actually narrow a catalog search. `rfc:` was ignored
  entirely, and the facet comparison matched a JSON blob against a partial object, so it never
  matched. Slug and display name are both accepted.
- A filter that the selected scope cannot honour is now reported in `warnings` rather than
  dropped: `filters_not_applied_to_catalog` for `section:` and `relation:` in a catalog search,
  `filters_not_applied_to_text` for `status:`, `stream:` and `relation:` in a text search.
- A query made only of catalog facets (`status:std stream:IETF`) is answered from the catalog
  instead of failing, and an explicit `scope: "text"` is reported as relaxed rather than ignored.
- `relation:` now filters a text search. It resolves through a new normalised
  `reference_citations` index, so results are the blocks that really contain a citation site of a
  normative / informative / in-body reference. Unsupported values are rejected with
  `INVALID_ARGUMENT` instead of being ignored.
- `reanalyze` re-derives a snapshot when the parser or extractor version changes. The reuse check
  compared only `(rfc, format, bytes, metadata hash)`, so a version bump looked like unchanged
  content: the freshly computed analysis was discarded and `reanalyze` reported a new snapshot id
  that was never written. Rule versions are now part of that check.
- A field filter with no value (`status:`) is now rejected with `INVALID_ARGUMENT` instead of
  being searched for as an ordinary word.
- `rfc_read` with `target: "xml_outline"` now returns the parsed RFCXML structure. The outline
  was parsed and then discarded, so the target always answered with an empty list.
- The RFCXML reader no longer skips the body of a document. RFCXML v3 wraps sections in
  `<middle>`; only direct children of `<rfc>` and back matter were read, so the outline of a
  modern RFC contained a handful of back-matter sections instead of its ~300 real ones.
- The RFCXML reader recovers section numbers from the v3 page name (`section-1.1` → `1.1`,
  `section-appendix.a` → `Appendix A`), takes the visible heading from `<name>` when `<title>`
  is absent, and uses the element name as the authority for the references section. A body
  section titled "URI References" is no longer classified as the references section, so the XML
  and plain-text outlines now agree: for RFC 9110 all 293 shared section numbers carry the same
  kind in both representations.
- The RFCXML reader collects citations from `<xref target="...">`, which is the reason to read
  the XML at all: the target is exact, while the rendered label is presentation. A degraded XML
  parse now states its warnings instead of only flipping the status.
- A cited non-IETF document now gets its own identity instead of being reported as unresolved.
  When the entry text designates the document — `FIPS 197`, `ISO/IEC 10646:2003`, `ITU-T X.680`,
  `ANSI X3.4`, `NIST SP 800-38C`, `UAX #15`, or a URL — the reference is reported with
  `target_kind: "external"`, `resolution: "external"` and the recovered `external` identity, and
  appears in the dependency graph as a `cites_external` edge. Across the 60-document corpus this
  resolves 159 references that were previously lumped in with genuinely unidentifiable ones
  (unresolved dropped from 196 to 37). The remainder are books and papers with no designation and
  no URL, and stay `unresolved` — that is what the state means.
- The store applies schema migrations on open. `SCHEMA_SQL` only creates missing tables, so a
  column added to an existing table never reached a corpus that already had that table; the
  reanalyze that introduced the external-identity columns failed loudly rather than corrupting
  anything. Migrations are now declared, idempotent and checked against the live schema, and an
  index over a migrated column is created by the migration rather than by the base schema.

## [0.1.0] — 2026-09-26

First public release. Evidence-first, strictly read-only MCP server for the IETF RFC corpus.

### Added

**MCP surface**

- 15 read-only tools with zod input schemas, `outputSchema` and MCP annotations:
  `capabilities`, `resolve`, `metadata`, `read`, `search`, `requirements`, `references`,
  `dependencies`, `diff`, `errata`, `history`, `source`, `verify_citation`, `status`, `batch`.
- 10 snapshot-addressed `rfc://` resource templates plus static `rfc://index/status` and
  `rfc://catalog/manifest`.
- 6 workflow prompts: `brief`, `requirements_audit`, `compare`, `dependency_review`,
  `citation_check`, `offline_review`, each carrying the evidence discipline and the rule that RFC
  text is untrusted data.
- Dual-era stdio transport: MCP revision `2026-07-28` with automatic fallback to the classic
  `initialize` handshake (`protocol: "auto"` in OpenCode).
- Self-describing `rfc_capabilities` contract: guarantees, tools, resources, prompts, search
  grammar, limits, upstream sources and policy.

**Evidence model**

- Immutable, content-addressed snapshots (`snp_<hash>`) over
  `(rfc, format, raw bytes, metadata hash, parser version, extractor version)`.
- Deterministic citation ids (`cit_<hash>`) verifiable byte-for-byte through
  `rfc_verify_citation` with verdicts `verified | stale | ambiguous | not_found |
  integrity_failure`.
- Offsets reported in three units — UTF-8 bytes, UTF-16 code units, Unicode code points — plus
  line numbers, with the guarantee `rawBytes.slice(byte_start, byte_end) === text`.
- Envelopes carrying `status`, `provenance`, `warnings`, `next_cursor` and hard `limits` on every
  response.

**Parsing and analysis**

- RFC Editor plain-text parser (`rfc-text-1.2.0`): column-1 headings with table-of-contents
  authority, appendix/references/authors/index classification, page-furniture removal that also
  splits blocks, paragraph/list/preformatted/table/reference-entry classification, exact offsets,
  deterministic ids.
- Hardened RFCXML reader (RFC 7991 v3, RFC 7749 v2): DTD and entity declarations rejected, XInclude
  never resolved, bounded depth/nodes/text, authoritative section tree with anchors.
- RFC 2119 / RFC 8174 extraction: eleven keywords, upper case only, longest phrase wins,
  strength/polarity derivation, clause structure (`condition`, `actor`, `action`, `exception`),
  explicit `parse_status` and `confidence`, and mentions instead of requirements for code, tables,
  figures, reference sections, quoted definitions and keyword discussion.
- Reference extraction with normative/informative classification, resolved RFC/BCP/STD/FYI targets
  and in-body citation sites with offsets.
- Typed bounded dependency graph; `inferred` edges are never produced.
- Structured diffs across `text`, `structure`, `requirements`, `metadata` and `references`, with
  `modality_changed` distinguished from breaking changes.

**Storage and operations**

- SQLite store using the built-in `node:sqlite` with FTS5; atomic per-document commits,
  monotonic index generations, integrity-bound cursors, rebuildable search index.
- Operator CLI: catalog sync, bulk and targeted ingestion, status, outline, requirements,
  references, search, show, verify, diff, offline `reanalyze`, `reindex`, `vacuum`.
- `rfc-mcp reanalyze` re-derives all analysis from already stored bytes, fully offline, with no
  re-fetching.

**Safety**

- HTTPS-only host allowlist, no user-supplied URLs, bounded size/time/concurrency, ETag
  revalidation, stale-on-error with explicit warnings.
- Bounded search grammar; FTS5 input is always quoted literals; punctuated phrases are expanded
  into an AND of their parts.
- RFC text treated as untrusted data; author email addresses stripped at the source boundary;
  structured logs with redaction; no model-visible write tool.

### Fixed

- Byte offsets in BOM-prefixed documents: `TextDecoder` strips a leading `U+FEFF` by default, which
  shifted every byte offset by three and made exact citations unverifiable. Decoding now uses
  `ignoreBOM: true`; invalid UTF-8 is reported as `byte_offsets_approximate_invalid_utf8` and
  citation verification falls back to exact character offsets.
- Page furniture inside a paragraph no longer splits the stored text from the raw bytes, so a
  sentence spanning a page break is contiguous and verifiable.
- Actor extraction for main clauses with an exception tail
  ("… except that the server MUST NOT …") now yields the real actor and the
  `exception_before_keyword` flag.
- Unnumbered sections (`Abstract`, `References`, `Author's Address`, …) are addressable by title.
- Heading-only sections (e.g. `19. References` immediately followed by `19.1`) are preserved
  instead of being dropped.

[Unreleased]: https://github.com/vitkuz573/rfc-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vitkuz573/rfc-mcp/releases/tag/v0.1.0
