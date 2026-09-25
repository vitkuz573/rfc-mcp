# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

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
