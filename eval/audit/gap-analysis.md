# Gap analysis: is `rfc-mcp` the most complete RFC tool?

Adversarial audit. Read-only: no source was edited, nothing was built, no sync/ingest/reanalyze
was run, and the database was never written to directly. The only artefact of this session is
this file. Tool-mediated lazy caching is noted where it happened (§8, finding L6) because the
server's own read path writes on a cache miss.

## What was measured, and against what

| item                | value                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| corpus              | `~/.local/share/rfc-mcp/corpus.sqlite`, `corpus_id rfc-mcp:9a3591827422`                                                                                                                                                                                               |
| server / derivation | `0.5.3`, parser `rfc-text-1.7.3`, extractor `normative-2119-8174-1.6.3` (`contract-versions.json`)                                                                                                                                                                     |
| shipped artifact    | `dist/` built 2026-09-26 12:31:37 +0500 (= commit `a48fa2c`)                                                                                                                                                                                                           |
| working tree        | **dirty** — `src/analysis/citation.ts`, `normative.ts`, `rfcService.ts`, `store/*`, `tests/*` all modified and **not** in `dist/`. This matters twice below (findings L2, M2).                                                                                         |
| DB measurements     | read-only copy of `corpus.sqlite` + WAL at `index_generation 1960`, **166 snapshots**. A concurrent session was ingesting throughout; the live corpus moved 159 → 181 during this audit. Every number below is stated at 166 documents unless the text says otherwise. |
| live tool calls     | `rfc_status`, `rfc_capabilities`, `rfc_requirements`, `rfc_read`, `rfc_errata`, `rfc_metadata`, `rfc_dependencies`, `rfc_diff`, `rfc_search`, `rfc_history`, `rfc.batch`                                                                                               |

The corpus is a moving target. Ratios are given per-document where the denominator moved.

---

## 0. The yardstick

The project states its own purpose three times and the three statements agree. `README.md`:
_"An LLM asked 'what does RFC 9110 say about HEAD requests' must be able to answer with a quote
it can point at. Most tooling makes that impossible: it returns something plausible that nobody
can verify."_ `eval/README.md`: _"a measurement instrument for the scenario this server exists to
serve: RFC → normative compliance contract → code."_ `CHANGELOG.md` "Not changed, and why":
_"Text search covers ingested documents only. Ingesting all 9842 is a storage and freshness policy
decision, not a code fix."_ Stated in my own words, that is the yardstick for everything below:

> This server exists to convert RFC text into a **normative compliance contract an engineer can
> implement against**, in which **every emitted row is traceable to the exact bytes it came from
> and can be re-verified on demand**, in which **an absence is always distinguishable from a
> thing that was not built**, and in which **the derivation is reproducible** — the same bytes
> under the same rule versions always yield the same rows, and a different rule version produces
> a new, separately named derivation rather than silently mutating the old one. The interesting
> claim is not "it reads RFCs". It is that the _epistemics_ are sound: the tool never hands you a
> plausible sentence it cannot point at, and never lets you mistake the edge of its own
> competence for the edge of the document.

Against that yardstick, the last two clauses are the ones that are genuinely strong, and the
first two are where the distance is largest. Note that the yardstick does **not** say "cover every
RFC" — the project explicitly defers that. But a tool that answers "what does the RFC corpus
say" is implicitly making a claim about the corpus, and 1.7% of it is a thin claim.

---

## 1. The corpus itself

### 1.1 What is covered, and what is not

| layer                                 | coverage                 | measured                                                                                                                         |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| catalog metadata + relations          | **9 842 / 9 842 (100%)** | 5 184 relation facts (`obsoletes`/`obsoleted_by`/`updates`/`updated_by`); `status_json` non-null for all 9 842                   |
| catalog `abstract`                    | **153 / 9 842 (1.6%)**   | `sum(abstract is null) = 9 689`. The mini-index carries no abstract; a document gains one only when it is individually resolved. |
| catalog `pages`                       | **153 / 9 842 (1.6%)**   | `sum(pages is null) = 9 689` — the same rows.                                                                                    |
| catalog `group`                       | **153 / 9 842 (1.6%)**   | `sum(group_json is null) = 9 689`.                                                                                               |
| document text (sections, blocks, FTS) | **166 / 9 842 (1.69%)**  | 8 517 sections, 57 027 blocks, 15 415 328 B of TXT                                                                               |
| requirement rows                      | 166 documents            | 10 966 rows; 140 documents have ≥1 (live count at generation 1979)                                                               |
| errata                                | **9 / 9 842 (0.09%)**    | 116 rows, all in RFCs 1034, 1035, 1123, 2181, 2308, 5246, 6891, 9000, 9110                                                       |
| datatracker change history            | 3 / 166                  | 38 rows (5246, 9110, 7871)                                                                                                       |
| `relations` table                     | **0 rows**               | never populated; the dependency graph is computed from the catalog, not from this table                                          |

**The asymmetry is the finding.** Metadata, relations and the supersession graph are genuinely
corpus-wide. Text and normative extraction are 1.7%. So the tool can answer "what obsoleted
RFC 2616" for all 9 842 documents and "what does RFC 2616 require" for none of them — the
document is not even in the corpus, and `rfc_errata(2616)` would be the only way to learn that.

### 1.2 Ingestion surface

**A full sync is possible and is a CLI verb.** `sync all` iterates `allCatalogNumbers()`; `--limit N`
takes the **first N by RFC number**, not a stratified or prioritised set. So there is no way to
bulk-sync "the 500 documents that matter" except by naming them.

**Incremental: yes, by idempotence.** `ensureSnapshot` (`rfcService.ts:424-439`) returns the stored
snapshot unless `refresh: true`, and `commitDocument` (`database.ts:480`) wraps the whole write in
one `this.transaction(...)`. Re-running `sync all` skips what is cached.

**Resumable: yes, as a consequence of the two above.** A network failure mid-document leaves no
partial row, the failure is recorded in the `failures` table with a code and message
(`ingestMany`, `rfcService.ts:2745-2772`), the loop continues, and the next run retries the
document. `failures` is currently empty (0 rows at generation 1979).

**Per-document cost, measured, then extrapolated:**

| cost             | measured on the 166 ingested documents                                                                                                                 | full corpus (9 842)                                   | error on the extrapolation                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP calls       | **2.02/doc** (169 `rfc-common` + 166 `pub-txt` in `source_cache`; 371 entries total)                                                                   | **≈ 4/doc** → ~39 000 calls                           | the 2.02 is _optimistic_: it holds only because these 166 documents' `abstract`/`group` were already in the catalog. `ensureSnapshot` (`rfcService.ts:460-475`) falls back to `api/v1/documents/<n>.json` when `abstract === null` and to the datatracker `doc.json` when `group === null` — which is the case for 9 689 of 9 842 un-ingested documents. So the real figure is 4 calls/doc (rfc-common, documents.json, doc.json, .txt), +1 with `with_xml`. |
| bytes downloaded | 92 864 B/doc mean, 56 648 B median                                                                                                                     | **558 MB – 914 MB** of TXT                            | ±25%, dominated by the unknown full-corpus mean length. Sample skew factor 1.64 (mean/median). The 166 are stratified over the corpus by `eval/lib/labelling.mjs`, so not adversarially biased, but n=166.                                                                                                                                                                                                                                                   |
| derived disk     | **10.7× – 12.6× the raw text** (165.5 MB derived for 15.4 MB of text over 166 docs, excluding the duplicated `source_cache` copy; 194 MB including it) | **≈ 6 GB – 11.5 GB**, ≈ 12 GB counting `source_cache` | near-linear: every derived table and the FTS5 index scale with text size, so the ratio transfers better than the mean does.                                                                                                                                                                                                                                                                                                                                  |
| wall clock       | **0.39 s/doc** in the fastest observed batch (43 docs, 16 s span, concurrency 4); 4.4 s/doc and 27.9 s/doc in two others                               | **≈ 1 h – 76 h**                                      | the spread is rfc-editor.org latency and stalls, not this tool. The tool's own CPU cost is negligible: `rfc_requirements` on the largest document (RFC 3261, 2 078 blocks) returns in **279 ms** with candidates and **98 ms** strict-only, timed through `tools.rfc.*`.                                                                                                                                                                                     |

So: a full corpus is **6–11.5 GB of SQLite and 1–76 hours**, roughly 40 000 HTTP calls across two
hosts. That is affordable on a workstation and awkward in a container image, which is exactly the
trade-off the CHANGELOG names. It is a policy decision, correctly identified as one. But it is
_the_ decision that makes the tool not the most complete, and it has not been taken.

**One real efficiency defect:** `source_cache` holds a second complete copy of every document's raw
bytes (36.7 MB of 204 MB at 166 documents, growing linearly) and is never pruned. `vacuum` exists
but the cache has no TTL sweep in the ingest path beyond the HTTP freshness window.

### 1.3 Built and wrong: the catalog search is silently empty

The catalog FTS5 index covers `title, abstract, keywords, authors, status, stream`. For 98.4% of
the corpus the `abstract` column is `NULL`, so the searchable content is title + keywords +
authors + status + stream. Measured:

```
rfc_search(query='"Mutual Authentication"', scope="catalog", max_results=3)  → 0 results
rfc_search(query='hypertext transfer protocol',  scope="catalog", max_results=3) → 0 results
```

Zero hits, across 9 842 catalogued documents, for a phrase that appears in the abstract of RFC 9110
and dozens of others. The response reports `corpus.coverage: "catalog_titles_and_abstracts"`, which
is false for 9 689 of 9 842 rows.

Two further faults in the same function (`rfcService.ts`, catalog branch of `search`, ~L1055-1080):

- every catalog hit is hard-coded `match_field: "title"`, even when the FTS5 match was in the
  abstract. A caller that uses `match_field` to decide whether a hit is authoritative is told the
  wrong field.
- a zero-hit catalog result pushes `no_catalog_match`, which is honest. A _non-zero_ result carries
  no coverage warning, so a caller cannot distinguish a well-searched 9 842-document catalog from
  a title-only one.

Both are fixable from a different source. The datatracker's `doc/document/` endpoint filters on
`abstract__icontains` for every document; `rfc-index.txt`/`.xml` carry abstracts corpus-wide; the
competitor `mjpitz/mcp-rfc` gets better recall by scraping the RFC Editor's HTML search — which
this project explicitly refuses to do, correctly, but then does not replace the lost capability.

---

## 2. Versions of a document

### 2.1 The corpus holds exactly one version of every document, ever

```
select rfc, count(*) c from snapshots group by rfc having c > 1;   -- returns nothing
```

**166 snapshots for 166 documents.** Not one RFC has a second snapshot. `snapshot_redirects` holds
1 422 rows, and every one of them is a rule-version bump, not a document change —
`rfcService.ts:626` says so in the error text: `reason: "rule_version_changed"`, _"the document
bytes are unchanged unless raw_sha256 differs."_

Consequence, stated plainly: **a caller can reconstruct only what is true now.** There is no
historical byte, no `retrieved_at` series, no `published` history, and no way to ask what RFC 9110
§6.5.1 said on 2022-06-06 as opposed to today. A compliance contract is very often _about_ a
version — "we ship HTTP/1.1, which is RFC 7230, which was current from 2014 to 2022" — and for
that contract the tool has exactly one usable state per document: the latest.

This is a design property, not an oversight, and the CHANGELOG is honest that internet-draft
revisions and Datatracker history are not first-class snapshots. But it is the second-largest gap
after coverage, and it interacts badly with errata (§3) and with diff (§2.3).

### 2.2 What is corpus-wide and good

The supersession graph is real and complete. 5 184 relation facts over all 9 842 catalog entries;
1 384 documents are obsoleted by something, 1 242 are updated by something.
`rfc_dependencies(rfc=9110, direction="both", depth=3)` returns 40+ resolved document nodes and
correctly self-reports its own limits:

```
warnings: ["inbound_relations_truncated_at_486",
           "unresolved_reference_labels:9",
           "snapshot_not_explicitly_pinned"]
```

The distinction the README claims is real: a normative citation is _not_ promoted to a dependency
edge, no `inferred` edges are ever emitted, unresolved labels stay unresolved. That is the correct
modelling and it is rare. `trentmilam/agentic-rag` does the same thing as a deterministic
`SupersessionModule` over 9 794 RFCs, with a `current_only` guard so obsoleted text is
_structurally_ excluded from retrieval; rfc-mcp has no equivalent guard, because with one snapshot
per document there is no superseded text to exclude.

**Defect:** `capabilities.limits.maxGraphDepth` is `1`, the input schema accepts `1..3`, and
`depth: 3` works. The self-describing contract understates the tool on the one dimension where the
tool is strongest.

### 2.3 `rfc_diff` cannot do the one thing a compliance engineer needs

Measured, `left=7230 right=9110` (9110 obsoletes 7230):

| call                                          | result                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mode=requirements`, default `max_changes=50` | `summary {"requirement_removed": 50}`, `truncated: true`, all 50 rows `requirement_removed` |
| `mode=requirements`, `max_changes=500`        | `summary {"requirement_removed": 206, "requirement_added": 294}`, `truncated: true`         |
| `mode=metadata`                               | `summary {"metadata_changed": 13}` — correct and useful                                     |
| `left=right`                                  | `{}` with warning `both_sides_are_the_same_snapshot` — correct                              |

Two separate findings.

**(a) The match key makes cross-version diff structurally blind.**
`diff.ts:221-227` keys a requirement on `sectionNumber | text-with-modals-normalised`. RFC 9110
renumbers every section of 7230, so the key almost never matches, and the diff degenerates into
"everything removed, everything added". The consequence is not the noise — it is that
**`modality_changed` fired 0 times in 500 changes.** The one change kind a compliance engineer must
not miss — _the successor weakened a MUST to a SHOULD_ — is the one change kind this diff cannot
produce for a document pair whose sections moved. The row even carries the note
`modality_change_is_not_a_breaking_change_verdict`, which is good, and it never got exercised.

**(b) `summary` is a page count, not a diff count, and is not marked as a lower bound.**
`diff.ts:45` returns early from `add()` once `changes.length >= maxChanges`; `diff.ts:57` increments
`summary[kind]` _inside_ `add()`, after that check. So at the default the tool states
"50 requirements were removed" for a pair where 206 were removed and 294 were added. `truncated:
true` is present and honest, but a caller that reads `summary` — which is the field a compliance
report would put in a table — gets a wrong number with no `>=` marker.

Both are in `built and wrong`, not `not built`.

### 2.4 `rfc_history`: works, is un-stored, and returns double-escaped text

`rfc_history(rfc=9110)` returns 13 real datatracker change entries, fetched on demand. But:

- the DB holds history for **3 of 166** documents (38 rows total);
- the returned strings are **double-escaped**: `"changed keywords to &amp;#x27;[&amp;#x27;Hypertext
Transfer Protocol..."`. `fetchHistory` (`sources.ts:363`) applies one XML unescape; the datatracker
  feed stores pre-escaped HTML in `<title>`, so a second pass is needed. As shipped, every history
  title and summary needs manual cleanup before it is usable;
- it is a _change feed for a document_, not a _version history of its text_. It tells you the
  keywords were edited on 2026-05-20; it cannot show you the text before the edit.

---

## 3. Errata

### 3.1 The stated policy is implemented

Verified: `rfc_errata` returns rows with `errata_id, status, type, section, original_text,
corrected_text, notes, submitted_at, updated_at, url`, and the publication text is untouched.
Verified: `ensure_rfcs` / `replaceErrata` (`rfcService.ts:1820`) store the overlay separately.
Verified: the empty-list case is disambiguated — an empty result carries
`status_filter`, `total_unfiltered` and `available_statuses`, and the warning is
`no_errata_with_status:verified:available=…` rather than a bare "none". That is a real design
decision most tools get wrong.

So the _policy_ is fine. The problem is that an overlay nobody can join to anything is not usable.

### 3.2 Discovery: 0.09% of documents, 2.3% of the corpus's errata

116 errata rows for 9 documents. The fetch is on demand and works — `rfc_errata(rfc=7230,
status="verified")` returned 8 verified errata for a document that had none stored, correctly
flagged `freshness: "cached"` against the rfc-common URL. So this is a **discovery** limit, not a
capability limit. But there is no query shape that finds errata without already knowing which
document to ask about:

- no corpus-wide "which documents have errata" — the catalog has no errata column, and the
  `errata` table is keyed by RFC with no index a caller can reach through the tool surface;
- `rfc_metadata(include=["errata_summary"])` reports `fetched: true|false` for a _known_ document,
  which is a per-document cache flag, not a corpus index.

For scale, `trentmilam/agentic-rag` reports ingesting **5 061 real errata records** with a measured
trust distribution (2 400 verified / 1 781 held / 679 rejected / 201 reported) and a per-module
`trust_tier` of 0.55 for errata versus 0.9–0.95 for primary text. The `pipeworx-io/rfc-editor` MCP
exposes `errata(number?)` documented as _"per-RFC or **all**"_. The IETF datatracker exposes
`has_errata: true` on every document. So 116/5 061 ≈ **2.3% of the corpus's errata** is roughly the
state of the art among the tools I found, and it is the single most consequential thing missing here.

### 3.3 The join: an erratum cannot be related to a contract row

An errata row has `section` as **free text** and `original_text` with **CRLF** line endings. It has
no `citation_id`, no `requirement_id`, no `section_id`, no byte offset, no anchor. Measured
properties of the 116 stored rows:

| property                                                                                          | count                                                                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `section` is not a clean section number (contains a space, a comma, a trailing dot, or no digits) | **23 / 116 (19.8%)**                                                                                         |
| `section` is empty                                                                                | 2 / 116                                                                                                      |
| `original_text` carries an upper-case RFC 2119 modal                                              | **32 / 116 (27.6%)**                                                                                         |
| … and is `verified` or `held for document update`                                                 | **27 / 116**                                                                                                 |
| … and is `verified` **and** `Technical`                                                           | **4 / 116** (RFC 1035 eid2130 §3.2.1, RFC 5246 eid2643 §E.3, RFC 5246 eid4750 §4.3, RFC 9000 eid6811 §5.1.1) |

Observed `section` values: `"4.3 Vectors"`, `"2.1, ID 1081"`, `"E.3"`, `"15.5.2."`, `"B.1."`, `""`.
A join on that field fails on a fifth of the rows before any text matching is attempted.

**The concrete demonstration.** RFC 7230, erratum **4050**, status `verified`, type `Editorial`,
`section: "3.2.4"`:

```
original_text : A server MUST reject any received request message that contains
                whitespace between a header field-name and colon with a response code
                of 400 (Bad Request).
corrected_text: ... with a status code of 400 (Bad Request).
```

The affected contract row exists and is addressable:

```
rfc_requirements(rfc=7230, scope="3.2.4") →
  req_713193b4534487d3 | MUST | cit_713193b4534487d3350c7ebf
  "A    server MUST reject any received request message that contains    whitespace
   between a header field-name and colon with a response code    of 400 (Bad Request)."
```

**There is no call that relates them.** The caller must: know the erratum exists (no index);
know it is about §3.2.4 (free text, 19.8% malformed); page §3.2.4's rows; normalise CRLF-vs-LF;
**and normalise the RFC's hard-wrap indentation** — the row reads `"A␣␣␣␣server"` with four-space
runs where the erratum has one, so a naive substring match on `original_text` fails; then fuzzy
match. A verified erratum that renames a term inside a MUST is invisible to a contract built from
this tool, and invisible _in both directions_: the requirement row carries no `errata` field, and
the errata row carries no `citation_id`.

**Size of the exposure, in this corpus:** 27 of the 116 stored errata are RFC-Editor-acknowledged
and modify a sentence carrying an upper-case modal. A compliance contract generated today from
these 166 documents is silently wrong on up to 27 sentences, and the tool provides no way to
enumerate them.

**The IETF's own tool solves placement by doing the opposite thing.**
`ietf-tools/Rfc-Errata` "pulls down a copy of the errata database from the RFC Editor and the text
version of an RFC. It then merges the errata and the text of the RFC to produce an HTML file",
defaulting to `held=yes verified=yes reported=no rejected=no`. That is the 2019 IETF RFP's
"Locating Errata Placement" problem, and the RFP's own guidance was _"use the section number
information in the reported errata, not what you matched (or failed to match) in the document"_ —
i.e. even the IETF's own prototype could not reliably place an erratum by text match.

So the overlay decision here is defensible and arguably better than merging, because it keeps
`verify_citation` meaningful against the published file. **What is missing is not the merge; it is
the index.** A normalised `original_text` → located span → `citation_id` join, emitted as
`affected_requirements: [req_…]` on each errata row and as `errata: [4050]` on each requirement
row, is a bounded piece of work against data this tool already holds, and its absence is the
highest-consequence gap that is purely additive.

---

## 4. The normative / deontic problem — with numbers

Corpus: 10 966 strict requirement rows over 166 documents. Bench reference: `after3.json`
(100 protocols, 260 rules, strict 118 / weak 142), hand labels from
`eval/PRECISION-RUBRIC.md`.

### 4.1 The two headline rates the project publishes

| measure                                                     | value                                                                                 | source                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| strict-channel **precision**                                | **94.3%** (217 TP / 13 FP of 230 hand-labelled)                                       | `after2-precision-labels-requirement.json` |
| strict **recall**                                           | **91.5%** (108/118)                                                                   | `after3.json`                              |
| weak (lower-case modal) **recall**                          | **84.5%** (109/129)                                                                   | `after3.json`                              |
| **keyword-free recall**                                     | **0.0% (0 / 13)**                                                                     | `after3.json`, `weak_keyword_free`         |
| **candidate-channel precision**                             | **29.2%** (54 TP / 131 FP of 185 hand-labelled)                                       | `after-precision-labels-candidates.json`   |
| candidate-channel precision, before the boilerplate filters | 36.8% (70/190)                                                                        | `before-precision-labels-candidates.json`  |
| **VERIFY**                                                  | **99.6%** (234/235 `verified`, 1 `not_found`)                                         | `after3.json`                              |
| **CALLS**                                                   | **68.31 per 40 rules** (246 resolve + 397 requirements + 19 extra pages + 235 verify) | `after3.json`                              |

The 94.3% strict precision and the 99.6% verification rate are the two best numbers in this
repository and they are measured, not asserted.

### 4.2 The classes, sized

**(a) One sentence, one modal, self-contained — the class the tool is built for.**
91.5% recall. This is the majority and it works.

**(b) Prohibitions and permissions stated with no keyword at all.**
13 of 260 golden rules (**5.0%**) are keyword-free — a bound with no modal anywhere in the
sentence. **Recall 0 of 13.** By construction: the extractor is upper-case-only, per RFC 8174 §3,
which is the correct reading of the standard. The bench reports this class _separately_ rather
than folding it into an average, which is the right call and rare. But the number is: **5% of a
compliance contract is unreachable, by design, and the design is defensible.**

**(c) The pre-2119 case, where the contract disappears entirely.**
Measured over ten documents spanning 1973–2009:

| RFC  | year | strict | candidates | `keyword_usage.stance` |
| ---- | ---- | ------ | ---------- | ---------------------- |
| 768  | 1980 | **0**  | 4          | absent                 |
| 2136 | 1971 | **0**  | 73         | absent                 |
| 2300 | 1986 | **0**  | 60         | absent                 |
| 2606 | 1989 | **0**  | 4          | absent                 |
| 4291 | 1998 | **0**  | 67         | absent                 |
| 1958 | 1987 | **0**  | 46         | absent                 |
| 2828 | 2000 | 104    | 258        | absent                 |
| 4253 | 2005 | 117    | 47         | `adopts`               |
| 5280 | 2009 | 364    | 277        | `adopts`               |
| 8446 | 2018 | 427    | 166        | `adopts`               |

For the six pre-BCP-14 documents: **strict = 0, and 100% of the normative content sits in the
channel the tool itself calls "a lead list, not a contract"** (`reading_rules[1]`). And that
channel is **29.2% precise** — roughly 7 of every 10 rows are not obligations. False-positive
taxonomy from the hand labels: `not_an_obligation` 51, `structural` 14, `boilerplate` 11,
`definition_of_keywords` 2, plus 53 carried-over rows that are mostly boilerplate.

`include_provisional` is the documented escape hatch ("for a document that predates RFC 2119 this
is the only way to get a compliance list"), and it is honest about the tier. But 29.2% precision
on the only channel available is the number a caller has to plan around: an engineer implementing
RFC 768 reads 4 candidate rows and has a 70% chance each is not an obligation.

**(d) A requirement that spans a paragraph or a page break — and is emitted as whole anyway.**
This is the largest _built-and-wrong_ class. Measured on the current DB: requirement rows whose
`exact_text` does not end in terminal punctuation:

| class                 | rows    | share of 10 966 | unflagged     |
| --------------------- | ------- | --------------- | ------------- |
| row ends mid-sentence | **422** | **3.85%**       | **326 (77%)** |

A further 7 rows end on a dangling preposition ("…on which", "…of the"). The independent
diagnosis in `eval/results/strict-miss-diagnosis.md` and `eval/results/pending-fixes.md` (items
Y1, Y2) names the mechanism and reproduces it: `splitSentences` runs **per block** from
`analyzeNormative`, and `groupBlocks` ends a block at every blank line and every page break, so a
block boundary is a sentence boundary. The candidate pass already has
`previousEndedOpen` / `continues_previous_block` / `isFragment`; the strict pass has none of it.
Population by trigger, from the same diagnosis: **274 rows in 38 documents** are page-break first
halves (220 unflagged), **19 rows in 8 documents** are blank-line first halves, and **97 rows in
31 documents** are sentence _tails_ that begin lower case.

Worked example, RFC 1812 §4.2.2.2: emitted as
`"When a router inserts its address into such an\n   option, it MUST use the IP address of the
logical interface on which"` with `parse_status: "complete"`, `confidence: 0.9`, `flags: []`, and
`clause.action = "use the IP address of the logical interface on which"` — dangling on a
preposition, with the second half of the sentence ("the packet is being sent") in the next block.

This is the one class that makes a _correct-looking_ contract wrong, because
`coverage.total_requirements` counts the fragment and nothing on the row says so. It is also the
cheapest to fix: the mechanism already exists in the same file, and the project has already
written the fix down.

**(e) Multiple modalities in one sentence, collapsed into one row.**

| class                                            | rows      | share     | keyword instances |
| ------------------------------------------------ | --------- | --------- | ----------------- |
| `flags` contains `keywords_collapsed_to_one_row` | **1 069** | **9.75%** | **2 204**         |

So **1 135 deontic assertions present in the text are not separately addressable in the contract.**
"MUST send X and MUST NOT send Y" in one sentence is one row. The `keywords[]` array preserves the
individual spans and terms, so the information is _recoverable_ — but a contract generator reading
`term`/`strength`/`polarity` gets one obligation where the RFC states two.

**(f) Conditional on something.**
Rows containing a conditional subordinate marker (`if the`, `when`, `in the case`, `where the`,
`provided that`, `only if`, `as long as`): **1 888 (17.2%)**. Of those, **977 rows (8.9% of the
whole corpus) have `clause.condition = null`** while the condition sits plainly in `exact_text`.
The tool exposes a four-field clause structure `{actor, condition, action, exception}` and leaves
the condition empty for **52% of the conditionals**. Example (RFC 9110 §2.2):
`"A sender MUST NOT generate protocol elements that do not match the\n   grammar defined by the
corresponding ABNF rules."` → `condition: null`, `action: "generate protocol elements that do not
match the grammar defined by the corresponding ABNF rules"` — a condition the implementer must
resolve against a grammar the tool does not parse (§5).

**(g) Versioned / conditional-on-extension.**
Rows containing `unless`: **338 (3.1%)**. Rows containing `except`: **99 (0.9%)**. Rows with a
non-null `clause.exception_text`: **86 (0.8%)** — i.e. the exception channel is populated for
**2.6%** of the sentences that state an exception. "MUST, unless the … extension is present" is
_exactly_ the versioned obligation an engineer implements conditionally, and it is 338 unlinked
sentences with 338 empty `exception` fields.

**(h) Defined in one section, applied in another.**
Rows cross-referencing another section or appendix: **1 256 (11.5%)**. No link is extracted; the
reference stays prose inside `exact_text`. A contract generator must resolve 1 256 section
references itself, per document, with no assistance and no verification hook.

**(i) Conditional on a table or figure.**
Rows referring to a table, figure, "above" or "below": **328 (3.0%)**. The table is not scanned
(§5), so each of these references dangles.

**(j) Prohibition phrased without a modal** ("is not permitted", "no …"): **350 (3.2%)** of the
strict rows; and the keyword-free class (b) is where the rest live.

**(k) Multi-clause rows.** Rows over 400 characters: **94 (0.9%)**. Over 900 characters: **0** —
which is the one thing the table-as-paragraph fix (`a48fa2c`: RFC 5322 265 → 57 requirements,
RFC 9110 430 → 408) genuinely cured.

### 4.3 What the tool says about itself here — the strongest part of the design

Every one of the classes above is _counted_ on the response or in a documented rule:

- `coverage.blocks_skipped_by_kind` — `{preformatted: 100, table: 55, section:references: 87, …}`
- `coverage.keyword_bearing_blocks_skipped` and the warning
  `normative_text_in_unscanned_blocks:4:out_of_scope_by_design:see_coverage_keyword_bearing_blocks_skipped`
- `coverage.unscanned_note` — _"a low total_requirements on a table-driven specification reads as a
  known gap rather than an absence"_
- `interpretation.caveat` — _"A missing requirement is not proof of absence"_
- `reading_rules[0]` — _"A requirement count of 0 means no UPPER-CASE RFC 2119 keyword was found,
  not that a document states no requirements"_
- `non_strict_candidates.note` — _"role=unknown and shape=indeterminate are real answers, not
  passes — read them"_
- `CHANGELOG.md` "Not changed, and why" — anaphora and deontic-vs-descriptive modality declared as
  boundaries, with RFC 2181 §5.5 quoted as the anaphora case

Very few tools say this much. **The problem is not silence. The problem is that class (d) is not
in any counter** — 422 truncated rows, 326 of them flagged as complete, and the loss report says
nothing about them. That is the single place where the project's own discipline fails to cover
its own worst defect.

---

## 5. Structure that is not a section

### 5.1 How much normative content lives outside prose

| block kind                      | blocks                       | scanned?       |
| ------------------------------- | ---------------------------- | -------------- |
| paragraph / list_item / unknown | 43 185                       | yes            |
| `preformatted`                  | 6 474                        | no             |
| `section:references`            | 4 052                        | no (by design) |
| `table`                         | 1 820                        | no (by design) |
| `section:authors`               | 967                          | no (by design) |
| `section:index`                 | 338                          | no (by design) |
| `reference_entry`               | 191                          | no (by design) |
| **total not scanned**           | **13 842 = 24.3% of 57 027** |                |

And the tool's own counter: **391 non-prose blocks carry an RFC 2119 keyword and none of them is
scanned** (`snapshots.keyword_bearing_unscanned_block_count`, summed over 166 documents). Honest,
on every response, and genuinely rare. Credit.

### 5.2 But the counter is a lower bound, and the project knows why

The counter tests for an upper-case keyword _string inside the skipped block_. A grammar's
normative force is stated in the prose that introduces it, not inside the grammar. The tool's own
first `MUST NOT` row for RFC 9110 is the proof:

```
§2.2  "A sender MUST NOT generate protocol elements that do not match the
        grammar defined by the corresponding ABNF rules."
```

The requirement is one sentence. **The grammar it delegates to is 6 474 preformatted blocks, of
which 616 contain an ABNF production** (crude `=`/`=/`/`=*` test). Those blocks carry no keyword
and are therefore invisible to `keyword_bearing_blocks_skipped`. The same holds for a field table
whose Requirement column reads `SHOULD` in a cell, for a CDDL schema, and for a state-machine
figure. So 391 is a floor, and the floor is the comfortable part.

### 5.3 ABNF, CDDL, JSON Schema: zero support

```
$ grep -rniE "abnf" src/
src/parse/text.ts:813:  // CDDL, ABNF and schema blocks. RFC 9472's data model is 2 031 characters of rule

$ grep -rniE "cddl|JSON Schema|openapi|sarif|json-?ld" src/
src/parse/text.ts:789:  * A pipe table, a `+---+` rule, a CDDL or schema rule header, a block that is mostly one
src/parse/text.ts:813:  // CDDL, ABNF and schema blocks.
```

**One hit, and it is a comment naming ABNF as a block kind to exclude from prose.** No ABNF
parser, no production extraction, no rule-name index, no CDDL, no JSON Schema, no OpenAPI export
anywhere in `src/`.

### 5.4 What an engineer actually gets for a document that specifies in ABNF

RFC 9110, `rfc_read(section="Appendix A", include=["blocks","source_map"])` → 38 blocks, 8
`preformatted`, e.g.:

```
   Accept = [ ( media-range [ weight ] ) *( OWS "," OWS ( media-range [
    weight ] ) ) ]
   Accept-Charset = [ ( ( token / "*" ) [ weight ] ) *( OWS "," OWS ( (
    token / "*" ) [ weight ] ) ) ]
   …
   Content-Length = 1*DIGIT
   Content-Range = range-unit SP ( range-resp / unsatisfied-range )
```

The engineer receives the collected ABNF as **raw preformatted text with byte offsets**. No
production names are extracted, so nothing is addressable; the §2.2 obligation is not linked to the
productions it constrains; `field-value` cannot be resolved. RFC 9110 is a document where a large
part of the compliance contract _is_ the ABNF, and what arrives is a blob plus 408 sentence rows
that the caller must join by hand.

For comparison: `ietf-tools/rfclint` "verify[s] that embedded ABNF is complete and well formed"
and validates the document against the XML2RFC v3 schema. ABNF as a first-class, validatable
artifact is IETF-standard practice; here it is out of scope by omission.

### 5.5 Fairness: the state of the art cannot do this either

This is the one gap where I will argue that _not building it is correct_. PSMBENCH / RFC2PSM
(openreview `5HGBErIHuV`, 1 580 pages, 14 protocols, 108 expert-verified states, 297 transitions)
measures nine open and commercial LLMs extracting protocol state machines from RFC prose:
best state F1 **0.715**, best **transition** F1 **0.381**. Nobody extracts an FSM from RFC prose
reliably today, deterministically or not. RFC 9110 §6.3's state machine and RFC 5246 §4.3's test
vectors are out of reach for the whole field.

So: the decision not to attempt FSM/ABNF extraction is _consistent with the state of the art_.
The gap is not ambition, it is **disclosure**: the response says
`blocks_skipped_by_kind.preformatted: 158` for RFC 9110 but never says "this specification defines
its wire format in ABNF; the sentence rows do not contain it". A per-document flag in that shape
is cheap and would move the finding from "the tool is quiet about its largest blind spot" to "the
tool names it."

---

## 6. Interoperability and meta

| capability                                | state                                                  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenAPI / JSON-Schema-shaped output**   | **absent**                                             | 0 hits for `openapi`/`JSON Schema`/`sarif`/`json-?ld` in `src/`. Every tool has a Zod `outputSchema` for MCP validation, which is a different thing. Listed as roadmap ("JSON-LD / SARIF export of citation bundles"). A compliance contract has no portable schema.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Stable ids that survive re-derivation** | **half-built — in `src/`, absent from `dist/`**        | `src/analysis/citation.ts` implements `stableCitationId()` → `scit_` (3 occurrences in src). **`grep -c scit_ dist/analysis/citation.js` = 0.** Not in `docs/CONTRACT.md`. Shipped requirement rows carry only `req_…`/`cit_…`, both derived from `snapshotId` (`citation.ts:34`). The project's own comment records the cost: _"94 of 100 pinned snapshots in a 100-protocol corpus had to be re-pinned after a routine parser bump, and a citation written into a contract or a bug report could not be re-verified afterwards."_ So today a citation embedded in a contract dies on any parser or extractor bump, and `verify_citation` answers `not_found` with no way to learn what the text was. |
| **Diff of a document between versions**   | **absent in effect**                                   | one snapshot per document (§2.1); cross-document diff degenerates to removed/added, `summary` is a page count, `modality_changed` never fires (§2.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Subscribe to a document changing**      | **absent**                                             | no tool, no resource, no CLI verb, no poll loop. The datatracker offers `?time__gt=` range queries on `doc/docevent`, `doc/dochistory`, `doc/relateddocument`; `trentmilam/agentic-rag` ships a `current_only` structural guard plus a `get_corrections` / `get_obsoletion_chain` tool pair. rfc-mcp polls nothing and offers no change signal.                                                                                                                                                                                                                                                                                                                                                        |
| **Know the corpus is stale**              | **built and wrong**                                    | `rfcService.ts:2474` is literally `stale: 0,`. `IndexStatus.state` is typed `"ready" \| "stale" \| "missing" \| "degraded"` but the implementation at L2465 can only produce `ready` or `missing`. The health report's staleness counter always reads zero and the `stale` state is never emitted. A caller reading it learns nothing — and a field that always says "0 stale" is worse than no field.                                                                                                                                                                                                                                                                                                 |
| **Corpus-wide errata index**              | **absent**                                             | 116 rows / 9 documents; no query shape (§3.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Corpus-wide supersession graph**        | **present and good**                                   | 5 184 relations over 9 842; depth 3; truncation and unresolved labels self-reported (§2.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Text search over the whole corpus**     | **present, scope partly silent**                       | `text_search_covers_ingested_documents_only:ingested=166,catalog=9842` fires on zero hits — good. It does not fire on non-zero hits, so a caller cannot tell a 3-document corpus from a 9 842-document one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Machine-readable export**               | **absent**                                             | no JSON/JSON-LD/SARIF export of a citation bundle; a contract must be assembled by the caller from paginated tool calls at **68.31 calls per 40 rules**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Read-only**                             | **read-only at the tool contract, not at the process** | see L6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Two smaller findings, both in the credibility path

**`exact_pct` is mislabelled in the project's own instrument.** `run-bench.mjs:511` prints
`RECALL strict 108/118 = 91.5%  (byte-exact 5.1%)`. It is not byte-exactness. The golden probe is
whitespace-collapsed at construction — `labelling.mjs` defines `norm` as
`.replace(/\s+/gu, " ").trim()` and its own comment says _"candidates are normalised, not sliced
out of the raw text"_ — and `findIn` computes `exact` as `it.exact_text.includes(probe)`. Since the
probe has no internal newlines, `exact` can only be true for a row that happens to be a single
unbroken line. **`exact_pct: 5.1%` is a measure of hard-wrapping, not of correctness**, and it is
printed in a form that invites the opposite reading. The whole credibility argument rests on the
bench; a mislabelled field in the bench is worth more than most of the gaps above.

**Three requirement rows carry a duplicated flag.** RFC 9110, 3 rows with
`flags: ["requirements_notation_section", "requirements_notation_section"]` — the same value twice
in one array, verified by counting `json_array_length` against `count(distinct value)`. Trivial,
but it contradicts a stated guarantee that nothing is reported sloppily.

---

## 7. Where this design is genuinely ahead

A gap analysis that only criticises is not an audit. Five things here are better than anything I
found, and four of them are things the alternatives do not attempt at all.

1. **The snapshot / offset / verification model is the best thing in this space, and I could not
   find its equal.** `verify_citation` returns `verified | stale | ambiguous | not_found |
integrity_failure`, checks the snapshot's content hash first, and reports offsets in UTF-8
   bytes, UTF-16 code units, Unicode code points and line numbers, with the guarantee that
   `rawBytes.slice(byte_start, byte_end) === text`. Measured **234/235 = 99.6%** on the bench, with
   the single failure reported rather than absorbed. The five-verdict design is the right one: it
   distinguishes "this text is still in the document" from "this text is in the bytes you pinned".
   The `limits_notes.maxQuoteChars` entry — advertising a limit, then stating it is **not enforced
   and why** ("a quote that no longer matches its bytes could not be verified, and the corpus
   contains requirement sentences of 2 697 characters") — is the single most honest sentence in any
   tool description I have read. Every competitor returns a snippet; this returns a checkable claim.
2. **Published measurement discipline, at a level I have not seen elsewhere in this domain.** A
   100-protocol / 260-rule golden set selected by a _published function_ of the document text
   (`eval/lib/labelling.mjs`), cut into 10 strata so it cannot drift toward a family the extractor
   happens to handle, with a stated argument for why selection cannot prefer a tier and why
   `build-golden.mjs` does not call `requirements` at all (so recall cannot be circular). Tier
   separation enforced in one place. A hand-labelled precision rubric, labels carried across runs
   by `(rfc, text)`, and a false-positive _taxonomy_ rather than a bare rate. A refusal to publish a
   before/after pair where the "before" is not on disk. Label-free corpus invariants
   (`dangling_headings`) that catch what a golden set cut from a broken outline cannot see. And
   `eval/results/strict-miss-diagnosis.md` / `pending-fixes.md` diagnose six reported misses to the
   responsible function and line, with corpus-wide population counts, and explicitly separate
   "golden-probe error" (0), "documented boundary" (0) from "defect" (4).
3. **The commit-message-as-experiment discipline.** `a48fa2c` is a model of "measure first": it
   found a table classified as a paragraph (RFC 5322 265 → 57 requirements, RFC 9110 430 → 408) and
   verified the fix cost **zero** golden rules; it found that its own new loss counter had
   _silently stopped requirement detection_ because `TERM_PATTERN` carries `g` and `test()` moved
   `lastIndex` — a bug with the signature "two tests pass alone and fail together"; it found the
   counter cost 29 s per call, diagnosed it as the query plan rather than the missing index, and
   moved it to derivation time (**29 000 ms → 326 ms**, same numbers); it added two more
   boilerplate patterns _by measurement_ (a 185-item hand-checked sample still carried 11 rows) and
   then declined to add two more because doing so would have invalidated the measurement in flight.
4. **The loss counters and reading rules.** `blocks_skipped_by_kind`,
   `keyword_bearing_blocks_skipped`, the `normative_text_in_unscanned_blocks:N` warning,
   `coverage.unscanned_note`, `reading_rules[0..6]`, the empty-errata response naming the statuses
   that _do_ have errata, `errata_empty` vs `no_errata_with_status:…`,
   `filters_not_applied_to_catalog:[…]`, `filters_not_applied_to_text:[…]`,
   `text_search_covers_ingested_documents_only:ingested=166,catalog=9842`,
   `both_sides_are_the_same_snapshot`, `inbound_relations_truncated_at_486`,
   `unresolved_reference_labels:9`, `document_json_unavailable:…`,
   `xml_unavailable:offline`. A competitor returning the same data returns none of this. This is
   the most transferable design decision in the repository, and it is the thing I would point at
   if asked which single idea here should be copied.
5. **Policy and hygiene, done properly and without being asked.** Host allowlist with no
   user-supplied URL ever reaching `fetch`; DTD and entity declarations rejected and XInclude never
   resolved; author email addresses stripped at the source boundary; RFC text treated as untrusted
   data; errata never applied; no document text in logs. Plus ergonomic primitives that are
   quietly right: generation-bound HMAC cursors, `rfc.batch` (≤10 ops, per-item status),
   `reanalyze --all` (re-derive every document offline from stored bytes after a rule change, with
   no re-fetch), and the RFCXML outline as a second representation with a checked cross-representation
   invariant (293 shared section numbers for RFC 9110 carry the same kind in both the text and XML
   outlines) — a consistency claim nobody else publishes.

The competitor comparison, dated 2026-09-26: `higebu/rfc-mcp` (Go) is the closest architectural
peer — same SQLite + FTS5, same explicit anti-RAG argument, same structure-first stance, plus a
`section` filter on `get_errata` that this tool does not have. `pipeworx-io/rfc-editor` lists errata
"per-RFC or all" and adds `bcp()`/`std()` subseries mapping, which rfc-mcp has only as a
`subseries` field on `metadata`. `donaldgifford/rfc-api` makes an OpenAPI 3.1 spec the source of
truth with contract tests so spec and server cannot drift. `trentmilam/agentic-rag` is the most
capable RAG-side system: 321 124 chunks over the real corpus, 5 061 errata with measured trust
tiers, a deterministic supersession module over 9 794 RFCs, a revision guard with a proof script,
and IANA registries. `mjpitz/mcp-rfc` gets better catalog recall by scraping HTML — the approach
this project correctly refuses. Against the IETF itself: `ietf-tools/Rfc-Errata` merges errata into
text and defaults to applying `held`+`verified`; `ietf-tools/rfclint` validates embedded ABNF and
the v3 schema; the datatracker offers a filterable API with `has_errata` per document, internet-draft
revisions, and `?time__gt=` change queries.

**On the research side, two results bear directly on the premise.** RFCAUDIT (arXiv 2506.00714)
is an LLM agent that checks implementations against their RFCs and reports 47 functional bugs at
81.9% precision across six real protocol implementations — i.e. the demand for this capability is
real and an agentic approach already delivers it. AICCE (arXiv 2604.03330) reaches 0.998 accuracy on
IPv6 compliance with a two-pipeline design whose second mode **"converts clauses into Python rules
that can be executed quickly for dataset-wide verification"**. That is the direction of travel for
RFC → compliance contract, and it is an LLM writing the rules from the same text, not a
deterministic extractor. rfc-mcp's deterministic extractor produces 94.3%-precise single sentences;
AICCE produces executable rules at 99.8%. The honest reading is that the two are complementary —
rfc-mcp's evidence model is what makes an LLM-authored rule auditable, and nothing in the
alternatives offers that — but a caller who only wants a contract has, today, a better option than
this tool for the contract itself.

---

## 8. "Not built yet" versus "built and wrong"

The brief asks for this separation explicitly, and it changes what each finding is worth.

### Not built yet (documented, honest, cost understood)

| id  | gap                                                                       | where it is acknowledged                                                                                 |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| N1  | internet-draft revisions and Datatracker history as first-class snapshots | README roadmap; CHANGELOG "Not changed, and why"                                                         |
| N2  | signed, reproducible corpus bundles                                       | README roadmap                                                                                           |
| N3  | IANA registries as an allow-listed layer                                  | README roadmap                                                                                           |
| N4  | calibrated confidence for clause extraction on labelled data              | README roadmap (and `confidence: 0.9` is currently a constant, not a calibrated score)                   |
| N5  | JSON-LD / SARIF export of citation bundles                                | README roadmap                                                                                           |
| N6  | ABNF / CDDL / FSM / test-vector extraction                                | not on the roadmap at all, but §5.5 argues this is _correct_ at the current state of the art             |
| N7  | subscription / change feed                                                | not on the roadmap                                                                                       |
| N8  | corpus-wide errata index and erratum→requirement join                     | not on the roadmap; `rfc_errata`'s "overlay, never applied" policy is stated, the _index_ is not planned |
| N9  | stable citation ids (`scit_`)                                             | in `src/`, absent from `dist/`, absent from `docs/CONTRACT.md` — **in flight, not shipped**              |

### Built and wrong (shipped, measurable, and it produces a wrong or misleading answer)

| id      | finding                                                                                                                                                                                                                                                                                                                                 | size                                                                                                 | where                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **B1**  | A requirement cut mid-sentence is emitted with `parse_status: "complete"`, `confidence: 0.9`, `flags: []`                                                                                                                                                                                                                               | **422 rows (3.85%), 326 (77%) unflagged**; 274 in 38 docs from page breaks, 19 in 8 from blank lines | `src/analysis/normative.ts` (`splitSentences` per block), `src/parse/text.ts` (`groupBlocks`) |
| **B2**  | `rfc_diff` `summary` counts the emitted page, not the diff, and is not marked as a lower bound                                                                                                                                                                                                                                          | at default: reports `50 removed` where 206 were removed and 294 added                                | `src/analysis/diff.ts:45,57`                                                                  |
| **B3**  | `rfc_diff` cannot detect a modality change between a document and its successor                                                                                                                                                                                                                                                         | **`modality_changed`: 0 of 500 changes** on 7230→9110                                                | `src/analysis/diff.ts:221-227` (key includes section number)                                  |
| **B4**  | `rfc_status().documents.stale` is a hard-coded `0`; `IndexStatus.state: "stale"` is unreachable                                                                                                                                                                                                                                         | always                                                                                               | `src/service/rfcService.ts:2465,2474`                                                         |
| **B5**  | Catalog search reports `coverage: "catalog_titles_and_abstracts"` and `match_field: "title"` when 98.4% of rows have no abstract and the match may not be in the title                                                                                                                                                                  | 9 689/9 842 rows; `rfc_search("hypertext transfer protocol", scope=catalog)` → 0 hits                | `src/service/rfcService.ts` catalog branch of `search`                                        |
| **B6**  | `rfc_history` returns double-escaped text (`&amp;#x27;`)                                                                                                                                                                                                                                                                                | 13/13 entries for RFC 9110                                                                           | `src/upstream/sources.ts:363` (`fetchHistory`, one unescape pass)                             |
| **B7**  | `clause.exception_text` populated for 2.6% of the sentences that state an exception; `clause.condition` null for 52% of the conditionals                                                                                                                                                                                                | 86/338 `unless`-rows; 977/1 888 conditional rows                                                     | `src/analysis/normative.ts` clause parser                                                     |
| **B8**  | `capabilities.limits.maxGraphDepth: 1` understates the tool (schema accepts 3, depth 3 works)                                                                                                                                                                                                                                           | 1 field                                                                                              | `src/core/config.ts` / `capabilities`                                                         |
| **B9**  | 3 requirement rows carry a duplicated flag value                                                                                                                                                                                                                                                                                        | 3 rows, RFC 9110                                                                                     | `src/analysis/normative.ts`                                                                   |
| **B10** | The bench prints `exact_pct` as "byte-exact"; it measures single-line rows, not correctness                                                                                                                                                                                                                                             | the `5.1%` / `1.4%` figures in `after3.log`                                                          | `eval/run-bench.mjs:511` + `eval/lib/labelling.mjs` `norm`                                    |
| **B11** | A "strictly read-only" server performs a full ingest (2+ HTTP calls, full parse, SQLite commit) from `rfc_metadata` / `rfc_read` / `rfc_search` / `rfc_requirements` on a cache miss; `rfc_search(ensure_top_catalog_hits=N)` ingests up to **20** documents in one call, and those documents do not appear in `provenance.source_urls` | ~1.9 MB download + ~27 MB DB per 20-doc call                                                         | `rfcService.ts:605-656` (`anchor` → `ensureSnapshot` → `commitDocument`)                      |

On B11, to be fair to the project: the stated policy is _"no model-visible write tool; corpus
maintenance is CLI-only"_, and that policy is met — there is no write tool. The gap is between the
policy as written and the property a reader assumes from the words "strictly read-only" in the
README's first line. It is also how this audit's own live corpus count moved from 159 to 181.
For the record: this session triggered ingests for RFC 7230 (errata), RFC 8319 (`metadata`) and
RFC 9110 §5.6.1 / Appendix A (`read`) through ordinary read-shaped calls.

---

## 9. The gap table

| #   | gap                                                                                   | measured size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | consequence for the stated purpose                                                                                                                                                                                                                 | how the state of the art handles it                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Corpus coverage                                                                       | **166 / 9 842 documents = 1.69%** text + requirements; **9 / 9 842 = 0.09%** have errata; **116 / ~5 061 ≈ 2.3%** of the corpus's errata                                                                                                                                                                                                                                                                                                                                                             | Every "what does the corpus say" answer is an answer about 1.7% of it. A contract cannot be built for a document the tool has not read, and nothing tells the caller which documents those are beyond a count.                                     | `trentmilam/agentic-rag`: 321 124 chunks over the real corpus, 5 061 errata, deterministic graph over 9 794 RFCs. Datatracker: filterable, `has_errata` per document. `pipeworx` MCP: `errata(all)`. The datatracker and rfc-editor.org simply _are_ the corpus; no local copy is needed.                                                                                                                                                         |
| 2   | Truncated requirements reported as complete                                           | **422 / 10 966 rows (3.85%) end mid-sentence; 326 (77%) carry no flag**                                                                                                                                                                                                                                                                                                                                                                                                                              | An obligation whose action dangles on a preposition is emitted as a contract row with `confidence: 0.9`, and `coverage.total_requirements` counts it. A wrong contract that looks right.                                                           | No competitor has this problem because none of them splits sentences deterministically at all. LLM-based extractors (RFCAUDIT 81.9% precision, AICCE 0.998) keep whole sentences by construction. So this is a defect _unique to the deterministic approach_, and the approach's advantage is the evidence model.                                                                                                                                 |
| 3   | No version of a document, ever                                                        | **1 snapshot per RFC, 166/166**; 1 422 redirects, all rule-version bumps                                                                                                                                                                                                                                                                                                                                                                                                                             | A compliance contract is often _about_ a version. "What did §6.5.1 say in 2022" is unanswerable, and the only pinnable state is the newest.                                                                                                        | Datatracker: internet-draft revisions, `doc/dochistory`, `?time__gt=` range queries. `agentic-rag`: `revisions.json` + a `current_only` structural guard with a proof script. The RFC Editor: immutable published files, so "version" is a modelling choice nobody but this tool is making.                                                                                                                                                       |
| 4   | No erratum → requirement join; no corpus-wide errata index                            | **32/116 errata modify a modal-bearing sentence; 27 acknowledged; 4 verified+technical. 23/116 `section` values are not section numbers. 0 links.**                                                                                                                                                                                                                                                                                                                                                  | A contract built today is silently wrong on up to 27 sentences, and the caller cannot enumerate which. The overlay policy is right; the index is missing, so the overlay is unusable.                                                              | `ietf-tools/Rfc-Errata` merges errata into the text (defaults `held`+`verified` applied) — solves the problem by abandoning verifiability against the published file. `agentic-rag` ingests all 5 061 with measured trust tiers. Datatracker: `has_errata`. `pipeworx`: `errata(all)`. `higebu/rfc-mcp`: a `section` filter this tool lacks. **Nobody exposes erratum→row; the IETF's own 2019 RFP records that reliable placement is unsolved.** |
| 5   | Structure that is not a section                                                       | **13 842 / 57 027 blocks (24.3%) unscanned; tool's own counter: 391 keyword-bearing unscanned blocks; 6 474 preformatted blocks, 616 with an ABNF production; 1 820 table blocks.** Zero ABNF/CDDL/schema code.                                                                                                                                                                                                                                                                                      | For a document that specifies in ABNF, the sentence rows do not contain the contract, and the tool does not say so per document — it says `preformatted: 158`.                                                                                     | `rfclint` validates embedded ABNF and the v3 schema. `agentic-rag` chunks the grammar in and retrieves it semantically. **And the field cannot do it either: PSMBENCH measures ≤0.381 transition F1 for FSM extraction across nine open and commercial LLMs.** Not building this is correct; not _naming_ it per document is the gap.                                                                                                             |
| 6   | Deontic expressibility                                                                | strict recall **91.5%**; keyword-free **0/13 (5.0% of rules, 0% recall)**; candidate-channel precision **29.2%**; pre-2119 documents **strict = 0** with 100% of content in a channel that is 29.2% precise; **9.7%** of rows collapse 2 204 modal instances into 1 069 rows; **8.9%** of all rows carry a condition the `clause` field leaves null; **3.1%** carry `unless` and only **0.8%** have an `exception`; **11.5%** cross-reference another section; **3.0%** reference an unscanned table | A single sentence with one modal is ~91.5% of what this tool does well. Everything else degrades: silently (truncation, collapsed modals, missing conditions) or loudly (the candidate channel, which the tool correctly labels "not a contract"). | RFCAUDIT and AICCE convert clauses into executable rules with an LLM in the loop, reaching 81.9% and 99.8%. PSMBENCH shows the field cannot reliably extract structure. **The evidence model has no competitor; the extraction quality has better-funded competition.**                                                                                                                                                                           |
| 7   | `rfc_diff` cannot do version or modality diffs                                        | **`modality_changed` 0/500**; `summary` = page count (`50` reported where 206 removed / 294 added)                                                                                                                                                                                                                                                                                                                                                                                                   | "Did the successor weaken this MUST?" is the question a compliance engineer asks first, and this is the only diff in the tool. It cannot answer it.                                                                                                | The datatracker and the RFC Editor give you both documents; diffing them is the caller's job — but every general diff tool keys on text similarity, which is exactly what rfc-mcp already does and is losing to section numbers.                                                                                                                                                                                                                  |
| 8   | No machine-readable export, no stable ids shipped, no subscription, no real staleness | OpenAPI/SARIF/JSON-LD: 0 occurrences. `scit_`: in `src/`, **0 in `dist/`**. `stale`: hard-coded `0`. Subscription: absent. **68.31 calls per 40 rules.**                                                                                                                                                                                                                                                                                                                                             | A contract assembled by hand from paginated calls has no schema, no portable identifiers that survive a rule bump, and no way to be told it is out of date.                                                                                        | `donaldgifford/rfc-api`: OpenAPI 3.1 as source of truth with contract tests. `pipeworx`: ~30 gateway tools plus a natural-language router. Datatracker: a real filterable REST API. `higebu/rfc-mcp`: the same `id`-per-row design, so equally exposed to re-derivation.                                                                                                                                                                          |
| 9   | Read path writes                                                                      | `rfc_metadata` on an uncached RFC performs a full ingest; `rfc_search(ensure_top_catalog_hits=N)` ingests up to 20                                                                                                                                                                                                                                                                                                                                                                                   | Operational, not epistemic: one search call can cost ~1.9 MB of downloads and ~27 MB of disk, and `provenance.source_urls` does not name the documents it just fetched.                                                                            | n/a — a design choice. Lazy ingest is the right call for a small corpus and the wrong one at 9 842.                                                                                                                                                                                                                                                                                                                                               |

---

## 10. The three gaps that most damage the stated purpose

**1. Truncated requirements reported as complete — 422 rows, 326 of them unflagged.**
Measured: 3.85% of all strict requirement rows end mid-sentence; 77% of those carry
`parse_status: "complete"`, `confidence: 0.9` and `flags: []`; 274 of them across 38 documents are
page-break first halves and 19 across 8 documents are blank-line first halves. This is the only
finding that makes a _correct-looking_ contract wrong, because the loss is inside the row the
caller trusts and inside the `coverage.total_requirements` they count. The project's own
diagnosis names the mechanism (`splitSentences` per block; `groupBlocks` ends a block at every
blank line and page break), names the fix (the candidate pass already has
`continues_previous_block`; give the strict pass the same join and a `fragment` parse status), and
sizes the population. It is unfixed in the shipped artifact, it is the project's own highest-
priority pending item (Y1, Y2), and it is the cheapest of the three to close.

**2. Corpus coverage — 1.69% of documents, 0.09% with errata, 2.3% of the corpus's errata held.**
Measured: 166 of 9 842 documents have text and requirements; 9 have errata; 116 errata rows exist
against a corpus total of roughly 5 000; 9 689 catalog rows have no abstract, so catalog search
returns zero hits for "hypertext transfer protocol" across the entire corpus while claiming
`coverage: "catalog_titles_and_abstracts"`. The cost of closing it is measured and is not a code
problem: **6–11.5 GB of SQLite, 1–76 hours, ~40 000 HTTP calls**, with a per-document derived cost
of 10.7–12.6× the text size and a wall-clock cost dominated entirely by rfc-editor.org. The CHANGELOG
says so itself: _"Ingesting all 9842 is a storage and freshness policy decision, not a code fix."_
Until that decision is taken and the catalog is populated from a source that carries abstracts, the
tool's honest answer to "what does the RFC corpus require" is a statement about 166 documents, and
the coverage counters — which are otherwise excellent — are the only thing standing between that
and a false claim.

**3. No version, and no erratum→row join — one snapshot per document, zero errata links.**
Measured: `select rfc, count(*) from snapshots group by rfc having count > 1` returns nothing;
166 snapshots for 166 documents; all 1 422 redirects are rule-version bumps. `rfc_diff(7230 → 9110,
mode=requirements)` produces `requirement_removed: 206 / requirement_added: 294` and
**`modality_changed: 0`**, because the match key includes the section number and 9110 renumbers
everything. And 32 of 116 stored errata modify a modal-bearing sentence, 27 of them acknowledged by
the RFC Editor, 4 of them verified-and-Technical — with no field, index or tool call relating any
erratum to any requirement row, and a `section` field that is not a section number in 23 of 116
cases. A compliance contract is frequently about a version, and the two halves of this gap
compound: a contract pinned to a version cannot be diffed against its successor's modality, and
cannot be corrected by the errata the RFC Editor has already acknowledged.

**Runner-up, and it earns the sentence: the instrument has a mislabelled field.**
`run-bench.mjs` prints `exact_pct` as "byte-exact" when the probe is whitespace-normalised at
construction, so the `5.1%` / `1.4%` figures measure hard-wrapping rather than correctness. The
credibility of every other number in this repository rests on the bench being exactly as careful
as it is everywhere else; that one is not, and it is printed in the form that misleads.

---

## 11. Verdict

**On the evidence axis, yes — unambiguously, and by a wide margin.** If "most complete" means _the
tool whose derived statements a caller can check against bytes, whose absences are always named,
and which publishes its own defects with population counts_, then this is the most complete RFC
tool available, and the alternatives do not come close. `verify_citation`'s five verdicts with a
content-hash pre-check, offsets in four units with an exact-slice guarantee, the
`normative_text_in_unscanned_blocks` warning, the `no_errata_with_status:…` disambiguation, the
layered corpus invariants, the 100-protocol stratified golden set that cannot be circular, the
hand-labelled precision rubric with a false-positive taxonomy, and the `a48fa2c` commit message
that found a stateful-regex regression in its own new code and published it — I found nothing
comparable in `ietf-tools`, the IETF datatracker, the RFC Editor's own tooling, `higebu/rfc-mcp`,
`mjpitz/mcp-rfc`, `pipeworx-io/rfc-editor`, `donaldgifford/rfc-api` or `trentmilam/agentic-rag`.
On that dimension the tool is not merely complete; it is the reference.

**On coverage, no.** "Most complete" is a claim about how much of the RFC corpus a tool can speak
about, and this tool can speak about **1.69% of the documents, 0.09% of them with errata, and
2.3% of the corpus's errata**, while holding a 100% metadata and supersession graph over all 9 842.
The 1.69% is affordable to fix — 6–11.5 GB, 1–76 hours, ~40 000 calls, and the CHANGELOG already
names it a policy decision rather than an engineering one — which makes it a _decision_, not a
limitation, and a decision can be revisited; until it is, the description is not available.

**On the three dimensions a compliance contract actually turns on — is this the right text, is this
the right version, is this row still correct — the tool is furthest from complete.** It sees 1.7%
of the corpus, it holds exactly one version of each document and always the newest, and it cannot
tell you which of its rows an acknowledged erratum has already invalidated. Those three are the
gaps that would make a contract quietly wrong, and each has a measured size: 1.69%, 166/166, and
27 acknowledged errata with no index.

So: **the tool earns "the most complete evidence-first RFC tool" and does not earn "the most
complete RFC tool."** The first is a claim about epistemics and it is true. The second is a claim
about coverage, currency and correctness-under-correction, and on those it is behind
`trentmilam/agentic-rag` (corpus-wide, 5 061 errata, revision-aware), behind the IETF's own
`Rfc-Errata` (errata actually applied), and behind an LLM reading the same text (AICCE, 0.998
accuracy on IPv6 compliance via executable rule synthesis). The most valuable thing this project
could do next is not a feature: it is to ingest the corpus, add the erratum→row index, and close
B1 — after which the evidence model becomes an advantage no alternative has, rather than an
advantage applied to 166 documents.
