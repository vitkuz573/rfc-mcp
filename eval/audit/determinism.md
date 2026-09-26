# Determinism audit — `rfc-mcp` (MCP server over the IETF RFC corpus)

Adversarial audit of the mandate: _a normative contract derived from an RFC must be
reproducible — if a caller re-runs the same query against the same pinned snapshot and gets
different bytes, nothing they were told is trustworthy._

**Verdict.** The server is deterministic in the narrow sense that matters most: for a fixed
query against a fixed pinned snapshot, the response bytes reproduce exactly — same process,
two processes, different machine-ish environments, different page sizes, interleaved with
other calls. I could not break it. But the determinism is **accidental in three places**
(undocumented orders, one non-total `ORDER BY`, one environment-derived provenance field),
one **derived field is demonstrably wrong** because of the order, and the **artefact under
test is not the source** — the shipped build and the declared contract version disagree
today.

Read F1 first. It bounds every other claim in this document.

---

## 0. Artefact under test, and a precondition failure

|                       | shipped `dist/`                         | `src/`                                                                                 | `contract-versions.json`        |
| --------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| built / mtime         | **12:31:37**, not rebuilt since         | 13:28 – **14:20:32**, still moving                                                     | 13:25:01                        |
| server version        | `0.6.0` (read live from `package.json`) | `0.6.0`                                                                                | `0.6.0`                         |
| parser version        | `rfc-text-1.7.3`                        | `rfc-text-1.7.3`                                                                       | `rfc-text-1.7.3`                |
| **extractor version** | **`normative-2119-8174-1.6.3`**         | `normative-2119-8174-**1.7.0**`                                                        | `normative-2119-8174-**1.7.0**` |
| schema version        | **7** (`dist/store/schema.js:15`)       | **8** (`src/store/schema.ts:44`)                                                       | —                               |
| on-disk corpus        | `meta.schema_migration_version = 7`     | migration 8 adds `stable_citation_id` to `requirements` + `mentions` — **not applied** | —                               |

`dist` is at extractor `1.6.3`; the declared contract is `1.7.0`. A snapshot id is
`snp_<sha256(rfc N | txt | rawSha256 | metadataHash | parserVersion | extractorVersion)>`
(`src/service/rfcService.ts:700-702`), so **all 159 snapshot ids in the corpus were minted
under `1.6.3` and every one of them is already inconsistent with the version the package
declares.** The next build retires every pinned `snp_` in existence. The mechanism is
documented and intentional; the _state_ is not self-consistent.

Concretely observable: no `requirements` row in the shipped build carries a
`stable_citation_id` (row keys are `id, snapshot_id, rfc, section_id, block_id, term,
strength, polarity, keywords, exact_text, span, context, disposition, flags, citation_id,
clause, parse_status, confidence, section`), and the `requirements`/`mentions` tables in the
corpus have no such column. `src` mints one in three places (`citation.ts:82-92`,
`database.ts:1905-1914`, `rfcService.ts:1465-1469`).

**Everything I measured below describes the 12:31 build.** Where the source has since
changed behaviour in a determinism-relevant way, I say so (F8).

Read-only discipline: I ran the server against a **copy** of the corpus
(`/tmp/opencode/audit-determinism/data`, byte-identical at copy time), never `sync`,
`reanalyze`, `reindex` or `vacuum`, never built, never committed. I verified
`index_generation` stayed `1953` across every read session and that the copy's SHA-256 was
unchanged by reads. One write was observed and is noted in F12.

---

## 1. Same query, same process, twice — and across two processes

**PASS.** Byte-for-byte, ignoring nothing.

**Harness.** `eval/lib/mcp.mjs` over stdio against `dist/index.js`, `RFC_MCP_OFFLINE=1`.

| run | documents | args                                                                                                                 | compared         | identical                  |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------- |
| A   | 30        | `{rfc, include_candidates, include_mentions}` (default page)                                                         | 10 623 229 B     | 30/30, **0 diffs**         |
| A   | same 30   | third call after an interleaved `requirements` on a _different_ RFC                                                  | 10 623 229 B     | 30/30, **0 diffs**         |
| B   | 56        | `{rfc, max_results: 200, candidates, mentions, provisional}` ×2                                                      | 20 717 485 B     | 56/56, **0 diffs**         |
| C   | 25        | same as B, two calls each                                                                                            | 18 873 637 B     | 25/25, **0 diffs**         |
| C   | —         | one call, then 4 other `requirements` calls with different `role`/`shape`/`max_candidates`, then the same call again | —                | identical                  |
| D   | 56        | **two separate node processes**                                                                                      | canonical digest | `dcd39d51…d380aeb` in both |

Strongest single artefact: the full RFC 8446 response at `max_results=200` is 1 186 174
bytes; the two process dumps are `cmp`-identical.

**No field differed. Not one.** Specifically checked and _stable_:

```
provenance.corpus_id            "rfc-mcp:2de318147f58"   ==  ==   (constant for a data dir)
provenance.index_generation     1953                     ==  ==   (never moves on a read)
provenance.parser_version       rfc-text-1.7.3           ==  ==
provenance.extractor_version    normative-...-1.6.3      ==  ==
provenance.observed_at          2026-09-26T02:35:18.093Z ==  ==   (snapshot.retrieved_at, stored)
provenance.source_urls          [rfc8446.txt]           ==  ==
provenance.freshness            offline                 ==  ==
next_cursor                     …45f0e74f9aec4fa5       ==  ==   (byte-stable: stableJson sorts keys)
limits                          {"applied":{"max_results":200},"truncated":false} == ==
warnings                        8 strings, same order    ==  ==
data.requirements[0..n]         full rows incl. id, span, clause, keywords, flags == ==
data.mentions[0..n]             same                     ==  ==
data.non_strict_candidates      165 rows + by_* counters, same key order == ==
```

The documented hazard of a stateful global regex (`TERM_PATTERN` with `g`, `normative.ts:56-80`)
does **not** leak: I called `requirements` on 25 documents twice each with other
`requirements` calls interleaved, and the bytes were unchanged. `matchTerms` resets
`lastIndex`, and `TERM_PROBE` / `CANDIDATE_TERM_PROBE` are non-global clones
(`normative.ts:74`, `1660`).

---

## 2. Ordering

**PARTIAL.** One order is documented and correct. Four are undocumented, one of which is not
a total order, and one of them is load-bearing for content that the response describes.

### 2a. `non_strict_candidates.candidates` — documented, and the order is a total order

Documented: `ordering: "ranked: shape=demand first, then role=modal, then upper-case
keywords, then document order"`. The rank function is `rfcService.ts:1592-1597`; the sort is
`[...analysis.candidates].sort((a,b) => candidateRank(b) - candidateRank(a) || a.char_start - b.char_start)`
(`rfcService.ts:1428-1430`).

Verified on 13 documents (8446, 9000, 9110, 3261, 2119, 1035, 4033, 5321, 1122, 2865, 7230,
7540, 4035):

- the documented rule holds on every row of every document, with every `role`/`shape` filter
  (`{}`, `role=modal`, `shape=demand`, `role=modal&shape=demand`, `role=unknown`,
  `shape=indeterminate`) — `documentedOrderHolds=true` in all 78 combinations;
- `(rank, char_start)` is **unique** in all 13 documents → the comparator is a total order;
- **the order does not depend on the input order**: I reversed the response array and
  re-sorted by the documented key; the id sequence came back byte-identical
  (`fromShuffle=true`, 13/13). So the output is a pure function of the data, not of the
  traversal. Good.

### 2b. `requirements` — total in practice, **undocumented**

`ORDER BY char_start, id` (`src/store/database.ts:1084`). Measured over the whole corpus:
`(snapshot_id, char_start)` has **0** colliding pairs in `requirements`, so the `, id`
tiebreak never fires — but the response carries **no `ordering` field** and nothing anywhere
says "document order". Same for `mentions` (`ORDER BY char_start`, `database.ts:1143`),
which also has **0** `(snapshot_id, char_start)` collisions, and whose input is already
sorted (`char_start` order == rowid/insertion order for 100% of rows), so the TEMP B-TREE
sort cannot reorder it. Both are total orders **on today's data**, established by measurement,
not by contract. → **F5**

### 2c. The candidate pass's _input_ order is neither documented nor a total order — and it decides content

This is the substantive ordering finding.

`src/parse/text.ts:266`:

```ts
const blockOrdinal = rawBlocks.filter((block) => block.sectionId === region.id).length;
```

`blocks.ordinal` is a **per-section running counter**, reset for every section. It is not a
document counter. `src/store/database.ts:1186-1198` then feeds the candidate pass with
`SELECT * FROM blocks WHERE snapshot_id = ? AND (lower(text) LIKE '%must%' …) ORDER BY ordinal LIMIT 5000`
— so **all** ordinal-0 blocks of **all** sections come first, then all ordinal-1 blocks, and
so on.

Measured, RFC 768 (`snp_592e83eafa9d9e60cc0269c7`), the four keyword-bearing blocks in the
order the query actually returns them:

```
ORDER BY ordinal  →  ord 1 @char 1762, ord 1 @3785, ord 1 @4390, ord 2 @662
document order    →             ord 2 @662, ord 1 @1762, ord 1 @3785, ord 1 @4390
```

The block that is first in the document is read **last**. Corpus-wide: **155 of 159**
snapshots have keyword-pass order ≠ document order; there are **3 864** duplicate
`(snapshot_id, ordinal)` pairs.

And the SQL `ORDER BY ordinal` is **not a total order** — those 3 864 ties are resolved by a
TEMP B-TREE (plan: `SEARCH blocks USING INDEX sqlite_autoindex_blocks_1 (snapshot_id=?) |
USE TEMP B-TREE FOR ORDER BY`) fed in `blocks` primary-key order, which is
`(snapshot_id, id)` and `id` is `blk_<sha256(snapshotId|regionId|blockOrdinal|start)>` —
i.e. **hash order**. So the block sequence the candidate analysis walks is, within each
ordinal bucket, hash order. Stable today. Guaranteed by nothing: no `sqlite_stat1` /
`sqlite_stat4` exists (no `ANALYZE` has ever run), so a single `ANALYZE` or `VACUUM` may
change the plan.

What depends on this order:

- the `max_candidates` cut-off (`normative.ts:1377-1380`) takes the first N in this order, so
  **which** candidates survive truncation is decided by a per-section-ordinal interleave.
  RFC 768, sweeping `max_candidates` 5→2000: the sets are nested and stable, and the
  `char_start` sequence is `[970, 3802, 4406, 1780]` — the last one is _out of document
  order_ because its rank is higher, which is documented; but the _set_ is not a
  document-order prefix, and that is not.
- the sentence-fragment state machine (`normative.ts:1374`, `1495`) carries
  `previousEndedOpen` across this order. → **F4**
- `MAX_CANDIDATES = 500` (`normative.ts:187`); `listBlocksWithKeywords` has a hard
  `LIMIT 5000` — currently unreachable (max blocks in any snapshot is 2 078) but it is a
  silent, unwarned, undocumented cap.

→ **F3**

### 2d. The `by_*` counters: undocumented key order, and they disagree with each other

`by_keyword`, `by_keyword_case`, `by_reason`, `by_role`, `by_shape` are plain objects built
by first-appearance insertion (`normative.ts:1487-1493`). `by_section` is built by walking
the **ranked** candidate array (`rfcService.ts:1436-1440`). None is sorted; none is
documented. RFC 8446, `by_section` key order as emitted:

```
["1","2","5","11","1.1","4.2.9","Copyright Notice","2.3","3.4","3.5","3.6","3.7","3.8",
 "4.1.1",… "Appendix A"…"Appendix E","3.2","5.3"]
```

Not document order, not sorted, not stable under any rule a reader could infer. Identical
across processes (I checked), and that is exactly the problem: an undocumented order that
happens to be stable is a defect, because the next refactor of `candidateRank` or of the
SQL changes it silently.

Worse, the counters describe **different populations on the same page**. RFC 8446 with
`role=modal`: `returned` 165→…, `by_role`/`by_shape` are recomputed on the filtered set
(`rfcService.ts:1441-1446`), while `by_keyword`/`by_keyword_case`/`by_reason` are copied
straight off the unfiltered analysis (`rfcService.ts:1489-1494`). So `by_role` and
`by_keyword` on one page are counting different things, and the page does not say so.
→ **F6**

---

## 3. Environment sensitivity

**PASS, with one real exception.** 13 environments × 22 probes, plus 3 node CLI flag
variants. Machine: Node v26.7.0, SQLite 3.53.4, 159 snapshots / 125 with requirements,
`index_generation 1953`.

| variation                                                                              | `requirements` bytes | other tools                             | what actually moved                          |
| -------------------------------------------------------------------------------------- | -------------------- | --------------------------------------- | -------------------------------------------- |
| `TZ=UTC` → `Asia/Kolkata` (+05:30)                                                     | **identical**        | `status`/`caps`/`search`/`batch` differ | `provenance.observed_at` only                |
| `TZ=UTC` → `Pacific/Chatham` (+12:45)                                                  | **identical**        | same                                    | `observed_at` only                           |
| `LC_ALL=tr_TR.UTF-8` + generated locale                                                | **identical**        | same                                    | `observed_at` only                           |
| `LC_ALL=ru_RU.UTF-8`                                                                   | **identical**        | same                                    | `observed_at` only                           |
| cwd `/home/vitaly/rfc-mcp` → `/tmp` → `/`                                              | **identical**        | same                                    | `observed_at` only                           |
| `TMPDIR` changed                                                                       | **identical**        | same                                    | `observed_at` only                           |
| `XDG_DATA_HOME` changed (overridden by `RFC_MCP_DATA_DIR`)                             | **identical**        | same                                    | `observed_at` only                           |
| `RFC_MCP_MAX_CONCURRENCY=1` vs `16`, `UV_THREADPOOL_SIZE=1` vs `16`                    | **identical**        | same                                    | `observed_at` only                           |
| `RFC_MCP_LOG_LEVEL=debug`                                                              | **identical**        | same                                    | `observed_at` only                           |
| `node --predictable` (single-threaded, deterministic scheduling)                       | **identical**        | same                                    | `observed_at` only                           |
| `node --single-threaded`                                                               | **identical**        | same                                    | `observed_at` only                           |
| `node --random-seed=42`                                                                | **identical**        | same                                    | `observed_at` only                           |
| **`RFC_MCP_DATA_DIR` → a different path holding a byte-identical `cp` of the same DB** | **DIFFERS**          | **DIFFERS**                             | `provenance.corpus_id` **and `next_cursor`** |

Field-level diff, `TZ=UTC` vs `Asia/Kolkata`, all six probes:

```
status          diffs=1   $.provenance.observed_at  "…09:33:04.896Z"  vs  "…09:35:06.417Z"
caps            diffs=1   $.provenance.observed_at
search (text)   diffs=1   $.provenance.observed_at
batch           diffs=1   $.provenance.observed_at
search (catalog)diffs=1   $.provenance.observed_at
requirements    diffs=0
```

### 3a. `provenance.corpus_id` is a hash of the database file path — **F2**

```ts
corpus_id: `rfc-mcp:${shortHash(this.store.path, 12)}`; // rfcService.ts:350, 2452; resources.ts:70
```

Clean experiment: a plain `cp` of the corpus DB to a second directory, so the two databases
are byte-identical and only the **path** differs.

```
data/corpus.sqlite   (213 090 304 B)  →  corpus_id = rfc-mcp:2de318147f58
data2/corpus.sqlite  (213 090 304 B, byte-identical)  →  corpus_id = rfc-mcp:bdce7bd553d4

$ deepDiff(requirements@data, requirements@data2)
  diffs = 2
    $.provenance.corpus_id   "rfc-mcp:2de318147f58"  vs  "rfc-mcp:bdce7bd553d4"
    $.next_cursor            "eyJiIjoiMTk1M3xyZXF8…9aec4fa5"  vs  "eyJiIjoiMTk1M3xyZXF8…9aec4fa5"
  (identical: data.snapshot_id, every row, observed_at, index_generation, the version triple)

$ deepDiff(status@data, status@data2)      → 3 diffs: data.corpus_id, provenance.corpus_id, observed_at
$ deepDiff(capabilities@data, @data2)      → 2 diffs: provenance.corpus_id, observed_at
$ deepDiff(search@data, @data2)            → 3 diffs: next_cursor, corpus_id, observed_at
```

So the one field whose job is "which corpus answered this" is a hash of where the file
lives. That makes it (a) different on every machine and (b) not a content identity at all:
two corpora with identical bytes at different paths get different ids, and one corpus copied
to a new path gets a new id while all 159 of its `snp_` ids stay the same.

The asymmetry is what makes this a gap rather than a nit. `snp_` ids are content-addressed
(`rfcService.ts:700-702`) and therefore portable — I measured `snp_c7010bf3314696ec764ccbd4`
returning from both directories, with byte-identical rows. `corpus_id` is path-addressed and
therefore not. The pinned artefact travels; the thing that is supposed to tell you which
corpus you are talking about does not.

**And `next_cursor` is path-derived too.** The cursor MAC is
`sha256(cursorSecret + "\n" + body)`, and on a DB with no `cursor_secret` in `meta` the
secret falls back to `shortHash(store.path | productName | version)`
(`rfcService.ts:513-517`). So a cursor is valid only on the machine that minted it. Replayed
on the second directory it is rejected with `INVALID_CURSOR: Cursor failed integrity check` —
the same message a **tampered** cursor gets (I verified both: a cursor with three characters
changed and a cursor from a different path are indistinguishable to the caller). A cursor
rejected because the reader is on a different machine is reported as an integrity failure. → **F2**

### 3b. Locale: is `/…/iu` under a Turkish locale a real risk? **No, and here is the proof**

I generated a real `tr_TR.UTF-8` locale (`localedef -i tr_TR -f UTF-8`, with `LOCPATH`) and
ran the server under `LC_ALL=tr_TR.UTF-8`. Zero byte difference in `requirements`. Two
independent reasons, both measured:

1. **The API is not locale-sensitive.** Under `LC_ALL=tr_TR.UTF-8`
   (`Intl.DateTimeFormat().resolvedOptions().locale === "tr-TR"`):

   ```
   /must/iu.test("MUST")            → true
   /\bmust not\b/iu.test("must not") → true
   "I".toLowerCase()                 → "i"          (not "ı")
   "MUST NOT".toLowerCase()          → "must not"
   "I".toLocaleLowerCase("tr")       → "ı"          ← the API IS sensitive
   "i".toLocaleUpperCase("tr")       → "İ"          ← so is this one
   ["i","I","ı","İ"].sort()          → ["I","i","İ","ı"]   (UTF-16 code-unit order)
   ["i","I","ı","İ"].sort(tr collator)→ ["ı","I","i","İ"]  (collation order)
   ```

   ECMA-262 `Canonicalize` (the `i` flag) and `String.prototype.toLowerCase/UpperCase` are
   both specified as Unicode **Default** Case Conversion, which is locale-independent by
   definition. `toLocaleLowerCase` / `Intl.Collator` are the locale-sensitive ones, and the
   codebase uses neither: `rg "localeCompare|toLocaleLowerCase|toLocaleUpperCase|Intl\.|COLLATE|NOCASE" src/` → **no matches**.

2. **Even a locale-sensitive fold would be harmless here.** The only letter Turkish breaks
   is `I`/`i`, and the RFC 2119 vocabulary contains no `i` at all — `MUST`, `MUST NOT`,
   `REQUIRED`, `SHALL`, `SHALL NOT`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`,
   `RECOMMENDED NOT`, `MAY`, `OPTIONAL` (`src/core/types.ts` `NORMATIVE_TERMS`). The
   `iu` regexes that _do_ contain an `i` (`META_DISCUSSION`, `DEFINITION_SECTIONS`,
   `CROSS_REFERENCE_ONLY`, the `is|are`-based shape tests) all feed on ASCII literals, and
   the tokeniser immediately re-filters through an explicit ASCII class —
   `trimmed.toLowerCase().match(/[A-Za-z']+/gu)` (`normative.ts:819`, `886`, `930`). A
   non-ASCII `İ` would be dropped by that class, which is a _coverage_ question for Turkish
   RFCs, not a determinism one.

**SQLite** agrees: `PRAGMA collation_list` = `RTRIM, NOCASE, BINARY` only, no custom
collation; `compile_options` has no `SQLITE_LOCALE`/`ICU`; no column is declared
`COLLATE NOCASE`; built-in `lower()` is ASCII-only. Every `ORDER BY` therefore uses BINARY
(UTF-8 byte order), which `LC_COLLATE` cannot move. **A `LC_COLLATE`-dependent sort cannot
change any ordering in this server.**

### 3c. Timezone / clock

`new Date()` appears only in `isoNow()` (`core/util.ts:35-37`) and in the HTTP cache TTL
arithmetic (`upstream/http.ts:108, 135, 149`). Neither reaches a derived row. The one place
a clock reaches a response is `provenance.observed_at` when there is no snapshot anchor
(`rfcService.ts:348`: `options.observedAt ?? snapshot?.retrieved_at ?? isoNow()`), and
`date` **rendering** never happens — every timestamp is `Date#toISOString()`, which is UTC
and locale-independent by spec. **A timezone cannot change any derived byte.** → **F9**

### 3d. Parallelism / CPU count

`mapWithConcurrency` (`core/util.ts:221-237`) pre-allocates `results = new Array(items.length)`
and writes `results[index]`, so completion order cannot interleave into the result. The read
path is synchronous `node:sqlite`. `Math.random` appears exactly once in the whole tree —
`upstream/http.ts:386`, retry jitter on a network fetch, never reached offline. Confirmed
empirically: `--predictable`, `--single-threaded`, `--random-seed=42`,
`RFC_MCP_MAX_CONCURRENCY` 1/16 and `UV_THREADPOOL_SIZE` 1/16 all give identical bytes.

### 3e. Hash-map iteration reaching a response

Grepped and checked: `Map`/`Set` are used for _lookup_ (`sectionNumbers`, `sectionsById`,
`kinds`, `scopeIds`) and are never iterated into a response; where a `Map` is iterated
(`database.ts:1033` catalog hash) the result is a sorted-`by`-key array. The counter objects
that _do_ reach a response are plain objects, so their key order is insertion order, not
hash order — see F6.

### 3f. Node version

**Untestable** — only `v26.7.0` is installed. This matters: a Node upgrade can change
`String.prototype.toLowerCase` behaviour for the ~2 % of code points where Unicode
CaseFolding and Default Case Conversion disagree, and V8 `Array#sort` is only _specified_
stable from ES2019 (so the stability the candidate order depends on is a guarantee, not an
implementation detail — that one is fine). I flag the residual risk rather than claim it.

---

## 4. Idempotence of derivation

**Cannot test directly (read-only: no re-derive). Audited by reading.** What I can state:

**No time, no randomness, no counter, no autoincrement in the derivation path.**

- `Date.now()` / `new Date()` in the write path: none. `isoNow()` appears in
  `database.ts:185` (`failures.at` — an operational log, not derived data), `:382`
  (`snapshot_redirects.created_at`), `:1431`/`:1501` (`relations`/`errata` evidence and
  `updated_at`, both live network observations, not derivations), `rfcService.ts:2714`/`:2843`
  (`last_catalog_sync`). `snapshots.retrieved_at` _is_ a timestamp and _is_ stored — it is the
  fetch time, deliberately excluded from the snapshot id (`rfcService.ts:692-702`) and used as
  `observed_at` for every snapshot-anchored response, which is exactly why it is stable.
- `Math.random` / `randomUUID`: absent from `src/` except `http.ts:386` (retry jitter).
- **Autoincrement:** one table, `failures` (`schema.ts:498`,
  `id INTEGER PRIMARY KEY AUTOINCREMENT`). It reaches a response through
  `recentFailures` — and that query is `ORDER BY at DESC LIMIT ?` (`database.ts:191`) with
  **no tiebreak**, while the supporting index is `failures_by_at (at DESC)` (schema:504).
  Two failures logged in the same millisecond have no defined order. The table is **empty**
  (0 rows), so this is latent and untestable here. → **F11**
- **Insertion order into the response:** the write path iterates `bundle.sections`,
  `bundle.blocks`, `bundle.mentions`, `bundle.requirements`, `bundle.references` in parser
  order and writes nothing order-derived back; reads use `ORDER BY ordinal` (sections,
  blocks) and `ORDER BY char_start[, id]` (mentions, requirements). `ordinal` is parsed
  document order for sections (0 collisions) and **per-section** for blocks (3 864
  collisions) — see F3.
- **A `LIMIT` in a write path that could truncate silently:** `listBlocksWithKeywords`
  `LIMIT 5000`, `getMentions(…, 500)`, `MAX_CANDIDATES 500`, `MAX_DECLARATIVE_SPECIFICATIONS 200`.
  The first and second are **unreported** — see F7.

**Structurally, the store gets this right in the places that are hardest.** `contentHash` /
`stableJson` sort object keys before hashing (`util.ts:16-33`), so every content-addressed id
is independent of property insertion order. `stableCitationIdsFor` is index-aligned with its
input array and hashes only `(rfc, section number, quote)` — no offsets, no block ids — so
those ids are by construction stable across a re-parse. `mapWithConcurrency` writes by index.
`stableJson` is also why `next_cursor` is byte-stable (my strongest evidence that no hidden
state accumulates).

**One identity hazard I could not measure** (F10 in the table): `stableCitationId` takes an
`occurrence` argument and **nothing ever passes it** — not `database.ts:1905-1914`, not
`rfcService.ts:1465-1469`. Two rows in the same section with byte-identical `exact_text`
therefore mint the **same** id, and the field's own doc comment (`citation.ts:74-80`) says the
occurrence index exists precisely to keep those apart. Unmeasurable on the shipped build
because the column is not in the corpus schema; in `src` it is present in all three call
sites.

---

## 5. Response stability across page boundaries

**PASS on the strict list, with two real defects around it.**

### 5a. Concatenating pages == the same sequence, for every page size

RFC 9000 (520), 8446 (427), 3261 (995), 1812 (555), 1122 (271), 4035 (144) × page sizes
`200, 100, 50, 25, 7, 3, 1` — 36 configurations, 1 000+ `tools/call`s.

```
strict rows collected        == total_requirements            (all 36, all 6 documents)
strict row SEQUENCE (ids)    == the max_results=200 sequence  (all 36)
strict rows BYTE-FOR-BYTE    == the max_results=200 rows      (all 36)
```

A row's identity does not depend on the page size it was fetched with: `max_results` ∈
{1,3,7,20,50,199,200}, the first row of each is byte-identical to `max_results=200`'s first
row, and each prefix equals the corresponding prefix of the 200 page — `id`, `span`
(all eight offsets), `section`, `parse_status`, `confidence`, `citation_id`, `exact_text`,
`clause`, `flags`, `keywords` all equal.

Cursors are correctly bound: a cursor minted at `max_results=50` is **rejected** at
`max_results=25` with `INVALID_CURSOR: Cursor belongs to a different query or corpus
generation`; a tampered cursor is rejected with `Cursor failed integrity check`. The binding
string (`rfcService.ts:1319`) includes the generation, the snapshot id, `scope`, `term`,
`keyword` **and** `limit`, so a cursor cannot be replayed against a different query, a
different corpus generation, or a different page size. `next_cursor` bytes were stable across
repeats.

### 5b. DEFECT — the shipped build re-ships candidates and provisional rows on every page

RFC 9000, `max_results=200`, 3 pages:

```
non_strict_candidates.candidates.length per page  = [44, 44, 44]
coverage.provisional_returned          per page  = [44, 44, 44]
concatenated provisional rows                    = 132
distinct provisional ids                         = 44
DUPLICATE ROWS                                   = 88
```

RFC 8446: 495 rows / 165 distinct. RFC 1812: 1 128 rows / 376 distinct. The duplicate count
is a **function of how many pages you asked for**, and it scales linearly: a caller who
pages a document into a compliance list gets every provisional row once per page, with no
marker distinguishing the copies. `omitted_on_page` does not exist in the shipped build.

The current `src` fixes this — `page = Math.floor(offset / limit) + 1` and rows on page 1
only (`rfcService.ts:1478-1531`) — but the fix _moves_ the problem: the presence of
`non_strict_candidates.candidates` and of the provisional rows now depends on `offset` and
`limit`, i.e. on the page size. "The `requirements` response for RFC N" stops being one
document and becomes one document _per page size_. → **F8**

### 5c. DEFECT — `mentions` is silently capped at 500

`getMentions(snapshot.id, 500)` (`rfcService.ts:1389`) — a hard-coded literal in the call, no
schema, no field, no warning.

```
RFC 9000  →  500 rows, at the cap, limits.truncated=false, limits.applied={max_results:1}, no warning
RFC 3261  →  500 rows, at the cap, same
RFC 8446  →  478 rows, under the cap
```

There is no count field anywhere in `data` (`scope,hits,total,corpus` for search; for
requirements: `document, snapshot_id, requirements, coverage, interpretation, mentions,
keyword_usage, non_strict_candidates`). A caller recording "RFC 3261 has 500 mentions" has
recorded a constant from the source, not a fact about the document — in a response that
otherwise goes out of its way to report loss (`coverage.keyword_bearing_blocks_skipped`,
`unscanned_note`, `max_results_clamped:*`, `candidates_truncated_at_*`). → **F7**

---

## 6. Pinned vs unpinned

**PASS.** This is the cleanest result in the audit.

```ts
const res     = await call("resolve",     { rfc: 9000 });   // res.data.snapshot.id
const unpinned= await call("requirements",{ rfc: 9000, max_results: 200, candidates, mentions, provisional });
const pinned  = await call("requirements",{ rfc: 9000, snapshot_id: "snp_c7010bf3314696ec764ccbd4", … });
```

`deepDiff(unpinned, pinned)` on the full envelope, RFC 9000 / 8446 / 2119 / 1035:

```
diffs = 1   { path: "$.warnings.length", a: 6, b: 5 }
```

The one difference is the extra `snapshot_not_explicitly_pinned` warning
(`rfcService.ts:1340`) on the unpinned call. Everything else is byte-identical:

|                                                                                        |                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `data.requirements[0..n]` (id, span, clause, keywords, flags, citation_id, exact_text) | **identical**                                                                                 |
| `data.mentions[0..n]`                                                                  | **identical**                                                                                 |
| `data.non_strict_candidates` (165 rows + all counters + key order)                     | **identical**                                                                                 |
| `data.coverage`                                                                        | **identical**                                                                                 |
| `provenance.observed_at`                                                               | **identical** — both are `snapshot.retrieved_at` (`2026-09-26T02:35:18.093Z`), not `isoNow()` |
| `provenance.index_generation`                                                          | **identical** (1953)                                                                          |
| `provenance.parser_version` / `extractor_version` / `source_urls`                      | **identical**                                                                                 |
| `provenance.corpus_id`                                                                 | **identical**                                                                                 |
| `data.snapshot_id`                                                                     | **identical** — `rfc: 9000` and `snapshot_id:` both resolve to `snp_c7010bf3314696ec764ccbd4` |

Nothing that _should_ differ, differs; the one thing that differs, is the thing that _should_.
`provenance.observed_at` is stable across the pinned/unpinned boundary precisely because it is
the stored `retrieved_at` and not the call time — which is the right design and the reason a
`resolve` → `requirements` → `verify_citation` chain is reproducible today.

---

## Findings

| #       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Test | Result                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                               | Severity                                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | The shipped build derives at extractor `1.6.3` while the package declares `1.7.0`; `dist` is at schema v7, `src` at v8, `src` is still being edited. All 159 snapshot ids on disk were minted under the undeclared triple.                                                                                                                                                                                                                                                                                  | 4    | **not deterministic as a contract**                      | `contract-versions.json` extractor `1.7.0`; `dist/core/config.js` → `1.6.3`; `dist/store/schema.js:15` (v7) vs `src/store/schema.ts:44` (v8); DB `meta.schema_migration_version=7`; `requirements` rows carry no `stable_citation_id` although `src` mints one in 3 places; id formula `src/service/rfcService.ts:700-702`                                             | **critical** — a pinned `snp_` cannot be resolved against the declared contract, so a re-derive is not reproducible. It is a _state_ defect, not a code nondeterminism, and the mechanism is by design and documented                                       |
| **F3**  | The candidate pass reads blocks in **per-section ordinal** order, not document order. `blocks.ordinal` is a per-section counter (`parse/text.ts:266`); `listBlocksWithKeywords` orders by it (`database.ts:1186-1198`). 155/159 snapshots affected; 3 864 duplicate `(snapshot_id, ordinal)` pairs; the `ORDER BY` is **not a total order** and the within-bucket order is `blocks` PK = **hash** order. `max_candidates` truncation and the `continues_previous_block` state machine both read through it. | 2, 4 | **order is undocumented and not total**                  | RFC 768: query returns `1@1762, 1@3785, 1@4390, 2@662`; document order is `2@662, 1@1762, 1@3785, 1@4390`. Plan: `USE TEMP B-TREE FOR ORDER BY` over `sqlite_autoindex_blocks_1`. `MAX_CANDIDATES=500` (`normative.ts:187`); `LIMIT 5000` unwarned                                                                                                                     | **critical** — the _content_ of a derived, quotable list depends on an order that is neither documented nor guaranteed; the next `ANALYZE`/refactor changes which candidates exist                                                                          |
| **F4**  | `non_strict_candidates.fragments[].continues_from_block` is derived from the previous block **in ordinal order**, i.e. usually a block in a _different section_, while the note asserts "The first half is in an earlier block of the same section."                                                                                                                                                                                                                                                        | 2    | **derived field is wrong** (deterministic but incorrect) | 9 fragments observed (8446, 1122 ×2, 4035, 2865, 1123 ×2, 5280 ×2). **8 of 9 name a block that is not the document-preceding block**; 6 of those 8 are in a different section, up to ~100 000 chars away. Example RFC 8446 §3.7 @46537 → `blk_49e3528acd3336d7aa49b99c`; the real predecessor is `sec_cc6ee96d031331221ce5d8ce` @46419. `normative.ts:1374, 1495`      | **high** — a caller who follows the note reads the wrong text, and the flag it gates (`sentence_fragments`, `fragments[]`) is what keeps half-sentences out of a compliance list                                                                            |
| **F2**  | `provenance.corpus_id = "rfc-mcp:" + sha256(store.path).slice(0,12)` — a hash of the SQLite file's absolute path — and `next_cursor` is MAC'd with a secret that also falls back to a hash of that path. Both move when the data directory moves, even with byte-identical content.                                                                                                                                                                                                                         | 3    | **machine-dependent bytes in every response**            | `rfcService.ts:350, 2452, 513-517`; `resources.ts:70`. Clean test (a plain `cp`): `corpus_id` `2de318147f58` → `bdce7bd553d4`, `next_cursor` differs, while `snapshot_id`, all rows and `observed_at` are identical. A cursor from one path replayed on the other: `INVALID_CURSOR: Cursor failed integrity check` — the same message a genuinely tampered cursor gets | **high** — the field whose job is "which corpus answered" is neither portable nor a content identity, and a cross-machine cursor reads as tampering. Derived rows are unaffected                                                                            |
| **F5**  | `requirements` (`ORDER BY char_start, id`) and `mentions` (`ORDER BY char_start`) orders are **undocumented** — no `ordering` field on the response, unlike `non_strict_candidates`.                                                                                                                                                                                                                                                                                                                        | 2    | **undocumented order, total in practice**                | `database.ts:1084, 1143`. Both keys measured unique corpus-wide (0 collisions of `(snapshot_id, char_start)` in either table); mentions input is already sorted (`char_start` order == rowid order for 100% of rows), so the TEMP B-TREE cannot reorder. `requirements` carries no `ordering` key at all                                                               | **high** — stable today by measurement, not by contract; an added partial index or a second mention at one offset silently reorders a compliance list                                                                                                       |
| **F6**  | The `by_section` / `by_keyword` / `by_keyword_case` / `by_reason` / `by_role` / `by_shape` counters have **undocumented key order** (insertion order; `by_section` follows the _rank_ order, the rest follow document order), and they describe **different populations on the same page**.                                                                                                                                                                                                                 | 2    | **undocumented, and internally inconsistent**            | `rfcService.ts:1436-1446` vs `normative.ts:1487-1493`; `rfcService.ts:1489-1494` copies `by_keyword`/`by_reason`/`by_keyword_case` unfiltered while `by_role`/`by_shape` are recomputed on the filtered set. RFC 8446 `by_section` key order: `["1","2","5","11","1.1","4.2.9","Copyright Notice","2.3",…]` — neither document nor sorted order                        | **high**                                                                                                                                                                                                                                                    |
| **F7**  | `mentions` is hard-capped at 500 in SQL with no truncation marker of any kind.                                                                                                                                                                                                                                                                                                                                                                                                                              | 5    | **silent truncation**                                    | `rfcService.ts:1389` `getMentions(snapshot.id, 500)`. RFC 9000 and RFC 3261 both return exactly 500; `limits.truncated=false`, `limits.applied={max_results:…}`, no warning, no count field in `data`                                                                                                                                                                  | **high** — a recorded count is an artefact of a constant, in a response that otherwise reports every other loss                                                                                                                                             |
| **F8**  | The shipped build re-ships the full candidate list **and** all provisional rows on **every** page, so concatenating pages yields each row once per page. `src` fixes the duplication by making the rows' _presence_ a function of `offset` and `limit`.                                                                                                                                                                                                                                                     | 5    | **row identity depends on page size**                    | RFC 9000 `@200`: `candidates.length=[44,44,44]`, `provisional_returned=[44,44,44]`, 132 concatenated vs 44 distinct = **88 duplicates**. RFC 8446 495/165, RFC 1812 1 128/376. `dist/service/rfcService.js:1069,1099-1104` has no `omitted_on_page`; `src/service/rfcService.ts:1478-1531` computes `page = floor(offset/limit)+1`                                     | **high** — either way "the response for RFC N" is not one document. Also: `include_provisional: true` is **silently ignored** when `include_candidates: false` (measured: 244 rows/44 provisional vs 200 rows/0 provisional, no warning)                    |
| **F10** | `search.hits[].score` is `bm25(blocks_fts)` over the whole FTS index, so it changes when any other document is ingested. The `ORDER BY score, f.rfc, f.block_id` is a total order, so the _ranking_ is reproducible for a fixed corpus — the _number_ is not, and nothing says so.                                                                                                                                                                                                                          | 3    | deterministic per corpus, corpus-state dependent         | `database.ts:1035, 1038`; hit keys: `document_id, rfc, title, snapshot_id, section_id, section_path, block_id, match_field, snippet, highlight_spans, citation_id, score`                                                                                                                                                                                              | **medium**                                                                                                                                                                                                                                                  |
| **F9**  | `provenance.observed_at` is `isoNow()` for every tool with no snapshot anchor: `status`, `capabilities`, `search` (both scopes), `batch`.                                                                                                                                                                                                                                                                                                                                                                   | 3    | **cosmetic**                                             | `rfcService.ts:348`. `status.observed_at` `…09:33:04.896Z` vs `…09:35:06.417Z` for the same call; `search` envelope differs on every repeat while `search.data` is byte-identical                                                                                                                                                                                      | **cosmetic** — as anticipated, it changes no derived row, id, span or count. Worth noting only because `search` is the tool a caller is most likely to cache the whole envelope of, and a naive byte-diff of two search answers always reports a difference |
| **F11** | `failures` is the only autoincrement table and reaches a response through `recentFailures`, which is `ORDER BY at DESC` with **no tiebreak** on a millisecond timestamp.                                                                                                                                                                                                                                                                                                                                    | 4    | **latent, untestable**                                   | `schema.ts:498, 504`; `database.ts:189-195`. Table is empty (0 rows)                                                                                                                                                                                                                                                                                                   | **low** — two failures logged in the same millisecond would come back in an arbitrary order                                                                                                                                                                 |
| **F12** | Every tool is annotated `readOnlyHint: true`, but the store opens SQLite **read-write** and a `PRAGMA journal_mode = WAL` database checkpoints and removes `-wal`/`-shm` on close. Observed once, on the copy, on a read-only session.                                                                                                                                                                                                                                                                      | 4    | side observation                                         | `database.ts:92-94` (`new DatabaseSync(path)` with no `{readOnly:true}`). On the settled copy, subsequent read sessions changed no file and left `index_generation` at 1953                                                                                                                                                                                            | **low** — not a determinism issue; the claim `readOnlyHint: true` is about the tool's effect on the corpus, which does hold                                                                                                                                 |
| **F13** | `stableCitationId` takes an `occurrence` argument and **no call site passes it** (3 of 3 in `src`). Two rows in one section with identical `exact_text` mint the same id, which is exactly what the field's own doc comment says the parameter exists to prevent.                                                                                                                                                                                                                                           | 4    | **untestable read-only**                                 | `citation.ts:74-80, 82-92`; `database.ts:1905-1914`; `rfcService.ts:1465-1469`. The column does not exist in the shipped corpus schema (F1), so no response carries the field to measure                                                                                                                                                                               | **low / watch**                                                                                                                                                                                                                                             |

## A note on the corpus I measured against, and on concurrent modification

I worked from a **copy** of the corpus taken at 13:07 (`index_generation = 1953`,
213 090 304 B), and every measurement in this document is against that frozen copy. Two
things you should know before reading the numbers:

- **The repository and the real corpus were being modified by another session while I
  audited.** `src/analysis/normative.ts` mtime 13:28, `src/store/database.ts` 14:15,
  `src/service/rfcService.ts` 14:20 — still moving at the time of writing. The real corpus
  grew 213 MB → 238 MB at **13:39:57** and its `index_generation` moved 1953 → 1981, which
  is a `sync` I did not run. `package.json` moved 0.5.3 → 0.6.0 at 13:25, mid-audit. F1 is
  the direct consequence.
- I opened the **real** data directory twice by accident, both times with a read-only
  intent: `node dist/cli.js status --json` at ~13:09, and one probe at ~15:00 whose
  `process.env` assignment landed after the child was already spawned. Neither ran
  `sync`/`reanalyze`/`reindex`/`vacuum`; the store opens SQLite read-write, so the observable
  effect is a WAL checkpoint. The first `datadir_real` row in the environment matrix was
  contaminated by this and has been **replaced** by the clean two-identical-copies
  experiment in 3a; the reported `index_generation` in every result below is the copy's 1953.

## What I could not test

- **Re-derive idempotence** (test 4's core): `reanalyze` is forbidden and the corpus is
  read-only. Audited by reading `src/store/database.ts` + `src/store/schema.ts` only. Every
  conclusion in F3/F11/F13 about the derivation is a reading of the code plus a measurement
  of its _output_, not of a second derivation.
- **A second Node version** (test 3): only v26.7.0 present. Residual risk from Unicode
  case-folding table changes and from V8 string internals.
- **`LC_COLLATE` actually set to a non-C locale** (test 3): no such locale is generated on
  this host. Established by construction instead — no custom collation registered, no
  `COLLATE` clause anywhere in `src/`, no `SQLITE_LOCALE`/`ICU` compile option, so every
  `ORDER BY` is BINARY.
- **A fresh corpus with no `cursor_secret` in `meta`**: the fallback secret is
  `shortHash(store.path | productName | version)` (`rfcService.ts:513-517`), so a _new_
  machine's cursors are keyed by its own path. I did produce the effect (F2: a cursor from
  one path is rejected on another), but not the genuinely-fresh-DB case, which needs a
  write. Arguably correct — the secret is an integrity key against tampering, not a
  portability token — so I report it as part of F2, not as a separate finding.
- **The `src` behaviour** for anything the shipped build does not implement (F8's `page ===
1` logic, `stable_citation_id`, schema v8). I was instructed not to build, so the source's
  determinism is unverified — and given F1 it cannot be verified against this corpus anyway,
  since a build would mint 159 new snapshot ids.

## Reproducing

```bash
cp ~/.local/share/rfc-mcp/corpus.sqlite{,-wal,-shm} /tmp/audit/data/
cp /tmp/audit/data/corpus.sqlite /tmp/audit/data2/          # for the F2 path test
export RFC_MCP_DATA_DIR=/tmp/audit/data RFC_MCP_OFFLINE=1
node /tmp/opencode/audit-determinism/tfinal.mjs                    # test 1
node /tmp/opencode/audit-determinism/t1b_cross_process.mjs p1      # test 1, cross-process
node /tmp/opencode/audit-determinism/t2t5t6.mjs                    # tests 2, 5, 6
node /tmp/opencode/audit-determinism/t5_paging.mjs                 # test 5
node /tmp/opencode/audit-determinism/t3_env.mjs base               # test 3
RFC_MCP_DATA_DIR=/tmp/audit/data2 node …/t3c_fielddiff.mjs datadir2 # test 3, F2
node /tmp/opencode/audit-determinism/dbprobe{,2,3,4}.mjs           # test 4, read-only SQL
```

## What I would want fixed before believing any of this by contract rather than by

## measurement

Not fixes — just the list of claims in this document that are currently true by accident and
would stop being true on the next refactor, ordered by how much would break:

1. `blocks.ordinal` semantics (per-section vs per-document) and the `ORDER BY` in
   `listBlocksWithKeywords` (F3, F4) — this one is already producing wrong output.
2. `non_strict_candidates.fragments[].continues_from_block` (F4) — wrong in 8 of 9 measured
   cases, with a note that asserts the opposite.
3. `mentions`' 500-row cap (F7) and `include_provisional` being ignored under
   `include_candidates: false` (F8) — both are silent, and the codebase's own comments
   elsewhere name silent truncation as "a wrong answer, not a small one".
4. Documentation of the `requirements` and `mentions` orders and of the six `by_*` key
   orders (F5, F6), and reconciling `by_role`/`by_shape` with
   `by_keyword`/`by_keyword_case`/`by_reason` (F6).
5. Deciding what `corpus_id` and `next_cursor` are _for_ (F2), and reporting a
   cross-machine cursor as what it is rather than as an integrity failure.
6. Getting the build, the declared contract version and the corpus on the same triple (F1),
   because until then "the same pinned snapshot" is not a claim the server can check.

Nothing under `/home/vitaly/rfc-mcp` was modified except the single file this report lives
in: no source edits, no commits, no build, no `sync`/`reanalyze`/`reindex`/`vacuum`, no writes
to the real corpus. The read-only discipline is described in the note above.
