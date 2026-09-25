# Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  MCP host (OpenCode)  —  stdio, protocol 2026-07-28 with legacy fallback │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ JSON-RPC (tools, resources, prompts)
┌───────────────────────────────────▼──────────────────────────────────────┐
│  mcp/                                                                     │
│   server.ts    assembly, instructions, dual-era stdio entry               │
│   tools.ts     15 read-only tools, zod input/output schemas, annotations  │
│   resources.ts snapshot-addressed rfc:// resources                        │
│   prompts.ts   6 reproducible workflows                                   │
└───────────────────────────────────┬──────────────────────────────────────┘
┌───────────────────────────────────▼──────────────────────────────────────┐
│  service/rfcService.ts   envelopes, provenance, snapshot policy, batching │
│   query.ts                bounded search grammar + safe FTS5 expressions  │
└───────┬──────────────────────────────────────────────────────┬───────────┘
        │                                                      │
┌───────▼──────────────┐                        ┌──────────────▼────────────┐
│ parse/               │                        │ upstream/                 │
│  text.ts  RFC text   │                        │  http.ts     allowlist,   │
│  rfcXml.ts outline   │                        │              ETag, limits │
│  xml.ts    hardened  │                        │  sources.ts  RFC Editor,  │
│                      │                        │              Datatracker  │
├──────────────────────┤                        └───────────────────────────┘
│ analysis/            │
│  normative.ts RFC 2119/8174                                    store/
│  references.ts labels, targets, edges                           database.ts
│  diff.ts      text/structure/requirements/...                   schema.ts
│  citation.ts  deterministic ids                                (SQLite + FTS5)
```

## Layers and invariants

| Layer       | Invariant                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `mcp/`      | No business logic. Every tool is read-only, bounded, cancellable, annotated.                     |
| `service/`  | `resolve` is the only place that turns "current" into a snapshot. Every response is an envelope. |
| `upstream/` | HTTPS + host allowlist only. No user-supplied URL ever reaches `fetch`.                          |
| `parse/`    | Byte-exact offsets. Ambiguity becomes a warning, never a silent fix.                             |
| `analysis/` | Every derived fact carries a citation id. Nothing is inferred silently.                          |
| `store/`    | One transaction per document. Content-addressed snapshots are immutable.                         |

## Snapshot lifecycle

```
rfc: 9110
  │
  ├─ rfc-common/9110.json ─────────────► metadata (authors, status, DOI, relations)
  ├─ rfc9110.json          (fallback) ─► merged metadata
  ├─ doc/rfc9110/doc.json (fallback) ─► group, std level
  │
  └─ rfc9110.txt ──────────────────────► raw bytes
                                          │  sha256
                                          ▼
                                   raw_sha256 + metadata_hash
                                          │  snp_<24 hex>
                                          ▼
                            ┌──────────────────────────────┐
                            │ parse  → sections, blocks   │
                            │ analyze → mentions,         │
                            │           requirements,     │
                            │           references        │
                            │ commit  → one transaction   │
                            └──────────────────────────────┘
                                          │
      read / search / requirements / references / dependencies / diff
```

Re-running ingest with identical bytes is a no-op: the same `snp_` id is found, only
`retrieved_at` is refreshed. Changed bytes produce a new snapshot; the old one stays
readable, and its citations stop verifying against the new bytes.

## Data model (SQLite)

| Table                      | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `catalog`                  | Metadata for every known RFC (searchable via `catalog_fts`)   |
| `snapshots`                | Immutable, content-addressed document snapshots + raw bytes   |
| `assets`                   | Additional official files (XML/HTML/PDF) pinned to a snapshot |
| `sections`, `blocks`       | Parsed structure with exact offsets                           |
| `blocks_fts`               | FTS5 index over block text (rebuildable)                      |
| `mentions`, `requirements` | RFC 2119/8174 analysis with clause structure                  |
| `rfc_references`           | Reference entries, resolution state and citation sites        |
| `relations`                | Observed document relations (metadata + Datatracker)          |
| `errata`, `history`        | Overlays and operational history                              |
| `source_cache`             | Conditional HTTP cache (ETag/Last-Modified, negative cache)   |
| `meta`, `failures`         | Index generation, cursor secret, sync timestamps, error log   |

`index_generation` increments on every write. Cursors embed it, so a paginated walk across a
mutating corpus fails loudly with `INVALID_CURSOR` instead of silently skipping rows.

## Failure policy

| Situation                                                    | Result                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Expected failure (bad selector, missing section, not cached) | tool result with `isError: true` and a stable code                                            |
| Upstream 5xx/429                                             | bounded retry with backoff, then `stale_cache_served_after_upstream_failure` if a copy exists |
| Upstream unreachable, no cache                               | `UPSTREAM_UNAVAILABLE` with retryable flag                                                    |
| Parse produced no body sections                              | `quality: "degraded"` + `no_body_sections_detected`                                           |
| Column-1 numbered content mistaken for headings              | `col0_numbered_items_rejected:N`, exact blocks kept, quality degraded                         |
| Corrupt snapshot bytes                                       | `integrity_failure` from `rfc_verify_citation`                                                |
| Batch item failure                                           | isolated per item; `complete: false`, other results preserved                                 |

## Security model

- **No arbitrary egress.** URL builders are the only way to reach the network; the client
  rejects anything outside the three allowlisted hosts and anything that is not HTTPS.
- **No XML attack surface.** DTD and entity declarations are rejected outright; XInclude is
  never resolved; depth, node and text budgets are enforced.
- **No prompt injection path.** RFC text is returned as data with an explicit preamble in the
  server instructions and in every prompt.
- **No privacy leak.** Author email addresses are dropped at the source adapter boundary;
  document text never appears in logs (redaction in `logger.sanitize`).
- **No model-visible writes.** Corpus maintenance is CLI-only.

## Testing strategy

| Layer     | Test                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Parser    | `tests/text-parser.test.ts` — section tree, exact round-trip offsets, determinism, RFC 2119 ambiguity                                    |
| Normative | `tests/normative.test.ts` — all 11 keywords, longest-match, case sensitivity, code exclusion, clause parsing, stable citations           |
| XML       | `tests/xml.test.ts` — DTD rejection, entity non-expansion, depth limits, offsets, outline                                                |
| HTTP      | `tests/http.test.ts` — allowlist, ETag revalidation, retry, stale-on-error, size cap, cancellation                                       |
| Service   | `tests/service.test.ts` — end-to-end over a fake upstream: resolve/read/search/requirements/references/errata/diff/batch/offline/privacy |
| Protocol  | `tests/protocol.test.ts` — spawns `dist/index.js` and speaks raw JSON-RPC for both protocol eras                                         |
