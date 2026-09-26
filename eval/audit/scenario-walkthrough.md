# Scenario walkthrough: RFC → normative compliance contract → implementation

Adversarial audit. Every measurement below was taken through `tools.rfc.*` only, on the
live corpus (`corpus_id rfc-mcp:9a3591827422`, `index_generation` 1953 → 1963 during the
walk, `parser rfc-text-1.7.3`, `extractor normative-2119-8174-1.6.3`, server 0.5.3).
Byte figures are `JSON.stringify(response.data).length` — the payload the caller pays for,
excluding the MCP envelope. Wall clock is `Date.now()` around the tool call on this host.

Severity: **S1** silently yields a _wrong_ contract · **S2** stalls the scenario ·
**S3** friction/cost · **S4** cosmetic.

---

## 0. The five documents, and why these five

| slot                 | document                    | bytes   | pages | sections | strict requirements | what it stresses                                                             |
| -------------------- | --------------------------- | ------- | ----- | -------- | ------------------- | ---------------------------------------------------------------------------- |
| Mail / SMTP          | **RFC 5321**                | 225 929 | 95    | 137      | 355                 | modern prose + ABNF + appendix transcripts; 211 rejected candidates          |
| Routing              | **RFC 2328** OSPFv2         | 524 985 | 244   | 112      | **0**               | protocol state machine, TLV/table-driven, 1998 typeset-indent era            |
| TLS                  | **RFC 8446** TLS 1.3        | 337 736 | 160   | 98       | 427                 | crypto state machine, IANA registry appendices                               |
| 1980s typeset        | **RFC 959** FTP             | 147 316 | 69    | 49       | **1**               | the `page_furniture` / `underlined_headings` repair; 39 % unscannable blocks |
| Modern, table-driven | **RFC 9110** HTTP Semantics | 502 941 | 194   | 303      | 408                 | 303 sections, 55 table blocks, BOM in source                                 |

Deliberate choices, not convenience:

- **959 over 768 / 792 / 1122 / 1123.** The prompt suggested those. 768 and 792 are short
  and now parse; 1122/1123 are the documents the CHANGELOG cites as _fixed_ by the indent
  repair, so walking them would only re-confirm the changelog. 959 is the hardest member of
  that family: 610 blocks of which **238 (39 %) are unscanned**, 217 of them `preformatted`,
  and the whole of its normative content lives in them. I did also exercise 854 (1983) and
  2178 (1991) as controls.
- **2328 as the routing slot** rather than BGP. OSPF's §10–§12 are pure LSA tables and §16
  is a TOS metric table, which is the exact failure mode I wanted: a spec whose obligations
  are tabular.
- **5321 doubles as a table document**, so the modern table slot went to 9110 — 303
  sections, more than twice 5321's, and a BOM at byte 0.
- I did **not** substitute anything after the fact. Every one of the five failed something.

Corpus note: 125 of the 165 ingested documents have requirements. All five of mine are in
that set, so nothing here is an artifact of an un-ingested document.

---

## 1. "I know the protocol, not the RFC number"

I typed the strings a person actually types. `search` with default `scope: "auto"`.

```
search({query: "SMTP"})                            213 ms  catalog  54 hits
search({query: "OSPF"})                             56 ms  catalog  97 hits
search({query: "TLS 1.3"})                          48 ms  catalog  22 hits
search({query: "File Transfer Protocol"})           66 ms  catalog  28 hits
search({query: "Hypertext Transfer Protocol")       52 ms  catalog  22 hits
```

**Every one of these resolves to `scope: "catalog"`.** Catalog search covers titles,
abstracts, keywords, authors, status, stream over all 9 842 documents. Fast, 48–213 ms.
That part is good.

### Where the canonical document lands

I paged each query to exhaustion and recorded the position of the standard:

| query I typed                 | standard I meant | rank         | score | leader                                                 | leader score |
| ----------------------------- | ---------------- | ------------ | ----- | ------------------------------------------------------ | ------------ |
| `SMTP`                        | **5321**         | **54 of 57** | 4.25  | 3207 "SMTP Service Extension for Secure SMTP over TLS" | 6.83         |
| `OSPF`                        | **2328**         | **2 of 97**  | 6.20  | 4973 "OSPF-xTE: Experimental Extension…"               | 6.47         |
| `TLS 1.3`                     | **8446**         | **18 of 22** | 8.63  | 9190 "EAP-TLS 1.3: Using the EAP…"                     | 13.08        |
| `File Transfer Protocol`      | **959**          | **28 of 28** | 6.99  | 542 "File Transfer Protocol" (1973 draft)              | 13.31        |
| `Hypertext Transfer Protocol` | **9110**         | **20 of 22** | 8.89  | 7235 "HTTP/1.1: Authentication"                        | 14.38        |

**Miss rate for the canonical document: 1 of 5 in the top 5, 2 of 5 not in the top 10, 4 of 5
not in the top 3, and 2 of 5 in the bottom 5 of their result set.** Two of them (5321, 959)
are the _only_ document in the corpus carrying that protocol's name in its title and they
land last.

This is not a relevance judgement, it is a scoring defect, and here is the proof: the title
string is identical, and the scores are not.

```
search({query: "Simple Mail Transfer Protocol", max_results: 20})
  788  :17.29  title="Simple Mail Transfer Protocol"
  2821 :17.08  title="Simple Mail Transfer Protocol"
  821  :15.36  title="Simple Mail Transfer Protocol"
  5321 : 8.77  title="Simple Mail Transfer Protocol"     <-- the standard
```

Four documents with the byte-identical title, `match_field: "title"` on all four, scores
15.36–17.29 for three of them and **8.77** for the one that is actually in force. The
ranking is not discriminating on the matched field; something else is dominating. A caller
has no way to see what.

The same thing on exact-title queries, which is the point at which the ranking looks like it
should be trivially right:

```
search({query: "Open Shortest Path First"})                            -> 2328 at 1 of 2
search({query: "Simple Mail Transfer Protocol"})                       -> 5321 at 8 of 10
search({query: "The Transport Layer Security (TLS) Protocol Version 1.3"})
                                                                      -> 8446 at 2 of 2
```

8446 loses its **own exact title** to RFC 9190. Four of five canonical documents are
demoted by a query that names them exactly.

### The documented remedy makes it worse and does not do what it says

`capabilities` and the tool description both offer `ensure_top_catalog_hits` for exactly
this: _"the catalog proposes the numbers and the server ingests them and reports their
titles, which is safer than guessing a number and reading the wrong document."_

```
search({query: "Simple Mail Transfer Protocol", ensure_top_catalog_hits: 3, max_results: 20})
  -> 8 277 ms
  -> warnings: ["ingested_top_catalog_hits:788,821,2821"]
  -> data keys: ["scope","hits","total","corpus"]     <-- no `ensured`, no titles
```

Three findings in one call:

1. **It reports no titles.** The promise is "ingests them and reports their titles". The
   only trace is the string `ingested_top_catalog_hits:788,821,2821` in `warnings` — bare
   numbers, no titles, no field. I had to call `resolve` three times to learn I had just
   spent 8.3 s ingesting two obsolete SMTP drafts.
2. **It picked the wrong three.** 788 (a 1980 mailing-list memo) and 821 (the 1982 draft
   SMTP) over 5321. It followed the ranking that is the problem.
3. **It mutated the corpus.** `corpus.documents` went 159 → 9842, `index_generation`
   1953 → 1956, `last_successful_sync` advanced, and `status()` afterwards reported
   `snapshots: 165, with_requirements: 128`. A read-only scenario walk wrote to the index.
   `corpus.documents` now reports two different things (159 then 9842) in two responses of
   the same shape.

**And the search score is a function of that mutation.** Identical query, before and after
my own ingests:

```
"Simple Mail Transfer Protocol"   before: 821:17.32 (3rd)   after: 821:15.36 (4th)
                                  before: 2487 unseen     after: 2487:6.74 (10th)
"SMTP"                            before: 2487:7.75 (1st) after: 3207:6.83 (1st)
```

The tool is internally deterministic — three back-to-back runs of the same query return
byte-identical score lists. But `search` is the **only tool in the set with no
`snapshot_id` parameter and no way to pin anything**, and its output moves when an
unrelated `resolve` or `ensure_top_catalog_hits` lands. A test that asserts a rank is
asserting a property of corpus state, not of the tool.

### Is a miss distinguishable from "no such thing"?

**No. This is the sharpest defect in step 1.**

```
search({query: "zzqq nonexistent protocol foobarbaz", max_results: 20})
  status:   "ok"
  total:    0
  hits:     []
  warnings: ["no_text_match",
             "text_search_covers_ingested_documents_only:ingested=159,catalog=9842,
              resolve_the_rfc_first_or_pass_ensure_rfcs"]
  corpus.coverage: "ingested_text_only:159/9842"
```

The search that actually ran was over the **titles and abstracts of all 9 842 catalog
documents**. The response reports `no_text_match`, names the _text_ index, and states
coverage as `ingested_text_only:159/9842`. A caller reading `coverage` concludes "this term
is absent from 159 of 9 842 documents" and draws the wrong conclusion about the corpus.
The field that exists to prevent exactly that inference names the wrong scope.

Worse, the same query against a document I _had just ingested_ returns the same shape:

```
search({query: "\"interpreted as described in RFC 2119\" rfc:2328", scope: "text"})
  total: 0
  warnings: ["no_text_match", "text_search_covers_ingested_documents_only:ingested=169,..."]
  coverage: "ingested_text_only:169/9842"
```

2328 is ingested (I had resolved it 30 s earlier, `inbound_relations` and all), and the
phrase is not in it — but I cannot tell that from "not in any of the 169". Contrast the
catalog scope, which _does_ distinguish: `search({query:"MUST keyword:MUST rfc:5321",
scope:"catalog"})` returns `total: 0` with `warnings: ["no_catalog_match"]`. The
miss signal exists in catalog scope and is wrong in text/auto scope.

### What search does well

- `rfc:` filter works in text scope. `search("ServerHello rfc:8446", scope:"text")` → 57
  hits, all 8446. Without it, 102 hits all 8448. Clean positive control.
- `section:` filter works. `search("MUST section:4.1.3 rfc:8446", scope:"text")` → 12 hits.
- Text hits are citable. Hit shape: `document_id, rfc, title, snapshot_id, section_id,
section_path, block_id, match_field, snippet, highlight_spans, citation_id, score`. A
  text hit carries a `citation_id` that `verify_citation` accepts, plus `section_path` and
  `block_id`. That is the right shape and it is better than most of what follows.
- Boolean `OR` / `AND` / `NOT` and quoted phrases are documented honestly, including the
  warning that lower-case `or` is a word.
- Prose keyword search works: `search("quoted-printable")` → 23 text hits, all RFC 2045, the
  document a person means. `search("session ticket")` → 72 text hits across 9001, 4120, 8447.

**First point of failure, step 1, all five documents: I cannot find the document I want by
naming the protocol.** Not "the ranking could be better" — for 5321 and 959 the standard is
the _last_ result for a query that is its exact title.

---

## 2. "I have the document. What is its current status?"

`resolve` returns the full document record inline. This step is the best-served step in the
whole tool.

```
resolve({rfc: 959})   17 ms   resolve({rfc: 2328})  3 848 ms  (not cached; upstream fetch)
resolve({rfc: 5321})  20 ms   resolve({rfc: 8446})     18 ms
resolve({rfc: 9110})  24 ms
```

One call, 2 762–3 400 bytes, and it carries `obsoletes`, `obsoleted_by`, `updates`,
`updated_by`, `status{name,slug}`, `stream`, `area`, `group`, `subseries`, `doi`,
`canonical_url`, `content_hash`, plus a `snapshot` block with `raw_sha256`, `bytes`,
`parser_version`, `extractor_version`, `quality`, per-document `warnings`,
`section_count`, `block_count`, `requirement_count`, `prose_block_count`,
`unscanned_block_count` and `unscanned_block_kinds`. **No second call is needed to know
whether a document is current.** That is a real strength and it is what I expected the tool
to be bad at.

| document | status                     | obsoletes        | obsoleted_by | updates    | updated_by  |
| -------- | -------------------------- | ---------------- | ------------ | ---------- | ----------- |
| 5321     | draft standard             | 2821             | —            | 1123       | 7504        |
| 2328     | internet standard (STD 54) | 2178             | —            | —          | 8 documents |
| 8446     | proposed standard          | 5077, 5246, 6961 | **9846**     | 5705, 6066 | —           |
| 959      | internet standard (STD 9)  | 765              | —            | —          | 6 documents |
| 9110     | internet standard (STD 97) | 9 documents      | —            | 3864       | —           |

**8446 is correctly self-identifying as obsoleted by 9846**, in the same call, with no
extra request. That is the case the step exists for and it works.

### The 854 test

The prompt asks whether a caller can tell, from a single response, that they are reading an
obsolete document. I ran the live case.

```
resolve({rfc: 854})
  title:       "Telnet Protocol Specification"
  status:      { name: "internet standard", slug: "std" }
  subseries:   [{ type: "std", number: 8, label: "STD 8" }]
  obsoletes:   [764]
  obsoleted_by: []
  updated_by:  [5198]
  warnings:    ["snapshot_resolved_from_upstream", "parse_quality_degraded"]
```

```
metadata({rfc: 854, include: ["relations"]})
  relations.obsoletes:    ["Telnet Protocol specification"]   <-- a TITLE, not a number
  relations.obsoleted_by: []
  relations.updated_by:   ["Unicode Format for Network Interchange"]
  relations.datatracker:  []
  warnings: ["snapshot_not_explicitly_pinned"]
```

Three things wrong here, and the third is the important one.

1. **Two representations of the same relations, keyed differently, neither cited.**
   `document.obsoletes: [764]` and `relations.obsoletes: ["Telnet Protocol specification"]`
   are the same fact; the second has lost the RFC number and gained a title. A caller must
   know to read one and not the other. Neither carries a citation id, a byte offset, a date,
   or a source.
2. **`relations.datatracker: []`** for both 854 and 5321. The `dependencies` tool's own
   description promises inbound relations "from the IETF Datatracker". There are none, and
   the empty array is indistinguishable from "not fetched".
3. **`status: "internet standard"` and `STD 8` are asserted, positively, for a 1983
   document that the tool elsewhere tells me was superseded.** The _field a caller would
   check_ says current. Only the empty `obsoleted_by` and the "internet standard" label
   disagree, and a caller checking `status` gets the wrong answer.

I then asked the graph the same question, and it agrees with `resolve` rather than
contradicting it:

```
dependencies({rfc: 854, direction: "both"})
  nodes: 854, 764, 5198
  edges: 854 -obsoletes-> 764      evidence: null
         854 -updated_by-> 5198   evidence: null
  warnings: ["inbound_relations_truncated_at_170", ...]
```

`dependencies` is described as _"Typed, bounded graph… **Every edge carries evidence**"_.
Every `cites_*` edge does. **Every `obsoletes` / `obsoleted_by` / `updates` / `updated_by`
edge has `evidence: null`** — across all five documents. The edges that answer "is this
document current" are the only class with no evidence at all. An engineer cannot distinguish
"I checked and it is current" from "I have no data on this relation".

And the 170 inbound relations the warning names are **unreachable**: `max_nodes: 200` and
`max_edges: 500` are accepted by the schema but `capabilities.limits` caps the graph at 100
nodes / 200 edges, there is no cursor on `dependencies`, and `data.truncated` is `false`
while the warning says 170 were dropped.

**First point of failure, step 2:** not visibility — `resolve` is the best step in the tool.
It is that the obsolescence edges are the only edges with no evidence, and that `status`
actively asserts currency for a document the tool knows has been superseded.

---

## 3. "What does it require?"

Page `requirements` to exhaustion at `max_results: 200` (the advertised ceiling).

| document  | calls  | bytes         | requirement rows | wall clock | `coverage.total_requirements` | `keyword_bearing_blocks_skipped` |
| --------- | ------ | ------------- | ---------------- | ---------- | ----------------------------- | -------------------------------- |
| 959       | 1      | 204 636       | **1**            | 288 ms     | 1                             | 0                                |
| 2328      | 1      | 389 425       | **0**            | 585 ms     | 0                             | 0                                |
| 5321      | 2      | 1 559 097     | 355              | 4 473 ms   | 355                           | 1                                |
| 8446      | 3      | 2 180 036     | 427              | 7 908 ms   | 427                           | 3                                |
| 9110      | 3      | 1 924 716     | 408              | 2 626 ms   | 408                           | 4                                |
| **total** | **10** | **6 257 910** | **1 191**        | **15.9 s** |                               |                                  |

**To enumerate one document's requirements: 1–3 calls, 205 KB – 2.18 MB.** The contract in
`capabilities.limits` advertises `maxOutputBytes: 16384`. The default `requirements` page
is **2.18 MB — 133× the advertised output bound**, and `maxOutputBytes` is documented as
enforced and to apply to `read`. There is no bound at all on `requirements`, and no way to
learn the size before paying for it.

### Where the 2.18 MB goes

```
requirements({snapshot_id: <8446>, max_results: 200})            →  808 169 B
  requirements:           200 rows   242 982 B
  mentions:               421 rows   352 840 B   (44 %)
  non_strict_candidates:  211 rows   209 151 B   (26 %)
  coverage + document + interpretation:              2 353 B
```

Two documented, defaulted-`true` booleans shrink the same page 3.3×:

| configuration               | bytes       |
| --------------------------- | ----------- |
| default                     | 808 169     |
| `include_candidates: false` | 598 993     |
| `include_mentions: false`   | 455 317     |
| both `false`                | **246 141** |

Lean totals for the three documents with real requirement lists: 5321 = 2 calls / 435 041 B,
8446 = 3 / 518 699, 9110 = 3 / 536 037. **1.49 MB instead of 5.66 MB.** That is a 74 %
saving available from two documented flags — but the default is 3.3× larger and the response
never says so.

**`mentions` are not paged.** 421 identical rows on page 1 and page 2 of 5321; 478 on each
of 8446's three pages; 431 on each of 9110's. A caller who sums `mentions.length` across
pages double- and triple-counts. I did exactly that on the first pass and had to correct
myself: the true per-document figures are 421 / 478 / 431, not 842 / 1 434 / 1 293.

**First point of failure, step 3, RFC 959 and RFC 2328: there is nothing to enumerate.**
Details in §4 and §9; the numbers are 1 and 0.

### Rows a human would keep

The strict rows are much better than I expected once you read them. `flags` is a real
triage vocabulary — 6–8 distinct values, consistently populated:

| flag                               | 5321       | 8446       | 9110       |
| ---------------------------------- | ---------- | ---------- | ---------- |
| `multiple_terms_in_sentence`       | 44         | 45         | 22         |
| `keywords_collapsed_to_one_row`    | 44         | 45         | 22         |
| `in_appendix`                      | 33         | 50         | **0**      |
| `actor_not_explicit`               | 18         | 5          | 12         |
| `list_marker_stripped_from_clause` | 8          | 23         | 9          |
| `action_not_explicit`              | 1          | 1          | 0          |
| `requirements_notation_section`    | 0          | 0          | 6          |
| `exception_before_keyword`         | 0          | 0          | 2          |
| `parse_status != "complete"`       | 19         | 6          | 12         |
| `clause.actor == null`             | 18         | 5          | 12         |
| `clause.condition == null`         | 281 (79 %) | 323 (76 %) | 345 (85 %) |

Rows the tool itself marks as needing work (partial parse, no explicit actor, no explicit
action, appendix): 5321 ≤ 71 of 355 (80 % keep), 8446 ≤ 62 of 427 (85 % keep), 9110 ≤ 30 of
408 (93 % keep). Plus 44/45/22 rows that carry more than one obligation in one sentence and
must be split by hand. `confidence` takes exactly two values, 0.9 and 0.7 — one bit, not a
quality signal. Duplicate-sentence rows: 0 / 6 / 12.

**`in_appendix` is applied inconsistently and that makes it unusable as a filter.** 8446
flags 50 appendix rows, 5321 flags 33, and **9110 flags 0** — a document with 303 sections
and appendices B (Status Codes), C (IANA Registries), D (Collective Headers), E
(Hypothetical Extensions), F (Features and Protocols). A caller excluding appendix
obligations gets 50 rows from 8446 and 0 from 9110. The flag is a per-document parse
artefact, not a property of the row.

**The real junk is on the other side of the fence.** For 5321 the rejected-candidate set is
186 rows under the tool's own recommended filter (`role=modal AND shape=demand`, described
as _"the set that can state an obligation"_), and the top of the ranking is:

```
#1  keyword "MAY" upper  reason non_prose_block
    "Local-part     = Dot-string / Quoted-string
                      ; MAY be case-sensitive"          §4.1.2
#2  keyword "May" title
    "S: 220 foo.com Simple Mail Transfer Service Ready
      C: EHLO bar.com
      C: Date: Thu, 21 May 1998 05:33:29 -0700
      ..."                                             Appendix D
#3  keyword "May" title
    "... C: Date: Thu, 21 May 1998 05:33:22 -0700 ..." Appendix D
```

**Rank 1 is an ABNF grammar comment. Ranks 2 and 3 are example session transcripts whose
only keyword is the month in a 1998 timestamp.** All three are `role: "modal"`,
`shape: "demand"`, `citation_id` present, `verified`. 13 of the 186 are Appendix D
transcripts; 7 begin mid-sentence, including

```
"o  optional replacements for commands defined in this protocol, such
   as for DATA in non-ASCII transmissions (RFC 3030 [20])."
```

which starts mid-word (`Als`**`o`**) — the splitter cut inside a token and the result is
still ranked a modal demand.

**`reason`, the one field that says _why_ a row was rejected, is null on 185 of 186.** There
is no per-row "this is not a requirement" marker. `keyword_case` is the only discriminator
(`upper: 1, title: 2, lower: 183`) and `title` is the case that catches dates.

---

## 4. "I need the MUSTs for the handshake path"

Base: `requirements({snapshot_id: <5321>, max_results: 200, include_mentions: false,
include_candidates: false})`.

```
term: "MUST NOT"                                  56 rows   246 ms
term: "MUST NOT" + scope: "4"                     25 rows    88 ms
term: "MUST NOT" + scope: "4" + keyword: "relay"   2 rows   247 ms
scope: "4.1.1.1"                                    7 rows   198 ms
term: "SHALL"                                      0 rows   144 ms
```

**Filters compose, prefix matching on `scope` works, and the negative filters return
nothing rather than everything.** `term: "MUST NOT" + scope: "4" + keyword: "relay"` narrows
56 → 25 → 2 and each level is echoed in `coverage` (`section_filter`, `term_filter`,
`keyword_filter`). `scope: "4.1.1.1.1"` (nonexistent) → 0 rows, `next_cursor: null`. That is
the behaviour the prompt asked me to confirm, and it holds. `coverage.total_requirements`
is post-`term`, pre-`keyword`, which is subtle but consistent.

Then four things broke.

### 4a. `term` is case-insensitive and reports the string you gave it

```
term: "MUST NOT"  ->  56 rows, coverage.term_filter: "MUST NOT"
term: "must not"  ->  56 rows, coverage.term_filter: "must not"   (identical row ids)
```

RFC 8174 §3: an uncapitalised keyword has no normative force. The tool's own
`non_strict_candidates.note` says exactly that, at length, in every response. And then
`term: "must not"` returns 56 upper-case MUST NOT rows while `coverage.term_filter` reports
`"must not"`. The response asserts it applied a filter it did not apply. A test asserting
`coverage.term_filter === "must not"` passes while the returned rows are the opposite
capitalisation. The tool description calls it an "Exact keyword filter"; it is not exact and
it is not case-sensitive, and it is undocumented in both respects.

`term: "MUSTT"` — not a keyword at all — returns 0 rows, `term_filter: "MUSTT"`, **no
warning that the term is not an RFC 2119 keyword.** A typo and a section with no
requirements look identical.

### 4b. `role` and `shape` are silent no-ops on the requirement list

```
role:  "modal"     + include_candidates: false  ->  200 rows of 355, unfiltered
shape: "description" + include_candidates: false -> 200 rows of 355, unfiltered
```

`coverage` has `section_filter`, `term_filter` and `keyword_filter`. It has **no
`role_filter` and no `shape_filter`.** With candidates suppressed, the filters leave no
trace at all: the call succeeds, returns 200 rows, and nothing in the response says they
were ignored.

With candidates included, the echo lives at `non_strict_candidates.filters.{role,shape}`
and the note text changes from _"No candidate filter applied"_ to _"Filters are applied
server-side"_ — a real signal, but only on the other side of a defaulted-`true` boolean that
costs 209 KB. So: **the only way to learn that a filter was applied is to pay 26 % more for
the data you did not ask for.**

This is a direct violation of a stated guarantee. `capabilities` and the `search`
description both promise: _"A filter that the chosen scope cannot honour is reported in
warnings, never dropped silently."_ `search` honours it (`no_catalog_match`);
`requirements` does not.

**There is also no filter for the thing the step actually asks for.** "The MUSTs for the
handshake path" is a question about _actor_. `clause.actor` is extracted on every row
("The server", "A sender", "the server's share", "capable clients discussed above") and
**there is no `actor` parameter**, no `strength` parameter, no `polarity` parameter. The
clause split is computed, returned, and not queryable. To get the client-side MUSTs out of
8446 I would fetch 427 rows and filter 427 rows in the caller.

### 4c. `next_cursor` is returned on an empty page

```
keyword: "zzzznotpresent"  ->  0 rows, total_requirements: 355, next_cursor: "eyJ..."
                               page 2 of the same query -> 0 rows, next_cursor: null
```

A `while (cursor)` pagination driver executes one wasted call per empty filter and, because
`coverage.returned: 0` and `coverage.total_requirements: 355` sit side by side, has to guess
which one to believe.

### 4d. A scope typo is an empty contract, with no signal

```
scope: "99.99.99"   -> 0 rows, section_filter: "99.99.99", no warning
scope: "4.1.1.1.1"  -> 0 rows, section_filter: "4.1.1.1.1", no warning
scope: "Appendix D" -> 0 rows, section_filter: "Appendix D", no warning
```

Three different worlds — a section that does not exist, a section deeper than any heading
level, and a section that exists and has no requirements — are byte-identical responses
with `status: "ok"`. **An engineer who fat-fingers a section number gets a successful,
empty, unwarned result and a contract with a silent hole in it.** This is the S1 case at the
filter level.

### 4e. RFC 2328: the filter that could not help, because there is nothing to filter

```
requirements({snapshot_id: <2328>, max_results: 200})
  requirements:             []
  coverage.total_requirements: 0
  coverage.blocks_scanned:  1425
  coverage.prose_blocks_scanned: 875
  coverage.blocks_skipped:  550
  coverage.blocks_skipped_by_kind: {preformed:164, table:17, section:references:367, ...}
  coverage.keyword_bearing_blocks_skipped: 0
  warnings: ["candidates:candidate_sections_skipped:78",
             "zero_or_few_requirements_but_422_non_strict_candidates:read_non_strict_candidates"]
```

**RFC 2328 is a 244-page Internet Standard (STD 54) that defines a link-state routing
protocol, and the strict requirement list is empty.** Meanwhile the response asserts, in a
typed field, `keyword_bearing_blocks_skipped: 0` — with the explanatory note attached:

> _"keyword_bearing_blocks_skipped is how many of them carry an RFC 2119 keyword, so a low
> total_requirements on a table-driven specification reads as a known gap rather than an
> absence."_

The note promises that this number tells you whether a low count is a gap. The number is 0. The note tells you to read 0 as "not a gap". **OSPF's LSA format sections, its LSA-type
registry and its TOS metric table are all inside the 550 skipped blocks, and the tool
positively certifies that none of them contains a keyword.** 422 rejected candidates exist;
78 sections' worth of candidates were skipped and the only record is a warning string.

I asked the tool whether OSPF adopts RFC 2119 — the question the tool itself nominates as
the thing that makes a zero explicable:

```
"keyword_usage" in response.data  ->  false     (present for 5321, 8446, 9110)
```

**`keyword_usage` is absent for exactly the two documents where a zero needs explaining**
(959: 1 requirement, 2328: 0). The tool description says `keyword_usage` _"states whether
the document disclaims or adopts the requirement language, which is what makes a zero
explicable."_ For 5321 it returns `stance: "adopts"` with the exact notice text, a span and
a citation id — and then adds `meaning: "The document adopts RFC 2119 / RFC 8174, so a low
requirement count is the surprising outcome."` For 2328 there is nothing. A test can assert
`total_requirements === 0 && keyword_bearing_blocks_skipped === 0`, which for OSPF means
"OSPF states no requirements and I checked". That is the worst available combination.

### 4f. RFC 959: one row, and it is a fragment

```
requirements({snapshot_id: <959>, max_results: 200})  ->  1 row, 288 ms, 204 636 bytes
  exact_text: "The server\n      MUST close the data connection under the following
               conditions:"
  clause:  { actor: "The server", condition: null,
             action: "close the data connection under the following conditions",
             exception: null }
  parse_status: "complete", confidence: 0.9, flags: []
  section: "3.2", citation_id: "cit_9ed255775ae5527af92169fc"
```

**RFC 959 is a 69-page Internet Standard (STD 9) whose entire content is the protocol, and
the tool produces one obligation from it** — at 204 636 bytes per call, the most expensive
single row in the walk. 238 of 610 blocks (39 %) are unscanned, 217 of them preformatted,
and `keyword_bearing_blocks_skipped: 0`.

The one row it does return is a **dangling colon**. The conditions are in the list that
follows. `clause.condition: null`, `clause.exception: null`, `parse_status: "complete"`,
`confidence: 0.9`, `flags: []`. Rendered as a contract line: _"The server MUST close the
data connection."_ **Unconditionally, with no trigger.** The RFC's actual obligation is
conditional on a four-item list immediately below. Nothing on the row says the sentence is
incomplete — the flags array is empty and the parse status is `complete`.

That is the whole audit in one row: the tool is confident, citable, unverifiable-as-to-
completeness, and wrong in the specific direction that produces a wrong implementation.

---

## 5. "This row is a fragment / the wrong actor / the wrong section"

### Fields that do the work

| field                                       | presence            | what it tells you                                         |
| ------------------------------------------- | ------------------- | --------------------------------------------------------- |
| `parse_status`                              | 100 % (1 191/1 191) | `complete` (1 153) / `partial` (37)                       |
| `confidence`                                | 100 %               | exactly two values, 0.9 and 0.7                           |
| `clause.{actor,condition,action,exception}` | 100 %               | `null` on 18/281, 5/323, 12/345                           |
| `flags[]`                                   | 100 %               | 8 distinct values, see §3                                 |
| `span`                                      | 100 %               | char / byte / codepoint / line, all four                  |
| `section`                                   | 100 %               | `"4.1.1.1"`, `"Appendix D"`, `"Requirements Notation"`    |
| `disposition`                               | 100 %               | `requirement`                                             |
| `role`, `shape`                             | **0 %**             | absent on every strict row (documented as candidate-only) |

`flags` is a genuinely good vocabulary and it is populated on every row.
`actor_not_explicit`, `action_not_explicit`, `list_marker_stripped_from_clause`,
`multiple_terms_in_sentence`, `exception_before_keyword`, `in_appendix`,
`requirements_notation_section`. With one hole: **`in_appendix` is 0 on 9110's 408 rows**
(§3), so it cannot be trusted as a filter.

9110's `requirements_notation_section: 6` is doing exactly the right thing: those six rows
come from §2.2 _Requirements Notation_, which is boilerplate about the document, and they
are flagged. Except the flag is **duplicated in the array** — I have a row whose `flags` is
literally `["requirements_notation_section","requirements_notation_section"]`. `.includes()`
works; `.filter(f => f === x).length` returns 2. S4.

### The field that lies: `span`

`verify_citation` returns a _different span_ from the requirement row, for the same
citation, and nothing labels which is which.

```
959 §3.2 requirement row:  span.char_start 42144  char_end 42223   byte_start 42144
959 same citation, verify:  locator.span.char_start 42012  char_end 42223  byte_start 42012
```

`char_end` agrees, `char_start` differs by 132. The row's span is the _statement_; the
verify locator's span is the _block_ the statement lives in. There is no `span_kind` on
either side. A caller who stores `row.span.byte_start` and later asserts
`verify_citation(...).locator.span.byte_start === row.span.byte_start` fails, and has no way
to know whether the tool or the caller is wrong.

And the human-readable note compounds it:

```
verify_citation(...) -> notes: ["quote matches bytes 42012..42223 (lines 1033..1035)"]
```

The quote is 78 characters. 42012..42223 is 211 bytes. **The note cites the block range and
calls it the quote's range.** That string is exactly what an engineer pastes into a ticket.
I saw the same shape on 8446 and 9110.

On 9110 the byte and char offsets differ by 2 (BOM), correctly reported as separate fields —
`char_start: 23144, byte_start: 23146` in the row, `char_start: 23141, byte_start: 23143` in
the verify. That part is right.

### Wrong section

`section` is a display string on the row and the outline's `number` field is **not always a
number**. For 2328, 112 outline entries, 105 numeric, 7 not:

```
number: ""                      kind: front_matter
number: "Status of this Memo"   kind: status
number: "Copyright Notice"      kind: status
number: "Abstract"              kind: status
number: "References"            kind: references
number: "Author's Address"      kind: authors
number: "Full Copyright Statement" kind: status
```

Front matter, status notices, references and the author address are in the same array, in
the same `number` field, as §1. A caller enumerating "all sections" to read the document
gets 7 non-sections in the list and no flag beyond `kind`.

And all 112 outline rows have `text: ""` — a 64 787-byte response in which every row is
empty. The outline tells you the document has 112 sections and gives you none of them.

---

## 6. "I must cite this in a ticket"

**This is the best step in the tool, and the one place where I could not manufacture a
failure.**

```
verify_citation({snapshot_id: <959>, citation_id: "cit_9ed255775ae5527af92169fc"})   123 ms
verify_citation({snapshot_id: <8446>, citation_id: "cit_0366643c25f5b790bc2761eb"})   39 ms
verify_citation({snapshot_id: <9110>, citation_id: "cit_2ce989d597ca37e2d7a053b5"})   70 ms
```

Each returns, in one call:

```json
{ "verdict": "verified",
  "matches": [{
    "citation_id": "cit_0366643c25f5b790bc2761eb",
    "document_id": "rfc-8446",
    "snapshot_id": "snp_bafd768dd7810726d9947fe0",
    "source_uri": "https://www.rfc-editor.org/rfc/rfc8446.txt",
    "locator": { "section_path": ["2", "Protocol Overview"],
                 "block_id": "blk_e0f2b0e58562d74bb975cff1",
                 "span": { byte/char/codepoint/line … } },
    "quote": "If (EC)DHE key establishment is in use, then the ServerHello contains…",
    "quote_sha256": "sha256:f3728a83…",
    "observed_at": "2026-09-26T02:35:18.093Z" }],
  "notes": ["quote matches bytes 25074..25906 (lines 636..647)"] }
```

**It gives me back the text I verified**, byte-exact, with a hash, the full section path
(`["3","2","ESTABLISHING DATA CONNECTIONS"]` on 959 — the typeset-era section title came
through the `underlined_headings` repair and is citable), the source URL, and a human note.
I can paste that into a ticket. I also verified that a 8446 citation id submitted against
5321's snapshot returns `not_found` / `degraded`, and that a hand-built locator
(`block_id` + `char_start` + `section`) synthesises a fresh `cit_block_…` id and verifies.

Four defects:

**6a. Two answers to the same question.** The quote verifies `verified` by `citation_id`.
Verify the same quote by its hash and the tool disagrees with itself:

```
verify_citation({quote_sha256: "sha256:f3728a83…"})                     -> not_found  (0 matches)
verify_citation({quote_sha256: "sha256:f3728a83…", rfc: 8446})
                                                     -> "ambiguous", status "partial"
                                                        notes: ["2 stored records match;
                                                                 a locator is required to
                                                                 disambiguate"]
```

A hash alone locates nothing, even though the quote is in the corpus. With the document
supplied it is _ambiguous_ — two stored records hold that hash — so the hash path is
unusable for re-verification from a ticket, which is the one thing a ticket needs.

**6b. No second derivation exists, so "verify it tomorrow against a different derivation"
is not a question this tool can answer.**

```
resolve({rfc: 8446})              -> snp_bafd768dd7810726d9947fe0
resolve({rfc: 8446, refresh:true})-> snp_bafd768dd7810726d9947fe0   (identical)
   raw_sha256 identical; warnings: ["served_after_conditional_revalidation", …]
```

Each document has exactly one derivation, `resolve(refresh)` 304s on the upstream ETag and
returns the same id, and there is no API to re-derive under a different parser or extractor
version. Cross-verification against an independent derivation is not offered, and — worth
saying plainly — `observed_at` on the match is the _snapshot's_ `retrieved_at`, not the
time of verification, so even "when was this checked" is not in the response.

**6c. No `char_end`.** `verify_citation` takes `char_start` with no `char_end`. I passed
the requirement's `char_start: 25401` and got back the **whole 832-byte block** starting at
25074, with a `quote` that does not begin where I asked. Given a bug-report excerpt and a
char offset and nothing else — no stored citation — I cannot verify it. The verification API
only speaks in whole blocks and stored ids.

**6d. For RFC 2328 the entire step is unreachable.** Zero requirement rows, zero mentions,
`non_strict_candidates` with no `citation_id` on a strict row because there are none. I have
nothing to cite for a 244-page Internet Standard.

---

## 7. "I need to know what this row depends on"

**The question cannot be asked. Neither tool has a section parameter.**

```
references(input:  rfc | snapshot_id, relation, resolution, label, max_results, cursor, include_cited_by)
dependencies(input: rfc | snapshot_id, direction, depth, max_nodes, max_edges, include_inferred, refresh*)
```

A requirement row carries `section_id: "sec_e5764a6f8de29dfc1c6ea78c"` and
`section: "2.1"`. **Nothing accepts either.** There is no way to ask "what does §2.1 of 5321
depend on". I can get the document's references and filter client-side, or I can get the
document's graph — but neither is scoped to a section, and the prompt's question has no
API.

### Is the graph cited back to bytes? No.

```
dependencies({snapshot_id: <5321>, direction: "outgoing", max_nodes: 20, max_edges: 20})
  edge: { from: "doc:rfc-5321", to: "doc:rfc-821", type: "cites_normative",
          relation: "1",
          evidence: { source: "rfc_references", url: null,
                      observed_at: "2026-09-26T05:22:58.393Z" } }
```

Three evidence keys, and `url` is `null`. No byte offset, no char offset, no
`citation_id`, no section, no label anchor. `relation: "1"` is the reference _number_, so
getting to bytes means a second `references` call and a manual join on `label`.

### `references` works well, and has one silent trap

```
references({snapshot_id: <5321>, relation: "normative", max_results: 6})   ->  total 11
references({snapshot_id: <5321>, max_results: 6})                          ->  total 47
dependencies(5321, outgoing) cites_normative edges: 10, cites_informative: 36
```

Consistent, and `cited_by[]` is exactly what step 7 needs at document scope: every in-body
citation site with `block_id`, `section_id` and `offset`. 47 references in one call.

The trap: `label` is the bare bracket number, not the citation text.

```
references({label: "RFC 5234"})  ->  references: [], total: 47, warnings: []
```

**Zero rows, no warning, on a reference the graph says exists** (edge
`edge_684d5281ac6d44d61a000341`, `cites_normative`, target `doc:rfc-5234`). The correct
call is `label: "7"`. An engineer types the reference the way the RFC writes it and gets a
confident empty.

### The direction parameter inverts

```
dependencies({rfc: 5321, direction: "incoming"})
  nodes: 48 documents that cite 5321        <- inbound, correct
  edges: 51 edges, every one with from: "doc:rfc-5321"   <- OUTGOING
```

I asked what depends on 5321. I got the right node set and the wrong edge set — 51 edges all
pointing _away_ from 5321, 48 of which are its own citations. An engineer building an impact
analysis from `direction: "incoming"` reads 51 citations and concludes 51 things depend on
it. S1.

### RFC 2328's §11.2 and §11.3 do not exist and cannot be reached

```
resolve({rfc: 2328}) -> warnings: ["parse:toc_sections_without_a_heading:11.2,11.3", …]
read({snapshot_id: <2328>, target: "outline"}) -> 112 entries; "11.2" absent, "11.1" present
read({snapshot_id: <2328>, section: "11.2"})
  -> status "degraded", error NOT_FOUND "Section 11.2 not found in RFC 2328",
     retryable: false
```

The parser found TOC entries 11.2 and 11.3, **reported them by number in a warning**, and
then could not produce them. The outline omits them; `read` refuses with `retryable: false`
and does not mention that 11.2 exists. In OSPF that is the routing-table lookup and
route-calculation material. Two sections the tool named and then denied, with no remedy and
no enumeration.

---

## 8. "Did I change anything?"

`diff` takes `{left: {rfc|snapshot_id}, right: {rfc|snapshot_id}, mode, max_changes,
include_unchanged}`. **It diffs documents.** It cannot diff derivations, because a document
has exactly one derivation and `resolve(refresh)` returns the same snapshot id (§6b).

**The "no second derivation" case is handled honestly, and I want to credit it:**

```
diff({left: {snapshot_id: <8446>}, right: {snapshot_id: <8446>}, mode: "requirements"})
  -> changes: [], summary: {}, truncated: false,
     warnings: ["both_sides_are_the_same_snapshot"]
```

It does not fabricate a clean diff. It names the condition. 72 ms.

### `mode: "text"` does not produce text

```
diff({left:{rfc:5246}, right:{rfc:8446}, mode:"text", max_changes:500})
  -> 107 changes, truncated: false
     section_renamed: 33, section_removed: 20, section_moved: 12, section_added: 41
     ZERO line hunks
```

The tool description: _"text (line hunks, explicitly not a semantic diff)"_. The response
echoes `"mode": "text"` and contains no line hunks — only structure, byte-identical to
`mode: "structure"`. An engineer asking "what text changed between my TLS 1.2 fork and
1.3" gets a section rename list, correctly labelled `text` mode, with no warning. S1 for
code review; S2 for contract review.

### The aggregate counts are computed over a truncated page

```
diff({left:{rfc:5246}, right:{rfc:8446}, mode:"requirements", max_changes: 500})
  -> 500 changes, truncated: true
     summary: { requirement_removed: 171, requirement_added: 329 }   // 171 + 329 = 500
     limits.applied: { max_changes: 500 }
     next_cursor:  absent
```

`summary` is exactly the ceiling. 171 + 329 = 500. The counts are over the page, not over
the diff, and the schema's 500 is the hard maximum, so **the remainder is unreachable**.
A compliance engineer producing a TLS 1.2 → 1.3 migration checklist gets 500 of ≥500
changes and two authoritative-looking numbers. I never observed a `modality_changed` in
three pairs; the tool advertises it.

### Two diffs that are confidently wrong

```
diff({left:{rfc:2178}, right:{rfc:2328}, mode:"requirements", max_changes:500})
  -> changes: [], summary: {}, truncated: false, status: "ok", warnings: []
```

RFC 2178 is the 1991 OSPF draft; RFC 2328 is the 1998 Internet Standard. Both have zero
extracted requirements. **The diff reports that nothing changed between them** — no changes,
no summary, no truncation, no warning, `status: "ok"`. A routing engineer asking "what did
the standard change relative to the draft I implemented against" gets an empty successful
answer. This is the single most dangerous response in the walk, because it is
indistinguishable from a genuine finding of "no change".

```
diff({left:{rfc:959}, right:{rfc:5321}, mode:"structure", max_changes:500})
  -> 158 changes, truncated: false
     section_removed: 22, section_renamed: 25, section_added: 111
     #1 change: { kind: "section_removed",
                   before: { number: "Status of this Memo", title: "Status of this Memo",
                             kind: "status" } }
```

22 of 158 changes between FTP and SMTP are front-matter, status-notice, copyright and
author-address bookkeeping. `"Status of this Memo" removed` is a parse artefact presented as
a document change, in the same array, with the same shape, as a real section removal. 14 %
junk in the diff with no field to exclude it.

---

## 9. "What did the tool NOT read?"

### Every field available for a completeness assertion

```
coverage: total_requirements, returned, section_filter, term_filter, keyword_filter,
          blocks_scanned, prose_blocks_scanned, blocks_skipped, blocks_skipped_by_kind,
          keyword_bearing_blocks_skipped, unscanned_note
non_strict_candidates: total, returned, filters, by_keyword, by_keyword_case, by_reason,
                       by_role, by_shape, by_section, scanned_blocks, unreadable_blocks,
                       sentence_fragments, ordering, candidates[], note
warnings: parse:*, candidate_sections_skipped:N, zero_or_few_requirements_but_N, ……
limits:   applied, truncated
```

**There is no `complete: true|false`, no `coverage_verdict`, no per-section completeness,
and no list of what was skipped.** Every count that would settle the question is a warning
string or is absent.

### The three specific holes

**9a. `candidate_sections_skipped: 78` on RFC 2328 is a warning string and nothing else.**
2328's outline has 112 sections. `non_strict_candidates.by_section` has **83** entries. 78
sections were skipped and I cannot enumerate which 78 — so I cannot finish the enumeration,
only discover that I did not. `non_strict_candidates.scanned_blocks: 280` against
`coverage.prose_blocks_scanned: 875` is the real gap and appears in two different objects
with two different meanings. `unreadable_blocks: 0` and `sentence_fragments: 0` sit next to
them, both reassuring and both irrelevant.

**9b. `keyword_bearing_blocks_skipped: 0` is the completeness signal, and it cannot detect
the failure it is meant to detect.** It counts RFC 2119 keywords in blocks the parser
classified as non-prose. A specification that states its obligations without a keyword —
"a server that does not X is non-conformant", or 2328's own state-machine tables — is
invisible to it by construction. The attached `unscanned_note` says a low count "reads as a
known gap rather than an absence", and on 2328 and 959 the count is 0. The changelog
admits keyword-free specifications sit at 0 % recall; this is the field that certifies them
as clean.

**9c. The field nominated to make a zero explicable is missing where a zero occurs.**

| document | `total_requirements` | `keyword_usage`                                        |
| -------- | -------------------- | ------------------------------------------------------ |
| 5321     | 355                  | `stance: "adopts"` + exact notice + span + citation_id |
| 8446     | 427                  | `stance: "adopts"` + …                                 |
| 9110     | 408                  | `stance: "adopts"` + …                                 |
| 959      | **1**                | **absent**                                             |
| 2328     | **0**                | **absent**                                             |

### Also unmeasurable, and worth a line each

- `max_output_bytes: 16384` on `read(section: "4.1.2", max_output_bytes: 16384)` returned
  **26 747 bytes with `truncated: false` and `byte_cursor: null`**. The budget bounds the
  text, not the envelope. 35 132 bytes with `include` omitted. A caller asserting
  `!truncated` has still been handed 26 KB, and the text is present three times
  (`section.text` 4 291, root `text` 4 145, `text_verbatim` 4 291) plus 25 blocks each
  carrying an empty `text` and a `sha256`.
- `section.text_sha256` (`431973013125…`) equals `text_sha256_verbatim`, i.e. it hashes the
  **verbatim** text, while the root `text` — the field the capability contract tells you to
  copy from — has **no hash of its own** on any of the five documents. Hash the field you
  were told to use and you get a mismatch.
- `read(section, include: ["text"])` returns `data.section.text == ""` and
  `data.blocks[0].text == ""` with the content only at `data.text`, and the only warning is
  about page furniture. `capabilities` promises _"passing an explicit list without
  source_map returns empty text and a warning"_. There is no warning. I hit this on the
  natural code path and had to re-read to find the text.
- `dependencies` drops 170 inbound relations on 854 with
  `inbound_relations_truncated_at_170`, `data.truncated: false`, no cursor, and schema
  limits (200/500) that the contract caps at 100/200.
- `search(max_results: 200)` returns 20 with `limits.applied: {max_results: 20}` and no
  clamp warning — the same silent clamp the changelog fixed on `requirements`.
- 2 327 bytes of the `requirements` response is a 1 180-character English `note` on the
  candidate list and a 305-character `interpretation.caveat`, repeated in every call.

### What I would assert on in a test, and cannot

```ts
// Fails on 2328 and 959. Passes for the wrong reason everywhere else.
expect(r.data.coverage.total_requirements).toBeGreaterThan(0);
```

There is no field combination that distinguishes "this document's requirements are fully
enumerated" from "this document's requirements are partly enumerated and here is how much".
That is the gap. Everything in §9 is a consequence of it.

---

## Summary

| #   | step                          | 5321 SMTP                                      | 2328 OSPF                                                            | 8446 TLS 1.3                        | 959 FTP                         | 9110 HTTP         | first point of failure                                                                                                                                                                                                                      | sev    |
| --- | ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- | ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | find by protocol name         | **54/57**                                      | 2/97                                                                 | 18/22                               | **28/28**                       | 20/22             | ranking buries the standard; identical titles score 15.4 vs 8.8. `ensure_top_catalog_hits` ingests the wrong docs, reports no titles, mutates the corpus. Miss says `ingested_text_only:159/9842` for a 9 842-doc catalog search            | **S1** |
| 2   | current status                | works                                          | works                                                                | works, `obsoleted_by:[9846]` inline | works                           | works             | `status:"internet standard"`+`STD 8` asserted for 854; `obsoleted_by`/`obsoletes`/`updated_by` edges are the only class with `evidence:null`; 170 inbound edges dropped, no cursor                                                          | S2     |
| 3   | enumerate requirements        | 2 calls / 1.56 MB / 355                        | 1 / 389 KB / **0**                                                   | 3 / 2.18 MB / 427                   | 1 / 205 KB / **1**              | 3 / 1.92 MB / 408 | 2.18 MB single page, 133× the advertised `maxOutputBytes`; `mentions` repeated on every page; `in_appendix` 0 on 9110 vs 50 on 8446                                                                                                         | S2     |
| 4   | filter to the handshake MUSTs | scope+term+keyword compose; negatives return 0 | **nothing to filter**                                                | —                                   | —                               | —                 | `term` case-insensitive but echoes your case; `role`/`shape` silent no-ops on requirements; scope typo = empty contract, `status:"ok"`, no warning; no `actor` filter                                                                       | **S1** |
| 5   | is this row a fragment        | flags good                                     | no rows                                                              | flags good                          | 1 row, dangling colon           | flags good        | `parse_status:"complete"`, `flags:[]`, `clause.condition:null` on a colon-terminated fragment; `span` means statement here and block in verify, unlabelled; `notes:` byte range is the block, called the quote; `in_appendix` unpopulated   | **S1** |
| 6   | cite it in a ticket           | works                                          | **unreachable**                                                      | works                               | works                           | works             | best step. `quote_sha256` alone → `not_found`; with `rfc` → `ambiguous` (2 records) for a quote that just verified. No `char_end`, so no arbitrary-slice verification. No second derivation exists — `resolve(refresh)` returns the same id | S2     |
| 7   | what does this row depend on  | no section API                                 | **§11.2/§11.3 named then `NOT_FOUND`**                               | no section API                      | no section API                  | no section API    | neither tool takes a section; `evidence.url:null`, no offsets, no citation_id; `direction:"incoming"` returns outgoing edges; `label:"RFC 5234"` → 0 rows, no warning                                                                       | **S1** |
| 8   | did I change anything         | —                                              | **`diff(2178,2328)` → `changes:[]`, `status:"ok"`, no warnings**     | `mode:"text"` returns 0 line hunks  | 22/158 changes are front matter | —                 | `text` mode emits structure; `summary` is over the truncated page and the remainder is unreachable past `max_changes:500`; identical snapshot handled honestly (`both_sides_are_the_same_snapshot`)                                         | **S1** |
| 9   | what did it not read          | —                                              | `candidate_sections_skipped:78` unenumerable; `keyword_usage` absent | —                                   | `keyword_usage` absent          | —                 | no `complete` verdict anywhere; the one nominated field (`keyword_usage`) is missing on both low-count docs; `keyword_bearing_blocks_skipped:0` certifies table-driven specs as gap-free                                                    | **S1** |

### The single most expensive place for an engineer to get stuck

**Step 3's payload, on a document the step cannot complete.**

A full enumeration of RFC 8446 costs 3 calls, 7.9 s and **2 180 036 bytes** — about 550 000
tokens — to receive 427 rows of which the tool itself flags 62 as needing work, at
1 191–1 286 bytes per row, with 44 rows that must be hand-split. RFC 2328 costs 389 425
bytes over 585 ms to receive **zero rows** and a warning string. RFC 959 costs 204 636 bytes
to receive one fragment. The advertised `maxOutputBytes` is 16 384 and there is no bound,
no size preview, and no way to ask for a page without paying for the other two arrays.

Two documented flags cut 74 % (`include_mentions: false, include_candidates: false`: 5.66 MB
→ 1.49 MB across the three documents that have lists). The tool knows this. The default does
not use it, and the response never mentions that it exists.

An agent that tries to enumerate 8446, 8448, 9110 and 5321 in one session to build a
cross-protocol contract asks for 6.0 MB ≈ 1.5 M tokens and will not finish. The cost is not
the 3 calls. The cost is that the caller cannot size the request, cannot bound the response,
and on two of five documents is paying full price for an empty or one-row answer.

### The single most likely way this tool produces a WRONG contract rather than an incomplete one

**Not a missing requirement. A requirement the tool asserts is complete, cites cleanly, and
is wrong.**

Concretely, in descending order of how likely an engineer is to ship it:

1. **`diff(2178, 2328)` → `changes: []`, `summary: {}`, `truncated: false`, `status: "ok"`,
   no warnings.** A routing engineer who implemented against the 1991 OSPF draft asks what
   the 1998 Internet Standard changed. The tool — the only evidence source in the loop —
   says nothing changed. The failure is invisible because the response is _shaped exactly
   like a finding_. This is the highest-consequence S1 in the walk and the cheapest to fix:
   two documents with `total_requirements == 0` cannot be diffed on the requirements axis,
   and the tool should say so instead of returning an empty success.

2. **`requirements(2328)` → `total_requirements: 0` with `keyword_bearing_blocks_skipped: 0`.**
   Not an absence — a certificate of absence, in a typed field, with an explanatory note
   telling the caller to read 0 as "not a gap". A test asserting
   `total_requirements === 0 && keyword_bearing_blocks_skipped === 0` encodes "OSPF states
   no requirements and I checked" as a passing condition. 422 candidates exist; 78 sections
   were skipped and cannot be enumerated; `keyword_usage` is absent.

3. **The 959 fragment.** `"The server MUST close the data connection under the following
conditions:"` → `clause.action: "close the data connection under the following
conditions"`, `condition: null`, `parse_status: "complete"`, `confidence: 0.9`,
   `flags: []`, `citation_id` present, `verify_citation` → `verified`. Rendered into a
   contract line and implemented, an FTP server closes the data connection unconditionally.
   The row is _confidently wrong and fully citable_, which is the worst combination: every
   trust signal the tool offers says "use this".

4. **`dependencies(5321, direction: "incoming")` returning 51 outgoing edges.** An impact
   analysis inverted, with a correct-looking node set attached so the shape of the response
   reassures the reader.

5. **`mode: "text"` returning 0 line hunks.** A code-review or contract-diff step that
   reports "no text changes" because it silently ran a structural diff, labelled `text`.

The common thread: in every one of these the _typed_ fields and the _warnings_ point in
different directions, and the typed fields are the ones a test can assert on. The tool's
honesty lives in `warnings`; its assertions live in `coverage`; and an engineer writing a
compliance contract — which is a machine-readable artefact — reads the assertions.

The one-line fix that would blunt all five: **`coverage` needs a completeness verdict, and
every operation that cannot answer needs to say so in a typed field rather than returning a
well-formed empty success.** `warnings` already knows. It is not in the contract.
