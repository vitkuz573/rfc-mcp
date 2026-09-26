# Contract `ietf-rfc/1`

Normative description of the data this server returns. The runtime contract is also
discoverable at runtime: `rfc_capabilities` returns the tool, resource, prompt, limit and
policy inventory in machine-readable form.

## 1. Envelope

```jsonc
{
  "contract": "ietf-rfc/1",     // always this literal
  "status": "ok" | "partial" | "degraded",
  "data": { /* tool specific */ },
  "provenance": {
    "corpus_id": "rfc-mcp:<hash>",
    "index_generation": 42,     // monotonic; changes invalidate cursors
    "parser_version": "rfc-text-1.2.0",
    "extractor_version": "normative-2119-8174-1.3.0",
    "observed_at": "2026-09-25T16:04:08.222Z",   // RFC 3339 UTC
    "source_urls": ["https://www.rfc-editor.org/rfc/rfc9110.txt"],
    "freshness": "current" | "cached" | "stale" | "offline"
  },
  "warnings": ["snapshot_not_explicitly_pinned"],
  "next_cursor": null,
  "limits": { "applied": { "max_results": 20 }, "truncated": false }
}
```

`status` semantics:

| Value      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `ok`       | Complete within the applied limits.                                          |
| `partial`  | Paginated, budget-limited, or a subset was returned.                         |
| `degraded` | An assumption did not hold: stale cache, degraded parse, unavailable corpus. |

`status` never describes the RFC itself; a document may be an Internet Standard while the
operation is `degraded` because the network was unavailable.

## 2. Identifiers

| Identifier                  | Form                       | Derivation                                                                                   |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `document_id`               | `rfc-<n>`                  | RFC number, no leading zeros                                                                 |
| `snapshot_id`               | `snp_<24 hex>`             | `sha256(rfc \| format \| raw bytes \| metadata hash \| parser version \| extractor version)` |
| `section_id`                | `sec_<24 hex>`             | `sha256(snapshot \| ordinal \| number \| title)`                                             |
| `block_id`                  | `blk_<24 hex>`             | `sha256(snapshot \| section \| ordinal \| char offset)`                                      |
| `requirement_id`            | `men_<16 hex>`             | derived from the mention citation                                                            |
| `block_id` (ids are opaque) | `blk_<24 hex>`             | `sha256(snapshot \| section \| ordinal \| char offset)`                                      |
| `reference_id`              | `ref_<24 hex>`             | `sha256(snapshot \| label \| ordinal)`                                                       |
| `citation_id`               | `cit_<24 hex>`             | `sha256(snapshot \| block \| byte offset \| quote)`                                          |
| `cursor`                    | `<base64url>.<16 hex mac>` | opaque, integrity-bound, generation-scoped                                                   |

All identifiers are deterministic: the same inputs always produce the same ids on any machine.
Including the parser and extractor versions in `snapshot_id` means a rules change yields a new
snapshot rather than silently reusing analysis produced by different rules; the previous
snapshot remains readable and its own citations continue to verify against its own bytes.

The metadata hash covers document metadata only — title, abstract, dates, status, stream, area,
group, keywords, authors, relations, subseries, identifiers, formats and DOI. It deliberately
excludes `observed_at` and other observation-time fields, so re-observing unchanged bytes always
yields the same `snapshot_id`.

Every `citation_id` is verifiable with `rfc_verify_citation`, including the ones returned by
`rfc_search`. A search citation covers a whole block rather than a stored requirement record, so
verification resolves it against the block bytes and says so in `notes`; it never silently
substitutes a different quote.

## 3. Offsets

Every section and block reports six coordinate pairs:

```jsonc
{
  "byte_start": 1204,
  "byte_end": 1339, // UTF-8 bytes of the raw file
  "char_start": 1204,
  "char_end": 1339, // UTF-16 code units
  "codepoint_start": 1204,
  "codepoint_end": 1339, // Unicode code points
  "line_start": 12,
  "line_end": 13, // 1-based line numbers in the raw file
}
```

Guarantee: `rawBytes.slice(byte_start, byte_end)` reproduces `text` exactly.

## 4. Normalization

| Field                                                   | Rule                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `rfc`                                                   | Integer 1..99999, no leading zeros                                       |
| `keywords`, `formats`, `subseries`                      | Arrays (never the Python-list strings the Datatracker sometimes returns) |
| `status`, `stream`, `area`, `group`                     | `{ name, slug?, description?, acronym?, type? }` or `null`               |
| `authors`                                               | `{ name, affiliation?, is_editor? }` — **never** an email address        |
| `obsoletes` / `obsoleted_by` / `updates` / `updated_by` | Sorted integer arrays of RFC numbers                                     |
| `doc-id`                                                | Uppercase `RFC<number>`                                                  |
| `formats`                                               | Lowercase: `txt`, `html`, `xml`, `pdf`, `json`                           |

## 5. Sections and blocks

```jsonc
{
  "number": "7.4.1",              // "" for front matter, title for unnumbered sections
  "title": "Data Transparency",
  "kind": "front_matter" | "body" | "appendix" | "references" | "authors" | "index" | "status" | "unknown",
  "parent_id": "sec_…",           // null for top level
  "path": ["7", "7.4", "Data Transparency"]
}
```

Block kinds: `paragraph`, `list_item`, `preformatted`, `table`, `figure`, `reference_entry`,
`heading`, `unknown`.

Addressing rules for `rfc_read`:

- `section: "7.4.1"` — exact numbered section;
- `section: "Appendix A"` — appendix;
- `section: "Abstract"` — unnumbered section by title;
- `section_id` / `block_id` — from a previous outline read;
- `include: ["subsections"]` widens the read to descendant content;
- omitting `section` returns the first (front-matter) section.

## 6. Normative statements

```jsonc
{
  "id": "men_…",
  "term": "MUST NOT",             // one of the 11 RFC 2119 keywords, as written
  "strength": "absolute",         // absolute | recommendation | optional
  "polarity": "negative",         // positive | negative
  "exact_text": "The client MUST NOT resend the body.",   // verbatim sentence
  "section": "5.2",
  "clause": {
    "condition": "If a request is retried",   // or the main clause of an exception tail
    "actor": "the client",
    "action": "resend the body",
    "exception": "except after a 503"
  },
  "parse_status": "complete" | "partial" | "heuristic",
  "confidence": 0.9,              // extractor confidence, not truth
  "flags": ["actor_not_explicit", "in_appendix"],
  "citation_id": "cit_…"
}
```

Disposition of a keyword occurrence:

| Disposition   | When                                                                      | Requirement emitted |
| ------------- | ------------------------------------------------------------------------- | ------------------- |
| `requirement` | Upper-case keyword in prose                                               | Yes                 |
| `definition`  | Quoted keyword, definition section, or a sentence enumerating ≥3 keywords | No                  |
| `context`     | Discussing the requirement language                                       | No                  |
| `ignored`     | Non-prose block (code, table, figure, reference)                          | No                  |

Hard rules: only upper case counts (RFC 8174 §3); the longest phrase wins; mixed case is never
normative; a missing actor yields `partial` with `actor_not_explicit`, never an invented actor.

## 7. References

```jsonc
{
  "label": "RFC2119",
  "relation": "normative" | "informative" | "in_body",
  "target_kind": "rfc" | "subseries" | "external" | "other" | "unknown",
  "target": "rfc-2119",
  "target_rfc": 2119,
  "resolution": "exact" | "ambiguous" | "external" | "unresolved" | "not_attempted",
  "external": null,
  "section": "19.1",
  "cited_by": [{ "block_id": "blk_…", "section_id": "sec_…", "offset": 41234 }]
}
```

### Cited non-IETF documents

A normative reference is often not an RFC. When the entry text designates the document itself,
that designation becomes the identity and `resolution` is `external`:

```jsonc
{
  "label": "FIPS197",
  "target_kind": "external",
  "target": "FIPS 197",
  "resolution": "external",
  "external": { "kind": "standard", "id": "FIPS 197", "publisher": "NIST", "year": null },
}
```

`external.kind` is `standard`, `url` or `publication`. The identity is only ever taken from what
the entry states — a designation (`FIPS 197`, `ISO/IEC 10646:2003`, `ITU-T X.680`, `ANSI X3.4`,
`NIST SP 800-38C`, `UAX #15`) or a URL. Nothing is inferred from the label, and an entry with
neither stays `unresolved`, which means exactly one thing: the target could not be identified.
Reporting a cited NIST standard as `unresolved` would describe a successful read as a parsing
failure, which is why the two states are separate.

Where an entry names several designations, the one printed first is the identity; overlapping
matches resolve to the more specific form, so `Unicode Standard, Version 4.0.1` wins over
`The Unicode Standard`.

A normative reference is **not** a dependency. The dependency graph keeps `cites_normative`,
`cites_external` and metadata relations separate, and never emits `inferred` edges.

## 8. Search grammar

```
free text            "exact phrase"            rfc:9110
section:7.4          keyword:MUST              status:std
stream:IETF          author:Fielding           relation:normative
term:MUST
```

- fields: `rfc`, `section`, `keyword`, `status`, `stream`, `author`, `relation`, `term`;
- ≤ 64 tokens, ≤ 2000 characters, ≤ 20 results per page (hard cap 200);
- free text becomes an AND of quoted FTS5 literals — the model never emits raw query syntax;
- a punctuated phrase (`"Idempotent-Methods"`) is expanded into its alphanumeric parts joined
  by AND, because the FTS tokenizer splits on `-`, `/` and `.`; an unpunctuated phrase keeps
  exact-phrase semantics;
- `scope: "auto"` searches the catalog first, then ingested text;
- `next_cursor` is bound to `(index_generation, scope, query, limit)` and fails with
  `INVALID_CURSOR` if reused with a different query or after a corpus change;
- a text hit is only returned when its snapshot still exists, so a `snapshot_id` in a result is
  always readable.

### Which scope applies which filter

`scope: "auto"` prefers the catalog and falls back to ingested text. The two indexes hold
different things, so some filters only mean something in one of them. Rather than dropping a
filter, the response says which ones the chosen scope could not apply:

| Filter                | Catalog scope                    | Text scope                    |
| --------------------- | -------------------------------- | ----------------------------- |
| free text, `"phrase"` | title, abstract, etc.            | block text                    |
| `rfc:`                | applied                          | applied                       |
| `status:`, `stream:`  | applied                          | `filters_not_applied_to_text` |
| `keyword:`, `term:`   | applied as a term                | applied as a term             |
| `author:`             | applied as a term                | applied as a term             |
| `section:`            | `filters_not_applied_to_catalog` | applied                       |
| `relation:`           | `filters_not_applied_to_catalog` | applied                       |

A query consisting only of catalog facets (`status:std stream:IETF`) has no text term. It is
answered from the catalog, and an explicit `scope: "text"` is reported as
`catalog_facets_only_scope_relaxed_to_catalog` rather than silently redirected.

`status:` and `stream:` accept either the slug (`std`) or the display name
(`internet standard`); they are matched against the catalog record, never against block text.

A recognised field with an empty value (`status:`) is rejected with `INVALID_ARGUMENT` instead of
being treated as the literal word, and `rfc:` / `section:` / `relation:` validate their value. A
token that merely contains a colon and is not a field name (`urn:example`) stays ordinary text.

`relation:` accepts `normative`, `informative` or `in_body` and rejects anything else with
`INVALID_ARGUMENT`. In a text search it restricts results to blocks that actually contain a
citation site of a reference with that relation, resolved through the normalised
`reference_citations` index — not inferred from the surrounding prose. So
`cache relation:normative` returns only blocks that cite a normative document, which is a
strictly smaller set than `cache` alone.

Note that `section:7.4` is a _query_ filter, while the argument that restricts a tool to a section
is `scope`. The two live in different namespaces: the first is part of `query`, the second is a
declared tool argument. Tool arguments are validated strictly — an unknown or misspelled key is
rejected with `INVALID_ARGUMENT`, and the message lists the accepted names. Nothing is ever
dropped silently, because a dropped filter would turn a scoped question into an unscoped answer
that still looks like a success. Each `batch` operation is validated against the schema of the
tool it names, with the same strictness.

## 9. Error codes

| Code                   | Retryable | Meaning                                                      |
| ---------------------- | --------- | ------------------------------------------------------------ |
| `INVALID_SELECTOR`     | no        | The selector is not a valid RFC reference                    |
| `INVALID_ARGUMENT`     | no        | Argument failed validation                                   |
| `INVALID_CURSOR`       | no        | Cursor malformed, tampered, or from another query/generation |
| `NOT_FOUND`            | no        | No such document, section, block, requirement or reference   |
| `NOT_CACHED`           | no        | Offline and the snapshot is not in the local corpus          |
| `AMBIGUOUS_VERSION`    | no        | More than one candidate for the requested identity           |
| `CORPUS_UNAVAILABLE`   | no        | Local corpus is missing or unusable                          |
| `UPSTREAM_UNAVAILABLE` | yes       | Primary source failed after bounded retries                  |
| `UPSTREAM_CONTRACT`    | no        | Response did not match the expected shape                    |
| `UPSTREAM_TOO_LARGE`   | no        | Response exceeded the size cap                               |
| `UPSTREAM_BLOCKED`     | no        | URL blocked by policy (host, scheme, offline)                |
| `RATE_LIMITED`         | yes       | Upstream returned 429                                        |
| `PARSE_FAILED`         | no        | Document could not be parsed                                 |
| `PARSE_DEGRADED`       | no        | Parsed with a known defect                                   |
| `SNAPSHOT_STALE`       | no        | Pinned snapshot no longer matches upstream                   |
| `CITATION_INVALID`     | no        | Citation could not be resolved                               |
| `LIMIT_EXCEEDED`       | no        | A hard limit was exceeded                                    |
| `CANCELLED`            | no        | The client cancelled the request                             |
| `INTERNAL`             | yes       | Unexpected failure (details redacted)                        |

Expected failures are returned as successful JSON-RPC results with `isError: true` and this
payload; protocol-level problems (unknown method, malformed JSON-RPC) are JSON-RPC errors.

```json
{
  "contract": "ietf-rfc/1",
  "status": "degraded",
  "error": { "code": "NOT_CACHED", "message": "…", "retryable": false, "details": { "rfc": 2119 } }
}
```

## 10. Hard limits

| Parameter                   | Default       | Ceiling                             |
| --------------------------- | ------------- | ----------------------------------- |
| Search results              | 20            | 200                                 |
| Output bytes                | 16 KiB        | 4 MiB (`read`), 2 MiB (inline text) |
| Quote                       | 1 200 chars   | 8 000                               |
| Context around match        | 240 chars     | 2 000                               |
| Batch operations            | 10            | 20                                  |
| Graph depth / nodes / edges | 1 / 100 / 200 | 3 / 200 / 500                       |
| Diff changes                | 50            | 500                                 |
| Query length                | 2 000 chars   | 4 000                               |
| Raw slice                   | 256 KiB       | 2 MiB                               |
| HTTP response               | 16 MiB        | 64 MiB                              |

Limits are never silently exceeded: a truncated result sets `limits.truncated`, returns
`next_cursor`, and says so in `warnings`.

## 11. Determinism and reproducibility

Given the same snapshot, index generation, parser and extractor versions, every tool returns
byte-identical output. Reproducibility inputs are always present in the envelope:

- `snapshot_id` and `raw_sha256`;
- `parser_version` and `extractor_version`;
- `index_generation`;
- `observed_at` and `source_urls`;
- the ordered `warnings` list.

## 12. Attribution and licensing

RFC text is reproduced unmodified from the RFC Editor with its copyright notice intact.
Errata are shown as a separate overlay and are never merged into publication text.
The server does not restate or paraphrase RFC prose; summaries produced by the host model are
the host's responsibility, and must keep citations attached.
