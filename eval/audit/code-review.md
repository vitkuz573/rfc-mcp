# Code review — uncommitted work (stable citation ids, candidate paging, bench guard)

Reviewer: read-only pass. Nothing was fixed, nothing built, nothing committed, the corpus
database was opened `mode=ro` only.

## 0. IN FLIGHT files — observed fingerprint

A fourth agent was still editing these. Recorded at the start of the review so a later
diff can be attributed:

| file                        | mtime (local, +0500)          | size   | md5                                |
| --------------------------- | ----------------------------- | ------ | ---------------------------------- |
| `src/analysis/normative.ts` | 2026-09-26 13:06:12.757298190 | 79 572 | `bd2a04c594d28563c34db453a1460870` |
| `tests/normative.test.ts`   | 2026-09-26 13:06:47.799666600 | 51 906 | `c34526e67f62f991dfb7a2bc8d926fce` |

Clock at capture: `2026-09-26 08:07:02 UTC` (= 13:07:02 +0500) — i.e. both files had been
written 15–50 seconds earlier. Everything I say about those two files is as of those
hashes. The corpus DB (`~/.local/share/rfc-mcp/corpus.sqlite`, 215 MB) was last written at
13:09–13:10, i.e. _after_ both source files, and still has no `stable_citation_id` column
(`PRAGMA user_version` = 0) — so nothing in this repo has yet exercised the schema-8
migration against the real corpus.

Verification runs (both clean):

- `npx tsc -p tsconfig.json --noEmit` → exit 0.
- `npx vitest run tests/citation-stability.test.ts tests/store.test.ts tests/service.test.ts`
  → 59 passed / 3 files, exit 0.

---

## 1. Ships a confidently wrong answer — read these first

### 1.1 `provisional_entries_included:N` is a false machine-readable claim on every page ≥ 2

`src/service/rfcService.ts:1547-1567`. Inside `if (input.include_provisional === true)`:

```
1555      if (page === 1) {
1556        data.requirements = [...keywordFiltered, ...provisional];
1557        coverage.provisional_returned = provisional.length;
1558      } else {
1559        data.requirements = keywordFiltered;
1560        coverage.provisional_returned = 0;
1561        coverage.provisional_omitted_on_page = page;
1562      }
...
1565      warningsOut.push(
1566        `provisional_entries_included:${provisional.length}:not_rfc2119_requirements_excluded_from_total`,
1567      );
```

The warning is pushed **unconditionally**, using `provisional.length` (the full candidate
count) while the `else` branch put **zero** provisional entries into `data.requirements`.
So `paged.requirements({cursor, include_provisional: true})` on RFC 3261 emits
`provisional_entries_included:2000:not_rfc2119_requirements_excluded_from_total` with
`coverage.provisional_returned: 0` and no provisional row anywhere in the payload. With the
default `limit = min(maxSearchResults=20, maxPageSize=200) = 20` and RFC 3261's 995
requirements, that is **49 consecutive wrong warnings per read**.

This is the worst class of defect in the change: a `warnings[]` entry is exactly what a
machine reader trusts, and it asserts a count of included rows that is contradicted by the
same response two fields away. The `non_strict_candidate_rows_omitted_on_page_N` warning at
1538-1542 does this correctly (it guards on `whole.length > 0`); this one was missed.

No test covers `include_provisional` on page ≥ 2 at all.

### 1.2 A candidate's `stable_citation_id` can never verify, and the failure note names the wrong cause

Candidates are the rows a reader copies a sentence out of, and the change mints an id for
them on the way out (`rfcService.ts:1455-1470`):

```
1465      stable_citation_id:
1466        section === null
1467          ? ""
1468          : stableCitationId({ rfc: record.rfc, sectionNumber: section, quote: candidate.exact_text }),
```

But candidates are **derived on demand and never stored**. `stableCitationOrigins`
(`src/store/database.ts:1161-1174`) reads `requirements` and `mentions` only, and a
candidate is by construction a statement the strict extractor _rejected_ — so it is in
neither table. Therefore in `verifyStableCitation`:

```
2229      const here = origins.filter((origin) => origin.snapshot_id === snapshot.id);   // []
2235      return answer("stale", [citation(span)], [
2235        `text matches ${where} in the pinned snapshot, but nothing in the corpus minted
             this id, so its provenance is unrecorded ... A corpus derived before this id
             existed says this for every stable id until reanalyze --all.`
```

So: a caller copies a sentence out of a lead list, keeps its `stable_citation_id`, and
verifies it against the very snapshot the response came from, and gets `stale` (HTTP-ish
status `partial`) plus a remediation — **`reanalyze --all`** — that can never fix it,
because no re-analysis will ever write a candidate row. The note attributes the failure to
a stale corpus, which is false. The `types.ts:405-414` promise ("never `""` for a candidate
the server produced") is true but beside the point: the id is well-formed and permanently
unverifiable.

The capability text at `rfcService.ts:2540` claims a stable id "survives a re-derivation"
without restricting that to stored rows, and the tool description at `src/mcp/tools.ts:289`
says an `scit_` id "survives a re-parse". For a candidate it survives as a _string_ and
verifies as `stale, provenance unrecorded`, forever.

The new test `tests/service.test.ts:872` asserts only
`expect(...).toMatch(/^scit_[0-9a-f]{24}$/)` on both requirements and candidates. It never
verifies one. That is precisely why 1.2 is invisible to the suite.

### 1.3 `getSectionByNumber` is `LIMIT 1`, and 113 of 159 snapshots have a duplicated section number

`src/store/database.ts:924-929`:

```
SELECT * FROM sections WHERE snapshot_id = ? AND number = ? ORDER BY ordinal LIMIT 1
```

`verifyStableCitation` resolves through it (`rfcService.ts:2119`). `stableCitationId` hashes
the section **number** only, and a snapshot can hold several sections with the same number.
Measured read-only against the live 159-document corpus:

- **113 of 159 snapshots** have at least one duplicated section number.
- RFC 1350 (`snp_372fd9d124538403713e2bf8`) has **ten** sections numbered `2` — ordinal 3 is
  the real "Overview of the Protocol"; ordinals 10, 12, 14, 16, 20, 22, 23, 25, 27 are
  table rows (`bytes   string   1 byte …`) misread as numbered headings.
- RFC 3987 has `2.1` at ordinal 10 ("Summary of IRI Syntax") **and** ordinal 14
  ("Convert the character to a sequence of one or more octets").
- RFC 1812 has `10.3.2` at ordinal 185 and 186.

Rows whose section is **not** the lowest-ordinal section sharing its number — i.e. rows whose
minted id resolves against a _different_ section:

- **1 requirement row**: RFC 3987, `2.1`, ordinal 14, `SHOULD`, "To reduce variability, the
  hexadecimal notation …".
- **11 mention rows**.

For that requirement the server hands out a `scit_…` id, a caller keeps it, and
`verify_citation({rfc: 3987, section: "2.1", citation_id})` searches ordinal 10, does not
find the sentence, and answers `not_found` with the note _"no sentence in RFC 3987 section
2.1 reproduces this id. 137 distinct sentences were examined…"_ — which reads as _the text
changed_. It did not. The reader is sent to diff a document against itself.

Scope note, stated honestly: the worse variant — identical id, resolver finds the same text
in the _first_ same-numbered section, and reports `verified` with a byte span in the wrong
section — has **0 current instances** (checked: `GROUP BY rfc, number, exact_text HAVING
count(DISTINCT section_id) > 1` returns 0 rows). It is reachable, not observed. The
`not_found` variant above is observed.

`verifyCitation` accepts `block_id` and `char_start` as narrowers but there is no
`section_id` input and no way to say "the second section numbered 2.1".

---

## 2. `''` as "never minted" — is it said, and is it presented as a real id?

**Write-path coverage: complete.** There is exactly one insert site for each table
(`database.ts:629` mentions, `database.ts:663` requirements), both inside `commitDocument`,
and both now bind `stable_citation_id` positionally. `commitDocument` is the only path: the
CLI `reanalyze` (`rfcService.ts:2770-2822`) and ingest both go through it; a re-derive calls
`retireSnapshots` + `DELETE FROM snapshots WHERE rfc = ?` first, so there is no second
insert. The `"never minted" and "minted from a section number nobody can name" are different
states` fallback in `stableCitationIdsFor` (`database.ts:1731-1740`) is **dead code for
parsed bundles** — blocks are only ever created inside the per-region loop at
`src/parse/text.ts:265-279`, so every `block.section_id` is a `bundle.sections` id. So `''`
occurs only for rows written before migration 8.

**Three defects in how `''` is handled:**

1. **The lookup treats `''` as never-minted, the response does not.**
   `database.ts:1167` filters `AND stable_citation_id != ''` — correct. But
   `rowToRequirement` (`database.ts:1936`) and `rowToMention` (`database.ts:1998`) assign
   `stable_citation_id: row.stable_citation_id` unconditionally, so the API ships
   `"stable_citation_id": ""` on every requirement and mention of a pre-migration-8 corpus.
   The type is `readonly stable_citation_id?: string` (`types.ts:285`, `types.ts:414`), so a
   consumer testing `!== undefined` treats `""` as a real id; only a truthiness test catches
   it. **No `reading_rules` entry and no note says blank means never-minted** — the one
   contract line about the field (`rfcService.ts:2540`) never mentions it.

2. **The store's own comment asserts a distinction the column cannot make.**
   `database.ts:1740-1742`: _"A row whose section is absent from the bundle gets `""`, not a
   guess. 'Never minted' and 'minted from a section number nobody can name' are different
   states and the column has to be able to say so."_ Both states are `""`. The column cannot
   say so; the comment claims it can.

3. **The type's "always present on anything read back from the store"** (`types.ts:271`) is
   technically true and is exactly the problem: the field is always present, and its absence
   of information is not marked.

---

## 3. Is the id's input actually stable? Reasoned from `src/parse/text.ts`

**The number never moves.** `findHeadings` copies the number straight out of the printed
line — `NUMBERED_HEADING.exec(trimmed)` group 1 at `text.ts:598-605`, `APPENDIX_HEADING` →
`` `Appendix ${appendix[1]}` `` at `text.ts:585-596`. There is no renumbering pass anywhere.
So the specific worry — "if indented-heading recognition changes, does a section's number
move?" — is **answered no**. RFC 1122's `3.3.1` is `3.3.1` whatever the parser does with
underlining.

**But the sentence's _assignment_ to that number is parse-produced, and that is the real
failure mode.** `citation.ts:66-81` claims: _"Every input here is content the RFC Editor
published, not something the parse produced."_ True of the number string; **false of the
mapping**. Evidence:

- `isIndentedSubsectionHeading` (`text.ts:457-470`) returns false unless **all** of:
  the number has a `.`; `knownTopLevel.has(firstComponent)`; `isHeadingLike(rest)`; and
  `nextIndent > indent`.
- `knownTopLevel` (`text.ts:558-566`) is built from a **whole-document** pass over
  `toc.numbers` ∪ `isHeadingLike`. Change recognition anywhere and this set changes
  everywhere.
- If one indented heading is rejected, its text falls through to the **parent** section
  (`text.ts:264-279`, blocks are cut from the region between headings). The parent's number
  differs, so **every sentence under the lost heading gets a different stable id** — silently,
  as `not_found`.

So the id survives block-id and byte-offset churn (the thing that was asked for, and
genuinely fixed — see the good test at `citation-stability.test.ts:233`). It does **not**
survive heading-recognition churn, and heading recognition is precisely what this project
has been changing: `isUnderlinedHeading` and `isIndentedSubsectionHeading` are recent
additions, and the bench guard added in this same diff exists because they were just found
to be wrong on 63 headings. Nothing in the docs, the schema comment, or the capability text
qualifies the stability claim with "as long as the same headings are recognised".

**`occurrence` and the `ambiguous` verdict — traced, and it is correct.**
`verifyStableCitation` (`rfcService.ts:2130-2152`) groups sentences by `text_sha256` in
document order, then tries `occurrence = 0 … group.length - 1` against `stableCitationId`.
A sentence in two blocks of one section lands in one group of two, matches at occurrence 0
(the only value the store ever mints), and `matched = group` — **both** spans. Then
`rfcService.ts:2203-2207` returns `ambiguous` with both spans named. It does **not** return
`verified` pointing at the first. `block_id` and `char_start` narrow it (2181-2195) and a
narrowed single span then falls through to `verified`/`stale`. This is right, and
`citation-stability.test.ts:416` exercises it for real.

One honest gap: `citation.ts:76-78` says occurrence "lets a caller that DID count keep the
two apart in its own records". The server never mints occurrence 1 (store:
`database.ts:1738`, candidates: `rfcService.ts:1468`), and `stableCitationId` is not exported
through any tool, so a caller cannot mint one except by brute-forcing the hash. The
docstring is careful to say verification is unaffected, so this is accurate, just aspirational.

**Dispatch order vs. integrity checks — correct.** `verifyCitation` resolves the snapshot,
fetches raw bytes, and checks `sha256Hex(raw) !== snapshot.raw_sha256` at
`rfcService.ts:2281-2307` **before** `if (kind === "stable") return this.verifyStableCitation(...)`
at 2315. A stable id cannot be verified against bytes that do not hash to the snapshot.

**Stable id with no snapshot id — honest.** `rfcService.ts:2264-2266`: with no
`snapshot_id` but an `rfc`, it anchors to `getLatestSnapshot(rfc, "txt")`; with neither, it
returns `not_found` / "no snapshot to verify against" / `citation_id_kind` still reported.
The response never claims a pin it does not have. (Pre-existing, unchanged.)

**One wrong-input defect:** `rfcService.ts:2095` takes
`const rfc = input.rfc ?? snapshot.rfc` and then uses that `rfc` in the **hash** at 2142
while looking the section up **in the pinned snapshot** at 2119. So
`verifyCitation({snapshot_id: <RFC 7230>, citation_id: <scit>, rfc: 2119, section: "2"})`
hashes with 2119, searches RFC 7230's section 2, and cannot match. It correctly warns
(`rfc_does_not_match_pinned_snapshot`) but then adds the note _"the id was resolved against
the pinned snapshot, which is RFC 7230, not RFC 2119"_ — describing a search that could not
have succeeded. It should either hard-error or hash with `snapshot.rfc`.

---

## 4. Cost of the resolver

`sectionSentences` (`rfcService.ts:2033-2046`) reads **every** block of the section via
`getBlocksForSection` (`database.ts:951-959`, **no `LIMIT`**), splits each into sentences,
and computes `textHash` per sentence. `getBlocksForSection` is the only block read in the
codebase without a cap — its sibling `listBlocksWithKeywords` (`database.ts:1186`) caps at
5000, and `read` enforces `max_output_bytes` (16 KB default) and reports `truncated`.
`verify_citation` applies **no byte budget, no cap, and reports no truncation**.

Per call: O(section bytes). The match loop is O(distinct sentences) hashes, not O(n²) —
measured worst case in this corpus is RFC 2328 "References", 367 blocks / 101 562 chars,
which is single-digit milliseconds. So **not** a practical denial of service on this corpus.

The genuine quadratic term is `byteOffsetInBlock` (`rfcService.ts:2913-2916`): it does
`block.text.slice(0, relative)` + `Buffer.byteLength` **twice per sentence**, i.e.
O(sentences × block_bytes) per block. Largest single block in the corpus is RFC 9293
Appendix B at **38 015 chars** preformatted → tens of MB of string copying per call. Small
today, unbounded by construction, and no per-call memoisation means a batch of N
citations against one section pays N × (full section re-read + re-split + re-hash).

**Verdict: not a DoS, but the only path in this change with no bound at all**, and the
section it reads is chosen by the caller. Worth a `LIMIT` and a `truncated` note for
consistency with `read`.

---

## 5. Candidate paging

**Counts come from the same analysis on every page — correct.** `analyzeNormativeCandidates`
runs unconditionally at `rfcService.ts:1415-1421`, before `page` is computed at 1478. Both
branches spread the identical `candidateTotals` object (1479-1499). `tests/service.test.ts:787`
asserts `total`, `returned`, `by_keyword_case`, `by_shape`, `by_role`, `by_reason` and
`sentence_fragments` are equal across pages — a real check, not a tautology.

**`page` is exact.** `page = Math.floor(offset / limit) + 1` (1478), `offset` comes from the
MAC'd cursor (1320), and `getRequirements` (`database.ts:1083-1085`) is
`SELECT * … ORDER BY char_start, id LIMIT ? OFFSET ?` with no `DISTINCT` or row-dropping
join, so `rows.length === min(limit, total - offset)` and `offset` is always a multiple of
`limit`. No drift, no page-1 repeat. `limit` is part of the cursor `binding` (1319), so
changing `max_results` invalidates the cursor.

**Cursors are safe.** `decodeCursor` (`src/core/util.ts:129-139`) MAC-checks before parsing
and rejects a foreign `binding`; out-of-range cursors cannot be forged without the secret,
malformed ones raise `INVALID_CURSOR`. Nothing to fix.

**Byte cost removed, latency not.** The 29 s the comment cites is spent in the analysis
itself (`rfcService.ts:1472-1474` says so: _"of which the requirement rows are a rounding
error"_), and the analysis still runs in full on all 50 pages of RFC 3261. The change
removes re-shipped JSON — which the note claims, and which
`tests/service.test.ts:839` verifies with a `JSON.stringify` size comparison — and nothing
else. Honest, but it does not address the cost it names.

**Two payload defects:**

- **Page ≥ 2 with zero candidates emits a false stub.** `rfcService.ts:1519-1531` has no
  `whole.length > 0` guard (the warning at 1538 does). A document with more than `limit`
  strict requirements and no candidates — any modern RFC with only uppercase `MUST`s —
  gets `candidates: []`, **`omitted_on_page: 2`**, and the note _"The 0 candidate rows are
  complete on page 1 and are not repeated on later pages"_. This directly contradicts the
  contract line added in the same change (`rfcService.ts:2541`): _"An empty candidate list
  and a stub are distinguishable: only a stub sets `omitted_on_page` above 0."_ It is not
  distinguishable.
- **No combination yields page 2 with rows missing and no stub** — the stub is emitted
  unconditionally for `page !== 1`, so that specific hole does not exist. The inverse hole
  above is the one that is open.

**`include_provisional` paging** correctly drops provisional rows and says so
(`coverage.provisional_omitted_on_page`) — but see 1.1 for the warning it emits alongside.

---

## 6. `src/parse/text.ts` — the byte-identical claim

**VERIFIED TRUE.**

```
$ git diff --stat src/parse/text.ts      # (no output)
$ git diff src/parse/text.ts             # (no output)
$ git status --porcelain src/parse/text.ts   # (no output — not modified, not untracked)
```

Byte-identical. `git log` confirms the last commit touching it is `a48fa2c`, already
committed. Nothing downstream of the claim is suspect on this count.

## 7. `eval/lib/labelling.mjs` — can the new `danglingHeadings` guards miss a real defect?

The two new suppressions are **parser-aligned**, which is the right test for an invariant
whose subject is "a heading the parser dropped":

- `KEYWORD_LEAD` in `labelling.mjs` is **byte-identical** to `src/parse/text.ts:109-110`,
  and the parser applies it inside `isHeadingLike` (`text.ts:542`) to the same
  post-number substring the regex captures as `m[2]`. Anything it suppresses is a line
  `isHeadingLike` rejects too, so the parser would not have called it a heading either.
  **No miss introduced.**
- `continuesAtSameIndent` is the exact inverse of `isIndentedSubsectionHeading`'s
  `nextIndent > indent` (`text.ts:465-469`) for the indented case, and it skips blanks the
  same way `nextContentLine` (`text.ts:392-400`) does. Page furniture is not a hazard here
  because the only caller passes `read`'s furniture-**blanked** `text`
  (`rfcService.ts:918-919 blankLines`, one object at `run-bench.mjs:329-336`) — the
  difference from the parser's `nextContentLine`, which skips furniture rather than seeing
  it blanked, is neutralised on this path. **No miss introduced for indented headings.**

**One real miss, in the join.** `run-bench.mjs:339-341` passes
`danglingHeadings(texts.join("\n"), …)` — the texts of _several_ sections concatenated. A
dangling heading on the **last line of section N** is then judged against the **first line
of section N+1**. If that line's indent is ≤ the heading's, `continuesAtSameIndent`
returns true and a real dangling heading is suppressed. The doc comment reasons explicitly
about "a sampled section that ends on its own title" (the no-evidence case, correctly
handled) but not about the join boundary.

Pre-existing holes, unchanged by this diff and parser-consistent, listed for completeness:
`HEADING_SHAPE`'s `.{0,70}` means a real title longer than 71 characters never matches, and
`/[.;,]$/` still skips titles ending in a period — `isHeadingLike` rejects both
(`text.ts:537-538`), so neither is a miss relative to the parser.

**Verdict: the guard cannot miss a defect the parser would have caught, except at a
section join in the bench's own caller.** Not "worse than no guard".

---

## 8. `eval/run-bench.mjs` and `eval/corpus.json` — the measurement path

**The four headline numbers are computed exactly as before. The diff only adds.** RECALL,
PRECISION, CALLS and VERIFY all derive from `golden.rules` / `golden.json`; the new block is
inserted at line 303, after the precision sample is written (290) and after `CALLS` is
snapshotted (233-240).

**The "reads are not counted in CALLS" claim is TRUE and verified two ways:**

1. `eval/lib/mcp.mjs` `call()` only speaks JSON-RPC; it touches no counter. The counters
   live in the harness wrapper `call(name, args, bucket)` at `run-bench.mjs:60-64`, and the
   guard calls `mcp.call("read", …)` directly (`run-bench.mjs:306, 330`), bypassing it.
2. `CALLS.calls_total` is captured from `callTotal` at line 237, i.e. **before** the guard
   runs at 303. The post-hoc `calls_after_invariants: callTotal` (line 478) is emitted after
   the guard and is still equal — confirming the guard incremented nothing.

No new `mcp.call` can alter a measured value: the guard only calls `read` against an
already-pinned `snapshot_id` with no `refresh`, and every measured phase has already run.

**`eval/corpus.json` was regenerated and its document set GREW: 151 → 159**, adding RFCs
3597, 8490, 8903, 8949, 9197, 9463, 9499, 9606 (plus `pb`/`pv`/`ev`/`at` churn on every
entry). Consequences:

- The four headline numbers are **unaffected** — they come from `golden.json`.
- **Phase 6 invariants ARE affected**: `run-bench.mjs:351` does
  `const all = corpus.documents` and iterates every document, so `zero_strict_requirements`,
  `zero_strict_and_zero_candidates` and `dup_pct` now cover 159 documents instead of 151.
  That is an unflagged change to a reported number's denominator, in the same diff, not
  called out anywhere.
- The file's own `note` is **false**: _"Selection and labelling never read this file - only
  the count of documents does."_ Line 351 reads the array, not the count.

---

## 9. Documentation claims in `capabilities` and tool descriptions

Checked each. Results:

| claim                                                             | verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page_furniture_lines` is emitted whenever `text_fidelity` is     | **TRUE.** Same object literal, same guard (`rfcService.ts:948-966`), condition `furnitureLines.length > 0 && text !== null`.                                                                                                                                                                                                                                                                                                                                                                                              |
| Both citation id kinds are reachable and distinguished            | **TRUE.** `citationIdKind` (`citation.ts:55-58`) is populated on all six return paths including the five early returns (`2252, 2268, 2283, 2296, 2432`); the patterns are disjoint and `scit_…` fails `^cit_[0-9a-f]{24}$`.                                                                                                                                                                                                                                                                                               |
| The named loss counters are the ones emitted                      | **TRUE.** `coverage.keyword_bearing_blocks_skipped` (`rfcService.ts:1378`, from `snapshot.keyword_bearing_unscanned_block_count` at 1352 — read, not recomputed, as claimed) and warning `normative_text_in_unscanned_blocks:N` (`1354-1357`).                                                                                                                                                                                                                                                                            |
| `parse_notes` describes what `findHeadings` recognises            | **INCOMPLETE.** `findHeadings` recognises five things — column-0 numbered, indented numbered subsections, appendix headings, underlined titles, fixed unnumbered titles (`text.ts:585-626`). The note names two. Worse, "a document whose warnings carry neither is expected to be in the modern generated format" (`rfcService.ts:2549`) is backwards for the case that matters: a **typeset** RFC where indented recognition _failed_ emits neither warning and is described as modern-generated. Hedged by "expected". |
| "An empty candidate list and a stub are distinguishable" (`2541`) | **FALSE.** See §5 — the zero-candidate page-2 stub sets `omitted_on_page: 2`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| "Line counts are equal in both" (`964`)                           | **FALSE when `truncated`.** `text` is truncated at `927-931` before the literal is built at 963, so `text_clean` is a prefix and the counts differ. Pre-existing sentence, but this diff re-endorses it and bolts a second claim onto the same string. Also the whole block is gated on `text !== null`, so a `format: "structured"` read of a pre-1990 RFC emits neither `text_verbatim` nor `page_furniture_lines`, while `tools.ts:172` says "on a pre-1990 RFC the response also carries `text_verbatim`".            |
| Corpus figures in the comment above `limits_notes` (`2560-2564`)  | **STALE.** "Corpus-wide, 278 non-prose blocks carry an RFC 2119 keyword" → the live corpus sums to **397**. "RFC 1122: 312 blocks skipped, **19** of them keyword-bearing" → the snapshot row says **11**. (312 skipped is correct.) These are in a source comment, not in the shipped string. The same 278 appears at `src/analysis/normative.ts:1101-1102` — **in-flight file**, as of md5 `bd2a04c5…`.                                                                                                                 |

---

## 10. Tests — would each fail if the mechanism were removed?

| test                                                                                                   | would it fail?                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `citation-stability.test.ts:233` two parses, ids and offsets moved                                     | **YES.** Genuine and the strongest test in the change. Rewrites every section/block id and every offset, commits to two stores, asserts equal `stable_citation_id` per `exact_text` **and** unequal `citation_id`. Fails the moment the id is a function of block id or offset.                                                                        |
| `citation-stability.test.ts:306` different section/rfc/text/occurrence                                 | **YES.** Four real inequality assertions on a pure function.                                                                                                                                                                                                                                                                                           |
| `citation-stability.test.ts:322` "gives one id to a sentence that stands in two blocks of one section" | **NO — VACUOUS.** `stableCitationId({rfc, sectionNumber, quote})` compared `.toBe` `stableCitationId({rfc, sectionNumber, quote})` — **identical arguments**, lines 326-328. Passes if `stableCitationId` were `() => "x"`. The property it names is genuinely covered by the `ambiguous` test at :416, so nothing is lost — but this test is a no-op. |
| `citation-stability.test.ts:364` verified against the minting snapshot                                 | **YES.** Real end-to-end through the service.                                                                                                                                                                                                                                                                                                          |
| `citation-stability.test.ts:386` stale against a clone derivation                                      | **YES.** `cloneDerivation` builds a genuine second snapshot with **no** requirement/mention rows, so `here` is empty and `mintedIn` non-empty. Exercises exactly the branch. Excellent.                                                                                                                                                                |
| `citation-stability.test.ts:416` ambiguous, both spans, narrowed by `block_id`                         | **YES.** Asserts 2 matches, 2 distinct `block_id`s, 2 distinct `byte_start`s, and that `block_id` narrows to `verified`. Would fail a first-match resolver.                                                                                                                                                                                            |
| `citation-stability.test.ts:448` refuses without `section`                                             | **YES.**                                                                                                                                                                                                                                                                                                                                               |
| `citation-stability.test.ts:455` snapshot-scoped path unchanged                                        | **MOSTLY.** The loop is real. But the closing comment says _"an id that matches neither shape is reported as such"_ and then asserts `citation_id_kind === "snapshot_scoped"` for `"cit_000000000000000000000000"` — which **does** match the `cit_` shape. The `unrecognized` branch of `citationIdKind` is never exercised anywhere in the suite.    |
| `service.test.ts:761` loss counters in the contract                                                    | **YES.** Reads the real `capabilities` payload.                                                                                                                                                                                                                                                                                                        |
| `service.test.ts:779` both citation id kinds in the contract                                           | **YES.**                                                                                                                                                                                                                                                                                                                                               |
| `service.test.ts:787` page 1 rows / page 2 located stub                                                | **YES.** The best paging test: asserts counts equal across 6 named fields, `omitted_on_page` 0 then 2, the warning text, the note text, and a `JSON.stringify` byte reduction. **Misses** the zero-candidate case (§5).                                                                                                                                |
| `service.test.ts:842` rows reachable again by dropping the cursor                                      | **WEAK BUT NOT VACUOUS.** Compares two identical page-1 calls. Would fail if the stub shipped on page 1.                                                                                                                                                                                                                                               |
| `service.test.ts:872` `stable_citation_id` on every requirement and candidate                          | **NO — VACUOUS.** Asserts only `/^scit_[0-9a-f]{24}$/` on strings the same code path just produced, plus `length > 0`. Every id could be the same constant. It never verifies one — which is exactly why finding **1.2** is invisible to the suite.                                                                                                    |
| `store.test.ts:109` migration adds the column                                                          | **YES.** Builds a real legacy DB, checks fresh-vs-migrated column parity and idempotent re-open.                                                                                                                                                                                                                                                       |
| `store.test.ts:132` `''` for a pre-8 row                                                               | **YES.** — and it **enshrines** the `''`-on-the-wire behaviour that §2 flags. Also asserts `stableCitationOrigins("")` returns `[]`, which is the correct lookup guard.                                                                                                                                                                                |
| `store.test.ts:163` index in the migration, not the base schema                                        | **YES** for the two index assertions. `expect(step?.backfills ?? []).toEqual([])` is near-vacuous — it asserts the absence of a property, true of any migration that omits it — but it does pin the documented decision.                                                                                                                               |
| `protocol.test.ts:157` furniture field named on both surfaces                                          | **YES.** Over the real wire.                                                                                                                                                                                                                                                                                                                           |
| `protocol.test.ts:175` typeset reach                                                                   | **YES.** Over the real wire.                                                                                                                                                                                                                                                                                                                           |
| `text-parser.test.ts:185` TOC promise + indented heading count as one                                  | **YES.** Drives the real parser twice, asserts the recovered number, both warning counts, and the exact surviving warning number.                                                                                                                                                                                                                      |

**No test at all** for: the `provisional_entries_included` warning on page ≥ 2 (1.1);
verifying a **candidate's** `stable_citation_id` (1.2); a duplicated section number (1.3);
the zero-candidate page-2 stub (§5); `include_provisional` on page ≥ 2; `input.rfc`
mismatching the pinned snapshot; the `unrecognized` id kind.

---

## 11. Summary table

| #    | change                                                                                                                                                                                 | verdict                  | evidence                                                                                                                                                                                    | severity |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1.1  | `provisional_entries_included:N` on page ≥ 2                                                                                                                                           | **wrong**                | `rfcService.ts:1555-1567`: `else` branch puts 0 provisional rows in `data.requirements`, warning still pushed with `provisional.length`. 49 wrong warnings per RFC 3261 read.               | **high** |
| 1.2  | candidate `stable_citation_id` never verifies; note blames a stale corpus and prescribes `reanalyze --all`, which cannot fix it                                                        | **wrong**                | minted at `rfcService.ts:1465-1468`, never stored; `database.ts:1161-1174` searches only `requirements`/`mentions`; failure branch `rfcService.ts:2229-2236`                                | **high** |
| 1.3  | `getSectionByNumber` `LIMIT 1` vs duplicated section numbers                                                                                                                           | **wrong**                | `database.ts:924-929`; 113/159 snapshots affected; RFC 1350 has 10 sections numbered `2`; 1 requirement + 11 mention rows currently unresolvable (RFC 3987 `2.1` ord 14)                    | **high** |
| 2.1  | `stable_citation_id: ""` shipped on every pre-migration-8 row with no marker; no contract line says blank = never-minted                                                               | **incomplete**           | `database.ts:1936, 1998`; guard only in the lookup at `1167`; `reading_rules` at `2540` silent; `types.ts:285` optional-`string`                                                            | medium   |
| 2.2  | comment claims the column distinguishes two states it collapses to one                                                                                                                 | **wrong (comment)**      | `database.ts:1740-1742` vs `1738`                                                                                                                                                           | low      |
| 3.1  | section number never renumbers — the specific worry is unfounded                                                                                                                       | **correct**              | `text.ts:598-605`, `585-596`; no renumbering pass                                                                                                                                           | —        |
| 3.2  | doc claims every input is "not something the parse produced"; the sentence→section _assignment_ is parse-produced and does move                                                        | **wrong (doc)**          | `citation.ts:66-81` vs `text.ts:457-470`, `558-566`, `264-279`                                                                                                                              | medium   |
| 3.3  | duplicate sentence → `ambiguous`, never first-match `verified`                                                                                                                         | **correct**              | `rfcService.ts:2130-2152, 2181-2207`; `citation-stability.test.ts:416`                                                                                                                      | —        |
| 3.4  | integrity checks precede the stable dispatch                                                                                                                                           | **correct**              | `rfcService.ts:2281-2315`                                                                                                                                                                   | —        |
| 3.5  | stable id with no snapshot id is honest                                                                                                                                                | **correct**              | `rfcService.ts:2264-2279`                                                                                                                                                                   | —        |
| 3.6  | `input.rfc ≠ snapshot.rfc` hashes the wrong RFC and reports a search that could not have run                                                                                           | **wrong**                | `rfcService.ts:2095` + `2119` + `2142`                                                                                                                                                      | low-med  |
| 4    | resolver cost O(section bytes)/call, no cap, `byteOffsetInBlock` quadratic in block size                                                                                               | **incomplete**           | `rfcService.ts:2033-2046, 2913-2916`; `database.ts:951` has no `LIMIT` (cf. `1186`); largest section 101 562 chars, largest block 38 015                                                    | low-med  |
| 5.1  | counts identical on every page, same analysis, `page` exact, cursors safe                                                                                                              | **correct**              | `rfcService.ts:1415-1421, 1478-1499`; `database.ts:1083-1085`; `core/util.ts:129-139`                                                                                                       | —        |
| 5.2  | page ≥ 2 with zero candidates emits a false stub, contradicting the contract line added alongside                                                                                      | **wrong**                | `rfcService.ts:1519-1531` (no `whole.length > 0` guard) vs `2541`; cf. the warning at `1538` which _does_ guard                                                                             | medium   |
| 5.3  | bytes removed, latency untouched (analysis still runs on all 50 pages)                                                                                                                 | **incomplete**           | `rfcService.ts:1415` precedes `1478`; own comment `1472-1474` names the rows as "a rounding error" of the 29 s                                                                              | low      |
| 6    | `src/parse/text.ts` byte-identical                                                                                                                                                     | **correct**              | `git diff --stat` / `git diff` / `git status` all empty for the file                                                                                                                        | —        |
| 7    | new `danglingHeadings` guards are parser-aligned; one miss at a section join in the bench caller                                                                                       | **correct / incomplete** | `labelling.mjs` `KEYWORD_LEAD` ≡ `text.ts:109-110` applied as `isHeadingLike` does at `542`; `continuesAtSameIndent` ≡ inverse of `text.ts:465-469`; `run-bench.mjs:339-341` joins sections | low      |
| 8.1  | bench's four numbers unchanged; guard's reads genuinely outside CALLS                                                                                                                  | **correct**              | `mcp.mjs` `call()` touches no counter; `CALLS` snapshotted at `run-bench.mjs:233-240` before the guard at `303`; `calls_after_invariants` at `478` still equal                              | —        |
| 8.2  | `corpus.json` 151 → 159 docs changes the Phase 6 invariant denominators, unflagged; the file's `note` claiming only the count is read is false                                         | **wrong**                | `run-bench.mjs:351` iterates `corpus.documents`; added RFCs 3597, 8490, 8903, 8949, 9197, 9463, 9499, 9606                                                                                  | low      |
| 9.1  | `page_furniture_lines` emitted whenever `text_fidelity` is; both id kinds reachable; named loss counters are the ones emitted                                                          | **correct**              | `rfcService.ts:948-966`; `2252/2268/2283/2296/2315/2432`; `1378`, `1354-1357`                                                                                                               | —        |
| 9.2  | `parse_notes` names 2 of 5 recognition rules; "neither warning ⇒ modern generated" is backwards for a typeset doc whose recognition failed                                             | **incomplete**           | `rfcService.ts:2545-2550` vs `text.ts:585-626`, `142-143`                                                                                                                                   | low      |
| 9.3  | "Line counts are equal in both" false under `truncated`; the block is absent for `format: "structured"`                                                                                | **wrong**                | `rfcService.ts:927-931` vs `963-964`; `948` gate; `tools.ts:172`                                                                                                                            | low      |
| 9.4  | corpus figures in comments stale (278 → 397; RFC 1122 19 → 11)                                                                                                                         | **wrong (comment)**      | `rfcService.ts:2560-2564` vs live corpus; same 278 at in-flight `normative.ts:1101`                                                                                                         | low      |
| 10.1 | `citation-stability.test.ts:322`                                                                                                                                                       | **vacuous test**         | `stableCitationId(identical args)` compared to itself, lines 326-328                                                                                                                        | —        |
| 10.2 | `service.test.ts:872`                                                                                                                                                                  | **vacuous test**         | shape-only regex on freshly minted strings; no id is ever verified — hides 1.2                                                                                                              | —        |
| 10.3 | `citation-stability.test.ts:466-472`                                                                                                                                                   | **vacuous (partly)**     | comment says "matches neither shape"; the id matches the `cit_` shape; `unrecognized` never exercised                                                                                       | —        |
| 10.4 | `store.test.ts:174` `backfills ?? []`                                                                                                                                                  | **vacuous (partly)**     | asserts absence of a property                                                                                                                                                               | —        |
| 10.5 | `citation-stability.test.ts:233, 306, 364, 386, 416, 448`; `service.test.ts:761, 779, 787, 842`; `store.test.ts:109, 132, 163`; `protocol.test.ts:157, 175`; `text-parser.test.ts:185` | **real tests**           | each drives real code and fails if its mechanism is removed                                                                                                                                 | —        |

## 12. Ranked: what would ship a confidently wrong answer

1. **1.1** — a `warnings[]` entry asserting `provisional_entries_included:2000` on a
   response containing zero provisional rows, 49 times per RFC 3261 read. Machine-readable
   and self-contradicting.
2. **1.2** — every `stable_citation_id` this server mints on a candidate row is permanently
   unverifiable, and the error message tells the reader to run `reanalyze --all`, which
   cannot help. The feature's headline promise is false for the list it was added to.
3. **1.3** — 1 requirement row and 11 mention rows in the live corpus carry an id that
   resolves against the wrong section and answers `not_found` with a note implying the
   document changed. 113 of 159 snapshots are exposed; the count grows with every
   table-row-as-heading parse defect.
4. **5.2** — page 2 of a candidate-free document reports `omitted_on_page: 2` and "The 0
   candidate rows are complete on page 1", contradicting the contract sentence added in the
   same change.
5. **3.2 / 2.1** — the stability and never-minted claims are stated more strongly than the
   code supports, which is the failure mode this project's own review rules single out.
