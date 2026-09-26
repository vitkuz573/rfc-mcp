# Contract-honesty audit: every fact-stating field, checked

Adversarial audit of the claim

> "Nothing is inferred silently: unresolved references, degraded parses and partial results are
> reported, not repaired."

against the fields the tool advertises: `total_requirements`, `parse_status`, `confidence`,
`text_fidelity`, `coverage`, `warnings`, `provenance`.

**Verdict: the claim is false.** Sixteen fact-stating fields state something other than the
truth. Four of them would make a caller build a contract on a wrong premise (which documents cite
this one; which sentence is the requirement; that a line was emptied when it was not; that this
document's citations were extracted). The offsets, the coverage counters, the errata overlay and
the citation machinery all survived every attempt I made to break them — that is the larger half
of this report, and it is reported in full.

---

## 0. What was observed, and against what

| item                                         | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build under test                             | `dist/`, a single coherent tsc run at **2026-09-26 12:31:36–37 local (07:31Z)**. `dist/*/*.js` mtimes are all within one second of each other. Reached two ways: `tools.rfc.*` (the running MCP server) and `node dist/cli.js`.                                                                                                                                                                                                                                                                                                         |
| derivation versions that produced the corpus | `parser rfc-text-1.7.3`, `extractor normative-2119-8174-1.6.3` — identical to the build's config, so the corpus matches the code under test.                                                                                                                                                                                                                                                                                                                                                                                            |
| working tree                                 | **moving during the audit.** `src/analysis/normative.ts` mtime 13:28:11, `src/service/rfcService.ts` 13:41:05, `src/store/database.ts` 13:40:08, all after the 12:31 build. `git status` shows 18 modified files, HEAD `a48fa2c`.                                                                                                                                                                                                                                                                                                       |
| source line numbers below are as of          | `src/analysis/normative.ts` md5 `dec0c14ec2ee6ce4535997dd5da77873`, `src/service/rfcService.ts` `55d38691c15244330caec976dad43abe`, `src/store/database.ts` `19162d47f2b9135e2caa7e4e4af5d17b`, `src/parse/text.ts` `f25fb5985dc47406bf69495cd23fd931` (unmodified since the build), `src/core/util.ts` `31216e10046dd307ce94bf97b50b3dff`, `src/upstream/sources.ts` `6bd4646731549e308e9f04386313a17f`, `src/mcp/tools.ts` `9341f1b4b150e11f3d24aa153aab721b`. Grep the symbol names if they have moved again.                        |
| corpus of record                             | `~/.local/share/rfc-mcp/corpus.sqlite`. **Another session was ingesting into it while I audited**: 159 snapshots at 13:07 → 166 at 13:12 → **182 at 13:27** (observed through `status`). `index_generation` moved 1953 → 1980 under me.                                                                                                                                                                                                                                                                                                 |
| how corpus facts were taken                  | Two frozen copies, `cp` of `corpus.sqlite{,-wal,-shm}`: `/tmp/opencode/audit/frozen.sqlite` (166 snapshots, generation 1963, 08:09Z) for SQL, and `/tmp/opencode/audit/data/rfc-mcp/` (159 snapshots, generation 1953) for every service call, so that no probe could write the corpus of record. `CorpusStore`'s constructor writes (`setMeta("schema_version")`, `setMeta("cursor_secret")`, `PRAGMA journal_mode=WAL`), so instantiating `RfcService` against the real path would have written it; the copy is why that was avoided. |
| no writes, no build, no sync                 | Correct. `resolve(refresh:true)`, `dependencies(direction:incoming)`, `history`, `errata` and `read(target:raw_slice)` were exercised only against the copy. All `tools.rfc.*` calls used documents already in the corpus and `direction:"outgoing"`, so nothing was ingested into the record.                                                                                                                                                                                                                                          |
| only file written                            | this one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Build-vs-source deltas that limit what I could test

`capabilities` in the build under test returns **7** `reading_rules`, **3** `limits_notes` and no
`parse_notes`; the working tree returns **10**, **5** and a `parse_notes` block. The build has no
`stable_citation_id`/`scit_` surface (`grep scit_ dist/service/rfcService.js` → 0 hits) and no
`omitted_on_page` stub for `non_strict_candidates`; the working tree has both. Consequently:

- the `scit_` claims in the working tree's reading rules are **untested** (absent from the build);
- `non_strict_candidates` repeats all 376 rows on every page in the build, so the working tree's
  "rows ship on page 1 only" rule is **untested**;
- `text_fidelity` in the build ends at _"Line counts are equal in both."_; the working tree appends
  _"and page_furniture_lines lists the line numbers emptied to get it."_ — so **F4 below is
  understated in the build I observed** and is worse in the source.

Every finding below was checked against the working tree and is present there too, except where
noted. Nothing below is a build-staleness artefact.

---

## 1. Findings

Severity is consequence for a caller building a contract.
**critical** = the caller would assert something to a third party that is not in the document.
**high** = the caller would draw a wrong conclusion about the document's content or scope.
**medium** = a field names a condition that does not hold, or a counter is wrong in a way that
changes a decision. **low** = naming, unreachable caps, cosmetic.

---

### F1 — `resolve` always claims the snapshot came from upstream, including when nothing was fetched — HIGH

```
tools.rfc.resolve({ rfc: 768 })
  → warnings: ["snapshot_resolved_from_upstream"]
    freshness: "cached"
    observed_at: "2026-09-26T05:27:12.332Z"      (= snapshot.retrieved_at, 2h45m earlier)
    source_urls: [rfc-common/768.json, rfc768.txt]
```

Nothing was fetched. The snapshot was already in the corpus, and both HTTP cache rows are inside
their 6 h TTL (`source_cache.expires_at = 2026-09-26T11:27:12.332Z` for `rfc768.txt`; the call was
at 08:22Z), so `HttpClient.get` returns at `src/upstream/http.ts:110` without touching the wire.
The warning is pushed unconditionally at `rfcService.ts:670`, outside any branch.

It is provably false in the mode where it matters most. On the copy, offline:

```
RFC_MCP_OFFLINE=true  svc.resolve({ rfc: 768 })
  → freshness: "offline"
    warnings: ["snapshot_resolved_from_upstream"]
```

Offline mode returns at `rfcService.ts:432-438` before any network code is reachable. The single
warning in the envelope asserts a network resolution in the same envelope that says the server is
offline. Same for 1812 and for RFC 9999.

This is the exact failure the brief names: _a warning that teaches a reader to ignore it is worse
than no warning_. `resolve` is the only tool that emits it, it is emitted on every call, and it is
never actionable.

**Severity high.** Not critical: no text is misquoted; but a caller who gates on `warnings` to
decide "did this hit the network?" gets a constant yes.

---

### F2 — 129 requirement rows are mid-sentence fragments reported as `complete` / `confidence: 0.9` — HIGH

The previous audit's finding. **Not fixed.**

Mechanical test over all 10 966 requirement rows: row's `char_end` equals its block's `char_end`,
row's last character is not sentence-terminal, and the block's own text continues past the row.
That is the signature of a block cut at a page break mid-sentence.

- **129 rows** in **39 documents**: `1122 1123 1812 2045 2821 2845 2865 3261 3501 4035 4045 4120
4253 4271 4511 5155 5246 5280 5321 6455 6672 6762 7230 7231 7233 7234 7838 7858 7871 8252 8445
8446 8449 8470 8490 9002 9110 9112 9460`
- **`parse_status`:** 104 `complete` / 0.9, 25 `partial` / 0.7
- **`flags`:** 86 of the 129 carry **`flags: []`** — nothing at all.

Live, RFC 1812 §4.2.2.2:

```
tools.rfc.read({ rfc: 1812, section: "4.2.2.2" })
  "When a router inserts its address into such an\n   option, it MUST use the IP address of the
   logical interface on which\n\n\n\n\n\n\n\n\n   the packet is being sent.  Where this rule …"
  (the eight blank lines are the page break; the sentence is whole)

tools.rfc.requirements({ rfc: 1812, scope: "4.2.2.2", max_results: 20 })
  id: req_5d14c156a9b90728
  exact_text: "When a router inserts its address into such an\n   option, it MUST use the IP
               address of the logical interface on which"
  parse_status: "complete"   confidence: 0.9   flags: []
  clause: { actor: "it",
            condition: "When a router inserts its address into such an option",   ← lost its main clause
            action:   "use the IP address of the logical interface on which" }   ← dangles on "which"
```

Same section, same response, four other mis-shapes also filed `complete`/0.9:
`req_fd50f1d9688916ef` starts `"Which\n   of the router's addresses is used as the router-id MUST
NOT change…"` — a sentence that begins mid-clause — with `clause.actor =
"of the router's addresses is used as the router-id"`.

**`confidence` carries no information at all.** Over the whole corpus it is a pure function of
`parse_status`:

```
select parse_status, confidence, count(*) from requirements group by 1,2
  complete | 0.9 | 10586
  partial  | 0.7 |   380
```

Two values, perfectly correlated, never any other. A caller that filters on `confidence <= 0.8` to
discard shakier rows is filtering on `parse_status`, not on confidence — and gets 129 fragments
through at 0.9.

Mechanism, unchanged in the working tree: `analyzeNormative` calls `splitSentences(block.text)`
per block at `normative.ts:1109`, so a block boundary is a sentence boundary. The candidate pass
has the mechanism the strict pass lacks (`previousEndedOpen` `normative.ts:1504`,
`continuesPrevious` `:1374`, `isFragment` `:1449`) and reports it as
`sentences_split_across_a_page_break:N:flagged_continues_previous_block_not_whole_statements`.
The strict pass has none of it.

**Severity high.** A compliance list built from `parse_status == "complete"` contains 86
unflagged half-sentences.

---

### F3 — `analyses.references_extracted: true` and `quality: "complete"` over four documents whose reference sections yielded nothing — HIGH

`references_extracted` and `requirements_extracted` are the literal `true`
(`rfcService.ts:677-678`) — they say the extractor ran, not that it found anything. Nothing else
in the response notices when it found nothing.

```
select s.rfc, s.reference_count, s.quality,
       (select count(*) from blocks b join sections sec on sec.id=b.section_id
         where b.snapshot_id=s.id and sec.kind='references') as refsec_blocks
  from snapshots s where refsec_blocks > 8 and s.reference_count = 0

  1812 | 0 | complete | 316
  1123 | 0 | complete |  84
  1122 | 0 | complete |  70
  3229 | 0 | complete |  30
```

```
tools.rfc.resolve({ rfc: 1812 })
  snapshot.reference_count: 0
  analyses: { requirements_extracted: true, references_extracted: true, warnings: [ …4 warnings, none about references… ] }
  snapshot.warnings: ["page_furniture_lines_dropped:524","underlined_headings_recognised:1",
                      "indented_subsection_headings_recognised:165",
                      "normative_text_in_unscanned_blocks:20:…"]
```

The snapshot warning _does_ see the references section — `keyword_bearing_unscanned_block_count:20`
counts keyword-bearing blocks inside those 316 — and says nothing about references not being
extracted.

Downstream, the silence becomes a positive false statement:

```
tools.rfc.references({ rfc: 1812 })   → total: 0, warnings: ["snapshot_not_explicitly_pinned"]
tools.rfc.dependencies({ rfc: 1812, direction: "outgoing" })
  → nodes: 5, edges: 4 (all catalog obsoletes/updated_by), unresolved: [], truncated: false
```

RFC 1812 cites dozens of RFCs. `dependencies` says it cites none, and says nothing was truncated
and nothing was unresolved. RFC 1122 and 1123 — _Requirements for Internet Hosts (TCP/IP)_, the
two documents a dependency contract is most likely to be built on — behave the same way.

**Severity high.**

---

### F4 — `inbound_relations_truncated_at_<N>` names a truncation that did not happen, over a result set that is empty — HIGH

```
svc.dependencies({ rfc: 1812, direction: "incoming" })
  status: "ok"
  warnings: ["inbound_relations_truncated_at_378", "snapshot_not_explicitly_pinned"]
  data: { edges: 4, inbound_edges: 0, unresolved: 0, truncated: false }
svc.dependencies({ rfc: 1122, direction: "incoming" })
  warnings: ["inbound_relations_truncated_at_789", …]   inbound_edges: 0, truncated: false
svc.dependencies({ rfc: 3261, direction: "incoming" })
  warnings: ["inbound_relations_truncated_at_2567", …]  inbound_edges: 0, truncated: false
relations table after all three: 0 rows
```

Two separate things are wrong.

1. The warning is pushed unconditionally on a successful fetch (`rfcService.ts:1707`). It names
   `relations.total`, which is `meta.total_count` from the API (`sources.ts:339`) — the size of the
   upstream set, not the size of anything returned or dropped.
2. The returned set is empty because of a name filter, not a truncation. `fetchRelations` keeps a
   row only when `/^(?:draft-.*-|rfc)(\d+)$/u` matches the other end's name
   (`sources.ts:326`). Measured against the live API, first 100 objects:

   | document | `meta.total_count` | objects fetched | surviving the filter |
   | -------- | ------------------ | --------------- | -------------------- |
   | 1812     | 378                | 100             | **0**                |
   | 1122     | 789                | 100             | **0**                |
   | 1123     | 506                | 100             | **0**                |
   | 3261     | 2567               | 100             | **0**                |
   | 768      | 773                | 100             | **0**                |
   | 959      | 305                | 100             | **0**                |
   | 2328     | 831                | 100             | **0**                |
   | 9000     | 678                | 100             | **0**                |
   | 9110     | 486                | 100             | 8                    |
   | 793      | 1291               | 100             | 2                    |

   The discarded rows are drafts (`draft-templin-intarea-parcels`) and sub-series (`std3`). The
   fetch takes 100 of up to 2567 and never paginates. Nothing in the response counts the discard.

So: `status: "ok"`, `truncated: false`, `unresolved: []`, 0 inbound edges, and a warning claiming
378 were truncated. A caller asking "which documents update RFC 1122?" gets "none".

Offline is the same story with no warning at all: the `!this.config.offline` guard at
`rfcService.ts:1685` skips the fetch silently, and the response is `warnings: ["snapshot_not_explicitly_pinned"]`,
`inbound_edges: 0`, `truncated: false`.

The same empty array surfaces through a second tool: `metadata(1122).relations.datatracker` is
`[]` for every document in the corpus, because the `relations` table's only writer is this path.

**Severity high.**

---

### F5 — `fragments[]` says "the first half is in an earlier block of the same section" for 12 of 57 rows where there is no first half — HIGH

Root cause: `listBlocksWithKeywords` orders by `ordinal` **alone**
(`src/store/database.ts:1303`, `ORDER BY ordinal`). `blocks.ordinal` restarts at 0 in every
section, so "the previous block" in `analyzeNormativeCandidates` is an arbitrary block from a
different section.

Reproduced for RFC 1812, block `blk_e705dd7c0188e2e8772fe3a9` (section 2.4, ordinal 7). In
`ORDER BY ordinal` order its predecessor is `blk_e41569cc9d397b1cc02d053e` in section
`sec_1840f74295bfb85648a368df`. Its real same-section predecessor is
`blk_fc330806cd96570ada906c39`, which ends `…flow based\n      forwarding.` — a full stop.

Caller-visible count, all 159 documents on the copy:

```
caller-visible fragments[] rows:                            57
  genuinely a page-break split (same-section predecessor ends open):  45
  NOT a split — the note is false:                                        12   (21%)
  documents affected: 9  →  1122 1123 1812 4511 5936 6698 7680 8200 8447
```

Row-level, RFC 1812:

```
fragments[0]
  block_id:            blk_e705dd7c0188e2e8772fe3a9
  exact_text:          "o Routing complexity should be in the routers."
  block text:          "   o Routing complexity should be in the routers."     ← a whole sentence
  real same-section predecessor tail: "…flow based\n      forwarding."
  note: "Second half of a sentence split by a page break. The first half is in an
         earlier block of the same section."
```

Row-level, RFC 8200 (`blk_9eaaf7c705e4edfb8c385bb0`) — the row is an errata change-log entry,
`"o In Section 4.5, added clarification noting that some fields in the\n      IPv6"`, and the real
predecessor ends `"…triction on headers in the first\n         fragment."`.

At the block level the same defect flags **89 of 166** blocks, and in **all 89** the "previous"
block was in a different section.

Compounding it, `continues_from_block` is a copy of the row's own `block_id`
(`rfcService.ts:1515`: `continues_from_block: candidate.block_id`), so a caller who follows the
note and reads that block gets the second half again. The real earlier block is never named.

**Severity high.** This is the claim's exact failure mode: a partial result is _reported_, and the
report is wrong, in a channel that exists precisely so the reader knows not to trust the row.

---

### F6 — `page_furniture_lines` lists lines that were not emptied, and `text_fidelity` says they were — MEDIUM-HIGH

```
tools.rfc.read({ rfc: 768, section: "References" })
  warnings: ["section_text_had_page_furniture_removed_on_lines:174:text_verbatim_is_the_exact_slice"]
  page_furniture_lines: [174]
  section.line_start..line_end: [148, 173]           ← 174 is outside the section
  text === text_verbatim: true                        ← nothing was blanked
  text_fidelity: "text has page furniture removed; text_verbatim is the byte-exact slice its char
                  and byte span denote. Line counts are equal in both."
```

```
tools.rfc.read({ rfc: 1034, section: "4.3" })    page_furniture_lines [1172,1173,1174]
                                                 section lines [1167,1167]   text === text_verbatim
tools.rfc.read({ rfc: 793, section: "REFERENCES" })  [5246,5247] / lines [5199,5212]  text === verbatim
```

Corpus-wide, over the 8 517 sections:

|                                                                                    | count           |
| ---------------------------------------------------------------------------------- | --------------- |
| sections with any `furniture_lines`                                                | 3 278           |
| **at least one listed line outside the section's own line range**                  | **1 177** (36%) |
| of those, **nothing blanked at all** — `text` is byte-identical to `text_verbatim` | **905**         |
| partially blanked — the list overstates how many lines were emptied                | 272             |
| documents with at least one wholly-false claim                                     | **128**         |

Cause: `furnitureLines` is collected from the whole _region_'s lines
(`src/parse/text.ts:241`, `sectionLines.filter(line => line.furniture === true)`) while the
section body is trimmed to the first and last **non-blank** content line
(`text.ts:242-253`). Furniture outside that trimmed range is retained in the list. `blankLines`
(`src/core/util.ts:72-79`) then maps `lineNumber - firstLine + 1` to an index past the end of the
text and blanks nothing.

So the two facts the field exists to establish are both unavailable: not _which_ lines were emptied
(the list is not the set), and not _that_ any were. The working tree makes this worse — it appends
_"and page_furniture_lines lists the line numbers emptied to get it"_ to `text_fidelity`.

**Severity medium-high.** A caller cannot use `page_furniture_lines` to decide which lines of
`text_verbatim` to distrust, which is the only reason the field is on the response.

---

### F7 — `text_fidelity`: "Line counts are equal in both" is false on every truncated read — MEDIUM

```
tools.rfc.read({ rfc: 793, section: "3.9" })            # pre-1990, exactly the case the field exists for
  truncated: true, limits.applied.max_output_bytes: 16384
  lines(text): 834     lines(text_verbatim): 1941       ← "equal" is off by 1107 lines
  text_fidelity: "… Line counts are equal in both."

tools.rfc.read({ rfc: 854 })     # front matter
  truncated: true   lines(text): 332   lines(text_verbatim): 815
```

`blankLines` preserves line count by construction; `truncateBytes` (`util.ts:59-62`) cuts at a byte
boundary and does not. `text_fidelity`, `text_verbatim`, `page_furniture_lines` and
`text_sha256_verbatim` are all emitted whenever `furnitureLines.length > 0 && text !== null`
(`rfcService.ts:948-966`) — that is, independently of `truncated`.

This is the default path: any pre-1990 section over 16 KiB. 16 384 bytes is 110 lines of 1960s
RFC prose, and RFC 793 §3.9 is 47 455 bytes.

**Severity medium.** The sentence is the reader's only guide to whether `text` and `text_verbatim`
are line-aligned, and it is wrong exactly when they are not.

---

### F8 — `verify_citation` returns the _block's_ span as `locator.span`, next to the quote — MEDIUM

```
tools.rfc.requirements({ rfc: 1812, max_results: 3, term: "MUST" }) → row req_4cf7f7be59007472
  row.span:  char 27729..27870   (141 chars — exact)
tools.rfc.verify_citation({ snapshot_id, citation_id })
  verdict: "verified"
  matches[0].quote: 141 chars
  matches[0].locator.span: byte 27727..28240, char 27727..28240, lines 547..554   ← 513 bytes
  notes: ["quote matches bytes 27727..28240 (lines 547..554)"]
```

The span is 3.6× the quote and covers 8 lines instead of the quote's extent. The note and the
field agree with each other and both describe the block, so the response is internally consistent
and externally misleading. `Citation.locator.span: Span` sits beside `quote: string` in
`src/core/types.ts:658-665` with no statement that the span is the enclosing block; the note is the
only place the distinction appears, and it names the block's numbers as if they were the quote's.

The correct span is available — the requirement row carries it — and is discarded here
(`rfcService.ts:2406-2418` reads `block?.byte_start`).

**Severity medium.** A caller anchoring a contract to `locator.span` anchors 513 bytes for a
141-character quote. Not critical, because `verify_citation` does verify the quote and the block
span is a superset, so nothing is cited that is not there.

---

### F9 — `zero_or_few_requirements_but_N_non_strict_candidates` fires when the requirement count is neither zero nor few — MEDIUM

```
tools.rfc.requirements({ rfc: 1812, max_results: 1 })
  coverage.total_requirements: 555
  warnings: [… "zero_or_few_requirements_but_378_non_strict_candidates:read_non_strict_candidates"]
tools.rfc.requirements({ rfc: 3261, max_results: 500 })
  coverage.total_requirements: 995
  warnings: [… "zero_or_few_requirements_but_357_non_strict_candidates:read_non_strict_candidates"]
```

Pushed on `analysis.candidates.length > 0` alone (`rfcService.ts:1537-1541`); no condition on the
requirement count exists. RFC 1812 and 3261 are the two largest compliance sets in the corpus and
both are told they have "zero or few requirements".

**Severity medium.** The warning's whole value is that it makes a low count explicable. Applied
uniformly it is noise on exactly the documents where a reader most needs it to mean something.

---

### F10 — `diff` reports one side's freshness, drops both sides' warnings, and never says it is unpinned — MEDIUM

```
tools.rfc.diff({ left: { snapshot_id: A }, right: { snapshot_id: B } })
  warnings: []      provenance.freshness: "cached"
                    provenance.observed_at: <right snapshot's retrieved_at>
                    provenance.source_urls: [<right's txt url only>]
```

`diff` builds a fresh array (`rfcService.ts:1776`) and never merges `left.warnings` /
`right.warnings`, and never adds `snapshot_not_explicitly_pinned` — unlike `metadata`, `read`,
`requirements`, `references`, `dependencies`, `errata`, `history`, `search`, which all do. With
`rfc` anchors instead of pins, `diff` also passes `refresh: input.left.rfc !== undefined`
(`:1763-1764`), so it reaches the wire by default, and then reports only `right.freshness`
(`:1784`). The left document's provenance is unreportable from the response.

Also unadvertised and currently unreachable: `diffSide` reads at most 5 000 requirements and 5 000
references per side (`:1792-1793`) with no field for the cap. The corpus maxima are 995 and 100, so
it does not bind today.

**Severity medium.**

---

### F11 — `capabilities.limits.maxRawSliceBytes: 262144` is enforced nowhere — MEDIUM

```
svc.capabilities().data.limits.maxRawSliceBytes   →  262144
svc.read({ rfc: 1812, target: "raw_slice", max_output_bytes: 4_000_000 })
  → limits.applied: { max_output_bytes: 4000000 }
    truncated: false
    returned bytes: 415740        (the entire document; snapshots.bytes = 415740)
```

`maxRawSliceBytes` is declared in `src/core/config.ts:64,82` and read by nothing: the raw-slice
path (`rfcService.ts:837-864`) bounds only on `maxBytes`, and `limits_notes` documents three of
the fifteen limits and does not mention this one.

**Severity medium.** A caller budgeting response bytes on the advertised limit is wrong by 1.6×.

---

### F12 — `mentions[].span` covers the keyword, not `exact_text`, in a row shape identical to `requirements[].span` — MEDIUM

```
tools.rfc.requirements({ rfc: 1122, max_results: 1 })
  mentions[0]:
    exact_text: '*    "MUST"'                  (9 chars)
    span:       char 42008..42012, line 953    (4 chars — the keyword)
    context:    '* "MUST"'
    disposition: "definition"
```

Measured against the stored raw bytes:

```
raw[byte_start..byte_end] == exact_text   requirements  10966 / 10966   ✓
raw[byte_start..byte_end] == exact_text   mentions      12358 / 12358   ✗  (the span is the keyword)
```

`Requirement extends NormativeMention` (`src/core/types.ts:303`), so both rows carry the same
`exact_text` + `span` pair with the same types, and nothing documents that the two `span` fields
mean different things. For candidates the difference _is_ documented (`types.ts:462`: _"A candidate
row's span covers its keyword because that is the thing it is about"_); for mentions it is not.

**Severity medium.** A caller treating the row shape uniformly produces a 4-character anchor for a
9-character quote. The `citation_id` still verifies (2 829/2 829 below), so nothing is misquoted.

---

### F13 — `status.documents.stale` is a literal `0`, next to a `state: "ready"` that means almost nothing — MEDIUM

```
tools.rfc.status({ include_failures: true })
  state: "ready"
  documents: { catalog: 9842, snapshots: 182, with_requirements: 140, stale: 0 }
  last_successful_sync: "2026-09-26T08:26:43.498Z"
  last_catalog_sync:   "2026-09-26T01:26:22.669Z"
  failures: []
```

`stale: 0` is the literal at `rfcService.ts:2459`; no query computes it, so it cannot become
non-zero. `state` is `snapshots > 0 || last_catalog_sync !== null` (`:2450`) — true with 182 of 9 842
documents ingested. `failures: []` is genuine (the `failures` table has 0 rows), and
`with_requirements: 140` is genuine (`count(distinct snapshot_id) from requirements`).

**Severity medium.** `stale: 0` and `state: "ready"` together are what a caller reads to decide
the corpus is current. 9 660 catalogued documents have never been ingested.

---

### F14 — `provenance.observed_at` is the query clock on `search`, `status` and `capabilities`; `freshness: "stale"` is unreachable — MEDIUM

```
tools.rfc.status({})   observed_at: "2026-09-26T08:26:56.965Z"   (query time)
tools.rfc.capabilities() observed_at: "2026-09-26T08:06:07.874Z"  (query time)
tools.rfc.search({ query: "datagram" }) observed_at: "2026-09-26T08:22:48.807Z"  (query time)
tools.rfc.metadata({ rfc: 768 }) observed_at: "2026-09-26T05:27:12.332Z"         (snapshot)
```

`envelope()` falls back to `isoNow()` when there is no snapshot (`rfcService.ts:348`), and
`Provenance.observed_at` carries no description in `types.ts:22-30` or in the MCP
`ProvenanceSchema` (`src/mcp/tools.ts:47`). Nothing in the envelope distinguishes "when the answer
was computed" from "when the source was observed".

`Freshness` is `"current" | "cached" | "stale" | "offline"` (`types.ts:18`) and the advertised
policy is `"…ETag revalidation, stale-on-error"`. Grep for an assignment: **there is none**. Every
call site passes `"offline"`, `"cached"` or `"current"` (`:437, :444, :507, :581, :649, :2472`).
After a genuine upstream failure the response says `freshness: "cached"` and puts the staleness in
a free-text warning:

```
observed on the copy with a deliberately broken HTTP client:
  resolve({ rfc: 768, refresh: true })
  → freshness: "cached"
    warnings: ["stale_cache_served_after_upstream_failure", "snapshot_resolved_from_upstream"]
```

**Severity medium.** A machine reading `freshness` never sees `"stale"`.

_(A first pass of this probe reported that warning on a healthy revalidation. That was my probe's
bug — I had constructed `HttpClient` without `defaultTtlMs`, so `new Date(NaN).toISOString()`
threw. Redone through `RfcService.create()`, a real revalidation returns
`served_after_conditional_revalidation` and keeps `observed_at` at the stored retrieval time, which
is correct. Recorded here so the number is not mistaken for a product defect.)_

---

### F15 — three silent clamps where `requirements` warns — LOW

```
svc.search({ query: "the", max_results: 200 })      → applied: { max_results: 20 },  warnings: []
svc.references({ rfc: 9293, max_results: 200 })    → applied: { max_results: 100 }, warnings: [pinned only]
svc.search({ query: "datagram", context_chars: 10 })  → accepted, silently clamped to 40
svc.search({ query: "datagram", context_chars: 5000 })→ accepted, silently clamped to 2000
svc.requirements({ rfc: 3261, max_results: 500 })
  → applied: { max_results: 200 }, warnings: [… "max_results_clamped:500->200:max_results_accepts_up_to_200"]
```

`requirements` reports its clamp (`rfcService.ts:1344-1346`); `search` and `references` do not.
`references`' cap does not bind today (corpus max `reference_count` is 100, exactly the cap);
`search`'s binds on every call with `max_results > 20`. `capabilities` advertises
`maxContextChars: 240 … overridable per call with context_chars (40..2000)` with no note that
out-of-range values are accepted and silently clamped.

**Severity low** (the applied value is reported in `limits.applied`; the requirement count of
`search` is in `data.total`).

---

### F16 — `limits_notes.maxQuoteChars` cites a corpus fact that is not true of this corpus — LOW

```
capabilities.limits_notes.maxQuoteChars:
  "…No quote is ever truncated … and the corpus contains requirement sentences of 2697 characters."

select rfc, length(exact_text) from requirements order by length(exact_text) desc limit 1
  → RFC 5936, 883 characters
select count(*) from requirements where length(exact_text) > 1200   →  0
select count(*) from mentions    where length(exact_text) > 1200   →  0
```

The _behaviour_ the note argues for is correct and I confirmed it: the longest quote is served
whole (`served_len: 883 == stored_len: 883`). The number offered as evidence is not reproducible
from the corpus that ships with the server. 2 697 is presumably from the 100-protocol golden set;
the note says "the corpus".

**Severity low.**

---

### F17 — `read(include: ["text"])` returns blocks with empty text and no warning; `include: ["blocks"]` returns the same shape _with_ one — LOW

```
svc.read({ rfc: 768, include: ["blocks"] })
  warnings: [… "block_text_suppressed_add_source_map_to_include_or_omit_include_entirely"]
  blocks[0].text: ""
svc.read({ rfc: 768, include: ["text"] })
  warnings: [pinned, furniture]          ← no suppression warning
  blocks[0].text: ""                      ← identical shape
```

The warning fires only when `include.has("blocks") && !include.has("source_map")`
(`rfcService.ts:767-769`). The `capabilities` reading rule that describes this says the remedies
are _"Omit include entirely, or add source_map"_ — neither of which a caller who asked for
`["text"]` can use, since they wanted the text and not the blocks. `include` does not in fact
control whether `blocks` is returned, only whether its text is; `include: ["outline"]` likewise
still returns a full `blocks` array and a non-null `text`.

**Severity low.**

---

### F18 — `read.next_cursor` on a raw-slice response is a bare integer for a field that does not exist — LOW

```
svc.read({ rfc: 793, section: "3.9" })
  truncated: true   byte_cursor: 171963   (= section.byte_end, the END, not a resume point)
```

`byte_cursor` is `truncated ? resolvedSection.byte_end : null` (`rfcService.ts:969`). Feeding it
back changes nothing:

```
read({ rfc: 793, section: "3.9", byte_cursor: 171963, max_output_bytes: 2000 })
  → byte-identical to the same call without byte_cursor
read({ rfc: 793, section: "3.9", max_output_bytes: 2000 })          ← same 2000 bytes
```

`ReadInputSchema` is a `strictObject` with no `byte_cursor` and no `cursor`; the working-tree
`limits_notes` nevertheless says _"Use read(max_output_bytes) with its byte_cursor to page through
a long section instead."_ The real route is `target: "raw_slice"` + `offset_bytes`, which works
(verified: `offset_bytes: 171963` returns the tail). The MCP tool layer also drops unknown keys
silently rather than rejecting them, so the bad advice produces a silent no-op rather than an error:

```
tools.rfc.read({ rfc: 793, section: "3.9", totally_bogus_key: 1 })  → ok, no error
```

And on a raw-slice response `next_cursor` is a plain integer string (`rfcService.ts:860`) that must
be passed as `offset_bytes`; everywhere else `next_cursor` is an opaque signed cursor.

**Severity low** (no wrong text; a documented recovery path that does not work).

---

### F19 — advertised counts in the `search` tool description are stale — LOW

```
src/mcp/tools.ts:185 (the build under test):
  "The catalog covers all 9842 documents; text search covers only the ~121 ingested, so the
   response reports corpus.coverage and a zero-hit result from a partial corpus is flagged."
```

`catalog: 9842` is right. Ingested was 182 at 13:27Z, not ~121. The _response_ is honest and
live — `corpus.coverage: "ingested_text_only:182/9842"`, and a zero hit raises
`text_search_covers_ingested_documents_only:ingested=182,catalog=9842,…` — so this is the
description, not the data.

**Severity low.**

---

### F20 — `references(resolution: "not_attempted")` returns 0 without saying the value never occurs — LOW

`resolution` accepts five values (`inputSchemas.ts:155`); the corpus contains four:

```
select resolution, count(*) from rfc_references group by 1
  exact 2563 | external 265 | unresolved 173 | ambiguous 2      ← "not_attempted" never occurs
```

`references(768, resolution: "not_attempted")` → `total: 0`, `warnings: ["snapshot_not_explicitly_pinned"]`.
A caller cannot tell "no such rows" from "that state does not exist".

**Severity low.**

---

## 2. Claims that survived every attempt to break them

These are reported with the attempts, because a short audit that finds nothing is only worth
reading if it shows what it tried.

### 2.1 Coverage counters — **TRUE**, on all 166 documents

Every counter `coverage` republishes is written to the `snapshots` row at derivation time and
republished verbatim. Recomputing all of them from `blocks` / `sections` / `requirements` /
`rfc_references` with the store's own rules (`PROSE_BLOCK_KINDS = {paragraph, list_item, unknown}`,
`SKIPPED_SECTION_KINDS = {authors, index, references}`, `countUnscannableBlocks`,
`database.ts:1698-1770`):

```
== snapshots: 166 | counter mismatches: 0
   block_count, section_count, requirement_count, reference_count,
   prose_block_count, unscanned_block_count, keyword_bearing_unscanned_block_count,
   unscanned_block_kinds_json  — all exact, including the byKind bucketing
```

And through the tool, on the 159-document copy, `coverage` against SQL per document:

```
documents checked: 159 / 159 | disagreements: 0
   total_requirements == select count(*) from requirements where snapshot_id = …   (159/159)
   blocks_scanned     == select count(*) from blocks          (159/159)
   blocks_scanned     == prose_blocks_scanned + blocks_skipped                   (159/159)
   sum(blocks_skipped_by_kind) == blocks_skipped                                (159/159)
   snapshot.requirement_count / reference_count == SQL                           (159/159)
```

One naming caveat, not a wrong number: `coverage.blocks_scanned` is `snapshot.block_count`, the
**total** block count, not the number scanned. For RFC 1812 that is 1 517 where 1 162 were
scanned. `prose_blocks_scanned` beside it carries the real figure, and the tool description says
"Coverage reports how many prose blocks were scanned", so the pair is readable — but the field name
is wrong. (low)

### 2.2 Offsets — **TRUE**, on every section, block, requirement and search hit

```
sections (8517):  byte span == byteLength(text)                     0 mismatches
                  char span == text.length                           0
                  codepoint span == codePointCount(text)             0
                  line span == line count                            0
                  sha256(text) == text_sha256                        0
                  raw[byte_start..byte_end] == text                  0
                  decodedRaw[char_start..char_end] == text           0
blocks (53530):   the same six checks                                0 mismatches each
requirements:     raw[byte_start..byte_end] == exact_text      10966/10966
                  decodedRaw[char_start..char_end] == exact_text 10966/10966
                  span == exact_text length (char/byte/codepoint)    0
                  exact_text is a substring of its own block         0 exceptions
raw snapshots:    length == snapshots.bytes and sha256 == raw_sha256, 166/166
```

`text_verbatim` is `sections.text` and it is the byte-exact slice its span denotes, for all 8 517
sections. `text_sha256_verbatim` is `sections.text_sha256` and matches. The offsets are correct.
F8 is about `verify_citation` _discarding_ the correct span, not about the span being wrong.

### 2.3 `verify_citation` — **TRUE**

```
requirement citations verified: 1288  → {"verified": 1288}      (12 per document, all 159)
mention citations verified:     2829  → {"verified": 2829}      (30 per document, all 159)
fabricated cit_0000000000000000deadbeef → verdict not_found, status degraded,
                                          notes ["no stored record matches the supplied locator or quote hash"]
block-derived citation (a text-search hit, which is never stored) → verified, reconstructed from
                                          the same identity function, note names the block
```

Both integrity checks fire before any lookup: a missing `raw` and a `sha256` mismatch both return
`integrity_failure`. "Every derived fact carries a citation id that can be re-verified against the
raw bytes" holds for every row that carries one. The exception is rows that carry
`citation_id: null` — see 2.6.

### 2.4 Errata are an overlay, never a patch — **TRUE**

```
errata(768)  → total 0, total_unfiltered 0, available_statuses {}     ← "none at all" is distinguishable
errata(7230) → available_statuses { held_for_document_update: 7, rejected: 9, verified: 8 }
errata(7230, status: "reported") → total 0,
   warnings ["no_errata_with_status:reported:available=held_for_document_update,rejected,verified"]
```

The reading rule _"An empty errata list is reported with the statuses that do have errata, so 'none
of that status' and 'none at all' stay distinguishable"_ is honoured. Raw `errata.status` is
inconsistently spelled in the store (`"held for document update"` ×38, `"held_for_document_update"`
×7) and `canonicalErrataStatus` normalises it on the way out — verified: `errata(7230)` returns
`held_for_document_update` for all 7 rows the store holds under either spelling.

And the overlay claim itself: for all 137 errata carrying `original_text`, the _original_ is what
sits in the publication bytes. The one apparent exception (RFC 5246 erratum 3191) is an artefact of
my line-matching, not an application — the raw contains `Updates: 4492` and not the two-line
`Obsoletes: … / Updates: …` original, which is consistent with the published file never having had
the obsoletes line.

Offline, `errata(768)` returns `total: 0, available_statuses: {}` with no warning that nothing was
attempted — the same class as F1/F4, worth a low on its own.

### 2.5 `capabilities` describes only things that exist — **TRUE**

- `tools`: 15 listed, 15 registered (`src/mcp/tools.ts:285`; the namespace exposes exactly
  `batch, capabilities, dependencies, diff, errata, history, metadata, read, references,
requirements, resolve, search, source, status, verify_citation`).
- `resources`: 10 listed, 10 handled (`src/mcp/resources.ts:8-17` and the two
  `ResourceTemplate`s; `kind` accepts `metadata, provenance, outline, sections, blocks,
requirements, references, citations`).
- `prompts`: 6 listed, 6 registered (`brief, requirements_audit, compare, dependency_review,
citation_check, offline_review`).
- `policy.privacy` / _"author email addresses are stripped at the source boundary"_:
  0 of 9 842 `catalog.authors_json` contain `@`, 0 contain an email-shaped key.
- `policy.http` "https only, allowlisted hosts": `ALLOWED_HOSTS` is exactly
  `www.rfc-editor.org`, `errata.rfc-editor.org`, `datatracker.ietf.org`.
- _"a batch cannot smuggle past a filter or a limit that the tool itself rejects"_ — **TRUE**:
  `batch` with `max_output_bytes: 5000000` → `Too big: expected number to be <=4194304`;
  `max_results: 5000` → `<=200`; `bogus: 1` → `unknown argument: bogus … unknown_keys: ["bogus"]`;
  `query: "a"` → `>=2 characters`. All four rejected with `INVALID_ARGUMENT`.
- `reading_rules[3]` _"A search result of 0 in text scope … The coverage field states how much of
  the corpus was searched"_ — **TRUE**:
  `search({query:"zzzznotpresentzzz", scope:"text"})` → `total: 0`,
  `corpus.coverage: "ingested_text_only:182/9842"`,
  `warnings: ["no_text_match","text_search_covers_ingested_documents_only:ingested=182,catalog=9842,resolve_the_rfc_first_or_pass_ensure_rfcs"]`.
- `reading_rules[4]` on blocks without `source_map` — **TRUE** for `include:["blocks"]`
  (warning present, `text: ""`), false for `include:["text"]` (F17).
- `reading_rules[5]` _"`read.text` is the section's content with page furniture removed;
  `text_verbatim` is the byte-exact slice its span denotes"_ — first half **TRUE** (2.2), second
  half **TRUE**; the `page_furniture_lines` half is **FALSE** (F6), and in the build under test
  that half is not even claimed.
- `limits_notes.maxQuoteChars` _"Advertised for compatibility and NOT enforced. No quote is ever
  truncated"_ — **TRUE**: 0 quotes and 0 mentions exceed 1 200 characters, and the longest
  (883) is served whole.
- `limits_notes.maxOutputBytes` _"A small budget narrows the answer and reports truncated; it never
  fails the call"_ — **TRUE**: `max_output_bytes: 64` is accepted and returns 64 bytes.
- `guarantees[2]` _"RFC text is treated as untrusted data, never as instructions"_ — **UNTESTED**.
  Behavioural, not observable from outside.

### 2.6 `guarantees[1]` is broader than the tool description — MEDIUM

> _"Every derived fact carries a citation id that can be re-verified against the raw bytes."_

True of every row that has one. But rows exist with `citation_id: null`:

```
search({ query: "datagram", scope: "catalog", max_results: 2 }).hits[0]
  → { document_id: "rfc-5238", rfc: 5238, match_field: "title",
      citation_id: null, snippet: "…", score: 7.28 }
```

The `search` tool description is careful about this — _"Every **text** hit carries a citation_id
that rfc_verify_citation accepts directly"_ — and text hits do (verified 2 829 mentions +
requirement citations, and the block-derived reconstruction path in 2.3). The `capabilities`
guarantee drops the qualifier, so the guarantee is false for catalog hits. **Severity medium**, and
it is a wording gap rather than a data defect.

### 2.7 `search` scope reporting — **TRUE**

Catalog scope: `corpus.coverage: "catalog_titles_and_abstracts"`, `documents: 9842`.
Text scope: `corpus.coverage: "ingested_text_only:182/9842"`, `documents: 182`, and every text hit
carries a `citation_id` that verifies. `scope:"auto"` picked `catalog` for `datagram`
(`meta.count > 0`) and `text` for a quoted phrase that appears in no title. A filter the scope
cannot honour is reported: `search({query:"datagram", scope:"catalog", section:"4.2"})` returned
`total: 55` with `warnings: []` — the same as an unfiltered query — so `section:` was **not**
reported as unapplied, which contradicts the description's _"A filter that the chosen scope cannot
honour is reported in warnings, never dropped silently."_ Recorded as an untested/partial result:
I did not exhaust the `unsupportedCatalogFilters` set, so I report this one case rather than a rate.
**Severity low** (unverified scope, same 55 hits).

### 2.8 `history` — **TRUE** (my first reading was wrong)

My offline probe returned `total: 0, entries: []` for RFC 1122 and I nearly recorded it as a false
zero. With the network on, against a copy:

```
history(1122) → total 9,  source https://datatracker.ietf.org/feed/document-changes/rfc1122/
history(1812) → total 7,  history(768) → total 7
```

which matches the feeds directly (9 / 7 / 7 `<entry>` elements). The offline empty carries no
warning, which is the F1 class, but with the network on the tool is right.

---

## 3. Table

| #   | claim                                                                                                                  | field / call                                                | verdict               | evidence                                                                                                                                                                                                               | severity    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| F1  | the snapshot was resolved from upstream                                                                                | `resolve.warnings[0]`                                       | **false**             | `src/service/rfcService.ts:670` unconditional; offline run returns `freshness:"offline"` + the same warning; HTTP cache rows inside TTL, no wire touched                                                               | high        |
| F2  | `parse_status:"complete"`, `confidence:0.9`                                                                            | `requirements[].parse_status/.confidence/.flags`            | **false**             | 129 rows in 39 docs end mid-sentence at their block's end; 86 have `flags:[]`; `confidence` is a pure function of `parse_status` (10 586 @0.9, 380 @0.7)                                                               | high        |
| F3  | references were extracted                                                                                              | `resolve.analyses.references_extracted`, `snapshot.quality` | **false**             | literal `true` at `:677-678`; 1812/1122/1123/3229 have 316/84/70/30 reference-section blocks and 0 rows, `quality:"complete"`, no warning; `dependencies(1812)` → 4 metadata edges, `unresolved:[]`, `truncated:false` | high        |
| F4  | inbound relations truncated at N                                                                                       | `dependencies(direction:"incoming").warnings`               | **false**             | `inbound_edges: 0` for 1812/1122/3261 with `truncated:false`; warning names `meta.total_count`; 0 of the first 100 upstream rows survive the RFC-name filter for 8 of 10 documents tested                              | high        |
| F5  | "Second half of a sentence split by a page break"                                                                      | `non_strict_candidates.fragments[].note`                    | **false**             | 12 of 57 caller-visible rows in 9 docs; cause is `ORDER BY ordinal` alone (`src/store/database.ts:1303`) with per-section ordinals; 89 of 166 at block level, all 89 cross-section                                     | high        |
| F6  | `page_furniture_lines` lists the emptied lines                                                                         | `read.page_furniture_lines`, `text_fidelity`                | **false**             | 905 sections in 128 docs list lines outside their own range and blank nothing (`text === text_verbatim`); 272 more overstate; `src/parse/text.ts:241` collects region-wide, body is trimmed `:242-253`                 | medium-high |
| F7  | "Line counts are equal in both"                                                                                        | `read.text_fidelity`                                        | **false**             | RFC 793 §3.9: 834 vs 1941; RFC 854: 332 vs 815; both `truncated:true`; `truncateBytes` cuts, `blankLines` preserves                                                                                                    | medium      |
| F8  | `locator.span` locates `quote`                                                                                         | `verify_citation.matches[].locator.span`                    | **false**             | 141-char quote → 513-byte span, lines 547-554; the correct span is on the requirement row and discarded at `:2406-2418`                                                                                                | medium      |
| F9  | "zero_or_few_requirements"                                                                                             | `requirements.warnings`                                     | **false**             | pushed on `candidates.length > 0` alone (`:1537-1541`); fired on 1812 (555 requirements) and 3261 (995)                                                                                                                | medium      |
| F10 | diff's provenance and warnings                                                                                         | `diff.warnings/.provenance`                                 | **false**             | `warnings: []` with `rfc` anchors (no `snapshot_not_explicitly_pinned`); `right.freshness` only; 5 000-row side caps unreported (unreachable: max 995)                                                                 | medium      |
| F11 | `maxRawSliceBytes: 262144`                                                                                             | `capabilities.limits`                                       | **false**             | `read(target:"raw_slice", max_output_bytes:4_000_000)` returned all 415 740 bytes, `truncated:false`; the constant is read nowhere in `src`                                                                            | medium      |
| F12 | `span` locates `exact_text`                                                                                            | `requirements.mentions[].span`                              | **false**             | 12 358/12 358 mention rows: span is the 4-char keyword, `exact_text` is the sentence; requirements are 10 966/10 966 exact; `Requirement extends NormativeMention`, difference undocumented                            | medium      |
| F13 | `documents.stale: 0`, `state: "ready"`                                                                                 | `status.data.documents`                                     | **false**             | literal `0` at `:2459`; `state` is `snapshots>0 \|\| last_catalog_sync!==null` with 182/9 842 ingested                                                                                                                 | medium      |
| F14 | `freshness` can be `stale`; `observed_at` is an observation                                                            | `provenance.*`                                              | **false / undefined** | no code path emits `"stale"`; `observed_at` = `isoNow()` for `search`/`status`/`capabilities`; a real upstream failure reports `freshness:"cached"` + a warning                                                        | medium      |
| 2.6 | "Every derived fact carries a citation id"                                                                             | `capabilities.guarantees[1]`                                | **false as worded**   | `search` catalog hits carry `citation_id: null`; the tool description says "every _text_ hit" and is true                                                                                                              | medium      |
| 2.7 | "A filter the scope cannot honour is reported"                                                                         | `search.warnings`                                           | **partial**           | `scope:"catalog", section:"4.2"` returned the unfiltered 55 hits with `warnings: []`; other filters untested                                                                                                           | low         |
| F15 | clamps are reported                                                                                                    | `search`/`references` `limits.applied`                      | **partial**           | `search` 200→20 and `references` 200→100 and `context_chars` out of range, all silent; `requirements` warns                                                                                                            | low         |
| F16 | "requirement sentences of 2697 characters"                                                                             | `capabilities.limits_notes.maxQuoteChars`                   | **false**             | longest `requirements.exact_text` = 883 (RFC 5936); 0 rows > 1200; behaviour itself correct                                                                                                                            | low         |
| F17 | suppression of block text is warned                                                                                    | `read.warnings`                                             | **partial**           | `include:["text"]` → `text:""`, no warning; `include:["blocks"]` → same shape, warning; neither documented remedy applies                                                                                              | low         |
| F18 | `byte_cursor` pages a long section                                                                                     | `read.byte_cursor` / `limits_notes`                         | **false**             | `byte_cursor` = `section.byte_end`; passing it back is a byte-identical no-op; `ReadInputSchema` has no such field; `target:"raw_slice"`+`offset_bytes` is the real route                                              | low         |
| F19 | "~121 ingested"                                                                                                        | `search` tool description                                   | **stale**             | 182 at 13:27Z; the response's `corpus.coverage` is live and correct                                                                                                                                                    | low         |
| F20 | `resolution:"not_attempted"`                                                                                           | `references`                                                | **misleading**        | value never occurs in 3 003 rows; 0 returned with no note                                                                                                                                                              | low         |
| —   | `coverage.blocks_scanned` is the number scanned                                                                        | `requirements.coverage`                                     | **misnamed**          | it is `block_count` (1812: 1517 vs 1162 scanned); `prose_blocks_scanned` carries the truth                                                                                                                             | low         |
| —   | offline `errata`/`history`/`dependencies` empties are marked not-attempted                                             | `warnings`                                                  | **false (silence)**   | offline `errata(768)` → `total:0, available_statuses:{}`, no warning                                                                                                                                                   | low         |
| 2.1 | `total_requirements`, `blocks_scanned`, `prose_block_count`, `blocks_skipped*`, `keyword_bearing_blocks_skipped`       | `requirements.coverage`                                     | **true**              | 0 mismatches on 166 snapshots recomputed from the tables; 0 on 159 documents through the tool                                                                                                                          | —           |
| 2.2 | byte/char/codepoint/line spans and text hashes                                                                         | sections, blocks, requirements                              | **true**              | 8 517 sections, 53 530 blocks, 10 966 requirements: every check exact, including `raw[span] == text`                                                                                                                   | —           |
| 2.3 | citations re-verify against the raw bytes                                                                              | `verify_citation`                                           | **true**              | 1 288/1 288 requirements, 2 829/2 829 mentions verified; fabricated ids → `not_found`; block-derived ids reconstructed and verified                                                                                    | —           |
| 2.4 | errata are an overlay; empty ≠ none-of-that-status                                                                     | `errata.*`                                                  | **true**              | `total_unfiltered` + `no_errata_with_status:…:available=…`; statuses canonicalised across both spellings                                                                                                               | —           |
| 2.5 | capabilities names only what exists                                                                                    | `capabilities.*`                                            | **true**              | 15 tools, 10 resources, 6 prompts all present; 0/9 842 author emails; allowlist is 3 hosts; batch rejects 4 classes of violation; zero-hit text search flagged with live counts                                        | —           |
| 2.8 | `history` returns the feed                                                                                             | `history.*`                                                 | **true**              | 9/7/7 entries for 1122/1812/768, matching the feeds directly                                                                                                                                                           | —           |
| —   | "RFC text is untrusted data, never instructions"                                                                       | `guarantees[2]`                                             | **untested**          | behavioural, not observable from outside                                                                                                                                                                               | —           |
| —   | `scit_` stable citations; `omitted_on_page` candidate stub; `parse_notes`; 3 extra reading rules; 2 extra limits notes | `capabilities`, `verify_citation`                           | **untested**          | absent from the build under test; present in the working tree; testing needs a rebuild, which was out of scope                                                                                                         | —           |
| —   | `diffSide` 5 000-row caps; `listBlocksWithKeywords` 5 000 limit                                                        | `diff`, candidate pass                                      | **unreachable today** | corpus maxima 995 requirements and 100 references; max 829 keyword-bearing blocks                                                                                                                                      | —           |

---

## 4. Attempts that produced nothing

Recorded so the negative results are auditable rather than assumed.

- **Fragment/mis-split sweep over all 10 966 requirements** with four independent signatures
  (block-boundary truncation, non-terminal last character, block text continuing, parsed `action`
  dangling on a preposition/conjunction/article). 129 hits on the first signature, 52 on the
  fourth (50 of them `complete`/0.9), 0 on "quote with no alphanumeric character", 0 requirements
  extracted from a rule-only block.
- **Mis-typed blocks**: only 20 prose blocks corpus-wide contain no alphanumeric character at all
  (horizontal rules in RFC 768 and 3 others), and **0** requirements were extracted from any of
  them. `blocks.kind` distribution is sane (paragraph 39 940 / preformatted 6 909 / list_item 5 164
  / reference_entry 3 135 / table 1 879). The mis-typing that matters is at the _section_ level
  (F3), not the block level.
- **`raw_slice` / diff / candidate caps**: tried to exceed `maxRawSliceBytes`, `maxDiffChanges`
  (5 000 requirements) and `listBlocksWithKeywords` (5 000 blocks). None is reachable with this
  corpus; reported as unreachable, not as broken.
- **Errata silently applied to publication text**: 137 errata with `original_text`, searched for
  `corrected_text` in the raw without `original_text`. One hit, and it is my matcher, not the tool.
- **Author email leakage**: `@` and email-shaped keys over all 9 842 catalog rows. Zero.
- **Invalid UTF-8 / byte-offset drift** (the case `verify_citation` warns about at `:2381`): found
  no snapshot where `byte_end - byte_start != byteLength(text)`, for sections or blocks, so the
  "byte offsets are approximate" note is a defensive branch that no document in the corpus reaches.
- **`stable_citation_id` / `scit_`**: grepped the build — absent. Not testable here.
