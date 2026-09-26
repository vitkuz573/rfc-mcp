# rfc-mcp

<!-- prettier-ignore -->
> **Evidence-first, strictly read-only Model Context Protocol server for the IETF RFC corpus.**
> Every analysis runs on an immutable, content-addressed snapshot; every derived fact carries a
> citation id that can be re-verified byte-for-byte against the published file.

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-5FA04E.svg)](https://nodejs.org)
[![protocol](https://img.shields.io/badge/MCP-2026--07--28%20%2B%20legacy-8A2BE2.svg)](https://modelcontextprotocol.io)
[![types](https://img.shields.io/badge/types-strict-informational.svg)](src)
[![tests](https://img.shields.io/badge/tests-89%20passing-success.svg)](tests)

|                  |                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **Tools**        | 15 read-only tools (`rfc_resolve`, `rfc_read`, `rfc_requirements`, `rfc_verify_citation`, …)       |
| **Resources**    | 10 snapshot-addressed `rfc://` templates                                                           |
| **Prompts**      | 6 reproducible workflows (`/rfc:brief`, `/rfc:requirements_audit`, …)                              |
| **Sources**      | [RFC Editor](https://www.rfc-editor.org/) + [IETF Datatracker](https://datatracker.ietf.org/) only |
| **Storage**      | SQLite (built-in) + FTS5, ~54 MB for 17 documents, 7 MB catalog index for all 9 842 RFCs           |
| **Dependencies** | one runtime dependency tree from the official SDK; no native modules                               |

---

## Why this exists

An LLM asked "what does RFC 9110 say about HEAD requests" must be able to answer with a quote it
can point at. Most tooling makes that impossible: it returns _something plausible_ that nobody can
verify. This server is built around the opposite idea:

```
Document → immutable snapshot → parsed structure → analysis → cited answer
```

- every analysis runs on a **content-addressed snapshot** (`snp_<hash>`), never on "whatever is
  current right now";
- every derived statement carries a **`citation_id`** that is re-checked against the raw bytes on
  demand (`rfc_verify_citation` → `verified | stale | ambiguous | not_found | integrity_failure`);
- every response is an **envelope** with `status`, `provenance`, `warnings` and hard `limits`;
- nothing is **inferred silently**: unresolved references, degraded parses, partial pages and
  offline misses are reported, never repaired or invented.

## Install

Requires **Node.js ≥ 24** (uses the built-in `node:sqlite` with FTS5 — no native builds).

```sh
git clone https://github.com/vitkuz573/rfc-mcp.git
cd rfc-mcp
npm ci
npm run build
```

## Quick start

```sh
# 1. Catalog: metadata for all 9 842 RFCs (one ~7 MB download)
node dist/cli.js sync index

# 2. Ingest documents you actually work with (parse + requirements + references)
node dist/cli.js sync rfc 2119 8174 9110 9000

# 3. Use it
node dist/cli.js outline 9110
node dist/cli.js requirements 9110 --scope 9.3.2 --term "MUST NOT"
node dist/cli.js search '"Idempotent"' --scope text
node dist/cli.js search 'cache relation:normative' --scope text   # only blocks citing a normative RFC
node dist/cli.js show 9110 --section 9.3.2
node dist/cli.js diff 7230 9110 --mode requirements
```

Or run the curated seed in one step: `./scripts/sync.sh` (catalog + 20 documents).

## Connect a host

### OpenCode

The repository ships a working `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "timeout": { "startup": 60000, "catalog": 60000, "execution": 600000 },
    "servers": {
      "rfc": {
        "type": "local",
        "command": ["node", "dist/index.js"],
        "cwd": ".",
        "disabled": false,
        "protocol": "auto",
      },
    },
  },
}
```

`protocol: "auto"` probes for MCP revision `2026-07-28` and falls back to the classic
`initialize` handshake; the same binary serves both.

**Restarting the server without restarting the host:** flip `disabled` in `opencode.jsonc`.
`true` detaches the server immediately, `false` spawns a fresh process, so a rebuilt `dist/` is
live in the current session. Confirm with `opencode mcp list` (expect `✓ rfc connected`) or
`/mcps` inside OpenCode.

### Any other MCP client

```sh
node dist/index.js                 # stdio transport
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "rfc": { "command": "node", "args": ["/abs/path/rfc-mcp/dist/index.js"] } } }
```

## The tool surface

With the server named `rfc`, hosts expose `rfc_<tool>`. All tools are `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: true` and carry an `outputSchema`.

| Tool                  | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `rfc_capabilities`    | Self-describing contract, limits, sources, policy                             |
| `rfc_resolve`         | selector → pinned `snapshot_id` (the only "current" resolution)               |
| `rfc_metadata`        | title, authors, status, stream, area, WG, DOI, relations                      |
| `rfc_read`            | one section, the full outline, an RFCXML outline, or a bounded raw byte slice |
| `rfc_search`          | catalog + full-text search; every filter reports whether it applied           |
| `rfc_requirements`    | RFC 2119/8174 statements with clause structure and citations                  |
| `rfc_references`      | normative/informative split, resolved targets, citation sites                 |
| `rfc_dependencies`    | bounded typed graph: cites, obsoletes, updates, inbound relations             |
| `rfc_diff`            | text / structure / requirements / metadata / references between two snapshots |
| `rfc_errata`          | errata overlay (never applied to publication text)                            |
| `rfc_history`         | Datatracker change feed                                                       |
| `rfc_source`          | official TXT/XML/HTML/PDF asset with SHA-256, ETag, canonical URLs            |
| `rfc_verify_citation` | re-verify a citation against the stored bytes                                 |
| `rfc_status`          | corpus health, index generation, versions, recent failures                    |
| `rfc_batch`           | ≤ 10 read-only operations, per-item status, generation pinned                 |

### Resources

```text
rfc://index/status
rfc://catalog/manifest
rfc://snapshot/{snapshot_id}/metadata | /provenance | /outline
rfc://snapshot/{snapshot_id}/sections/{section_id}
rfc://snapshot/{snapshot_id}/blocks/{block_id}
rfc://snapshot/{snapshot_id}/requirements/{requirement_id}
rfc://snapshot/{snapshot_id}/references/{reference_id}
rfc://snapshot/{snapshot_id}/citations/{citation_id}
```

### Prompts

`/rfc:brief`, `/rfc:requirements_audit`, `/rfc:compare`, `/rfc:dependency_review`,
`/rfc:citation_check`, `/rfc:offline_review` — reproducible workflows, each carrying the same
evidence discipline and the rule that RFC text is untrusted data.

## Response envelope

```json
{
  "contract": "ietf-rfc/1",
  "status": "ok",
  "data": { "…": "tool specific" },
  "provenance": {
    "corpus_id": "rfc-mcp:9a3591827422",
    "index_generation": 50,
    "parser_version": "rfc-text-1.2.0",
    "extractor_version": "normative-2119-8174-1.4.0",
    "observed_at": "2026-09-26T16:42:30.669Z",
    "source_urls": ["https://www.rfc-editor.org/rfc/rfc9110.txt"],
    "freshness": "current"
  },
  "warnings": [],
  "next_cursor": null,
  "limits": { "applied": { "max_results": 20 }, "truncated": false }
}
```

`status` describes the **operation**, never the RFC: `ok` complete, `partial` paginated or
budget-limited, `degraded` an assumption did not hold (stale cache, degraded parse, offline).

Full specification: [`docs/CONTRACT.md`](docs/CONTRACT.md). Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Evidence model

**Snapshots.** `snp_<hash>` is derived from
`(rfc, format, raw bytes, metadata hash, parser version, extractor version)`. Identical inputs
always produce the same id; changed bytes _or a bumped parser/extractor version_ produce a new
id and never mutate the old one. `rfc_resolve` is the only tool that turns "current" into a
snapshot — every other tool either receives an explicit `snapshot_id` or reports
`warnings: ["snapshot_not_explicitly_pinned"]`.

**Citations.** A citation id is `sha256(snapshot | block | byte offset | quote)`. Every section and
block reports offsets in three units — UTF-8 bytes, UTF-16 code units, Unicode code points — plus
line numbers, so a quote can be located in the raw file, the decoded text, or any Unicode-aware
tooling. The guarantee is exact: `rawBytes.slice(byte_start, byte_end)` reproduces `text`.

**Normative language (RFC 2119 / RFC 8174).**

- only the eleven keywords, upper case only (RFC 8174 §3);
- the longest phrase wins: `MUST NOT` is never split into `MUST` + `NOT`;
- strength (`absolute` / `recommendation` / `optional`) and polarity are derived, the original
  word is preserved;
- code, tables, figures, reference sections and quoted keyword definitions become **mentions**,
  never requirements;
- a sentence that merely _discusses_ the keywords ("the effects of not implementing a MUST or
  SHOULD…") is flagged `keyword_enumeration` and excluded;
- clause parsing is explicit — `condition`, `actor`, `action`, `exception`, `parse_status`,
  `confidence` — and a missing actor yields `partial` with `actor_not_explicit`, never a
  fabricated one.

**References and dependencies.** Reference sections become labelled entries with resolved targets
(`RFC` / `BCP` / `STD` / `FYI`) and a relation (`normative`, `informative`); in-body citations are
attached with exact offsets. A normative reference is **not** automatically a dependency: the
graph keeps `cites_normative` and metadata relations separate, never emits `inferred` edges, and
leaves unresolved labels unresolved.

**Errata are an overlay.** The RFC Editor does not incorporate them into the published
TXT/PDF/XML, and neither does this server. `rfc_errata` shows them with section, original and
corrected text, and says so explicitly.

## Parsing

`rfc-text-1.2.0` parses the RFC Editor plain-text publication version (RFC 9920 §5), which exists
for **every** RFC:

- column-1 headings, with the table of contents used as an authority when present;
- appendices, references, authors, index and status sections classified separately;
- page furniture (`[Page 7]`, `[RFC2119]`, form feeds) and the ToC removed from content — and a
  page break _inside_ a paragraph splits the block, so a sentence is always contiguous in the file;
- paragraph / list / preformatted / table / reference-entry classification;
- exact offsets for every section and block, including BOM-prefixed and multi-byte content.

Ambiguity is never hidden. RFC 2119-style documents that use column-1 numbered _content_ keep it
as exact blocks, emit `col0_numbered_items_rejected:N` and mark the parse `degraded`, instead of
inventing sections.

`rfc_read(target="xml_outline")` exposes the authoritative RFCXML tree (RFC 7991 v3 / RFC 7749
v2) with anchors, per-section normative terms and the targets of every `<xref>`. Section numbers
are recovered from the v3 page name (`section-appendix.a` → `Appendix A`), and the two
representations of a document never disagree: for RFC 9110 all 293 section numbers shared by the
plain-text and XML outlines carry the same kind in both. RFCXML is read by a hardened parser:
DTDs and entity declarations are rejected, XInclude is never resolved, and depth/node/text budgets
are enforced.

## Policy

| Concern          | Behaviour                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Network          | HTTPS only, host allowlist (`www.rfc-editor.org`, `errata.rfc-editor.org`, `datatracker.ietf.org`); no user-supplied URL ever reaches `fetch` |
| HTTP             | ETag/If-None-Match revalidation, bounded size/time/concurrency, retry with backoff, stale-on-error with an explicit warning                   |
| Integrity        | Snapshot content hash verified before every citation check                                                                                    |
| XML              | No DTD, no entities, no XInclude, bounded depth/nodes/text                                                                                    |
| Prompt injection | RFC text is data; the server never treats it as instructions                                                                                  |
| Privacy          | Author email addresses stripped at the source boundary; no document text in logs                                                              |
| Licensing        | RFC text reproduced unmodified with attribution (IETF Trust TLP)                                                                              |
| Mutation         | No model-visible write tool; corpus maintenance is CLI-only                                                                                   |
| Logs             | JSON lines on stderr, secrets and document text redacted                                                                                      |

## Configuration

| Variable                   | Default                                                     | Meaning                                                |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `RFC_MCP_DATA_DIR`         | `~/.local/share/rfc-mcp`                                    | Corpus location (`corpus.sqlite`, WAL)                 |
| `RFC_MCP_OFFLINE`          | `0`                                                         | No network at all; cached snapshots only               |
| `RFC_MCP_USER_AGENT`       | `rfc-mcp/<version> (+https://github.com/vitkuz573/rfc-mcp)` | HTTP User-Agent                                        |
| `RFC_MCP_HTTP_TIMEOUT_MS`  | `15000`                                                     | Per-request timeout                                    |
| `RFC_MCP_INDEX_TIMEOUT_MS` | `180000`                                                    | Timeout for the ~7 MB catalog index                    |
| `RFC_MCP_MAX_HTTP_BYTES`   | `16777216`                                                  | Response size cap                                      |
| `RFC_MCP_MAX_CONCURRENCY`  | `4`                                                         | Per-host concurrency                                   |
| `RFC_MCP_METADATA_TTL_MS`  | `21600000`                                                  | Metadata cache freshness window                        |
| `RFC_MCP_NEGATIVE_TTL_MS`  | `3600000`                                                   | 404 cache window                                       |
| `RFC_MCP_LOG_LEVEL`        | `info`                                                      | `debug`…`silent`                                       |
| `RFC_MCP_CURSOR_SECRET`    | derived                                                     | HMAC key binding opaque cursors to a corpus generation |

## Operator CLI

```sh
rfc-mcp sync index                  # catalog refresh
rfc-mcp sync rfc 2119 8174          # ingest documents
rfc-mcp sync all --limit 500        # bulk ingest
rfc-mcp status                      # corpus health
rfc-mcp outline 9110                # section tree
rfc-mcp requirements 9110 --term "MUST NOT"
rfc-mcp references 9110 --relation normative
rfc-mcp search '"Idempotent"' --scope text
rfc-mcp show 9110 --section 9.3.2
rfc-mcp verify cit_…                # exit code 2 when not verified
rfc-mcp diff 7230 9110 --mode requirements
rfc-mcp reanalyze 9110 2119         # re-derive analysis offline after a rules change
rfc-mcp reindex                     # rebuild FTS5 from stored blocks
rfc-mcp vacuum                      # purge stale search-index rows, compact the database
```

## Development

```sh
npm ci
npm run typecheck     # tsc --noEmit, strict
npm test              # 89 tests: parser, normative, XML, store, HTTP policy, service, live protocol
npm run build         # dist/
npm run verify        # format check + typecheck + test + build
```

The suite includes a black-box protocol test that spawns `dist/index.js` and speaks raw JSON-RPC
on stdio, covering both the legacy `initialize` handshake and the modern `server/discover`
revision, tool/prompt/resource listing, error codes and stdout hygiene.

## Roadmap

- internet-draft revisions and Datatracker history as first-class snapshots;
- signed, reproducible corpus bundles;
- IANA registries as a separate allow-listed layer;
- calibrated confidence for clause extraction on labelled data;
- JSON-LD / SARIF export of citation bundles.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

The code is licensed under [Apache-2.0](LICENSE).

RFC content retrieved by this software is **not** covered by that license. It is reproduced
unmodified from the RFC Editor and remains subject to the IETF Trust's Legal Provisions
([TLP](https://trustee.ietf.org/documents/trust-legal-provisions/tlp-5/)); errata are an
independent overlay and are never merged into publication text. See
[docs/LICENSING.md](docs/LICENSING.md) for how the two are kept separate.
