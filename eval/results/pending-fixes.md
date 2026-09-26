# Pending fixes, with evidence

Everything here was found by measuring, not by reading. Sources: the supplementary golden
set (`eval/golden-ext.json`) and the read-only diagnosis of six reported strict misses
(`eval/results/strict-miss-diagnosis.md`). Each item carries the query or tool call that
reproduces it and the population it affects.

`src/parse/text.ts` and `src/analysis/normative.ts` were owned by other agents when these
were found, so they are recorded rather than fixed in place.

---

# Part 1 — parser (`src/parse/text.ts`)

## X1. The underline of a recognised heading is left in the section's text

`findHeadings` recognises an underlined title — that is the fix that gave RFC 768 an
addressable structure at all — but only the TITLE line becomes the heading. The rule of
dashes underneath it is not part of the heading, so `collectLines` puts it in the body and
it becomes the first line of the section's first block.

RFC 768, section "Fields", `text`:

    "------\n\nSource Port is an optional field, when meaningful, it indicates the port\nof the sending  process,  and may be assumed  to be the port  to which a\nreply should  be addressed  in  the absence of "

RFC 768, section "IP Interface", `text`:

    "-------------\n\nThe UDP module  must be able to determine  the  source  and  the  destination\ninternet addresses and the protocol field from the internet header."

Two consequences, both measured:

1. The first sentence of every underlined-heading section is `------ <the first real
   sentence>`. A sentence classifier reads a row of dashes as the sentence's opening, so
   the section's first real statement is neither classifiable nor quotable. It is why RFC
   768 yields **zero** golden rules despite containing "The UDP module must be able to
   determine the source and destination internet addresses" — a real obligation, in an
   addressable section, 46 years old.
2. A caller copying `text` — the field the tool documents as "the section's content with
   printing artefacts removed" — gets a row of dashes in the copy. That is the same class
   of defect as the running heads this release removed, one document class later.

Scope: all 75 underlined headings the parser recognises.

Fix: when `isUnderlinedHeading` accepts a line, the heading spans both lines and
`collectLines` skips both. Test: the section's `text` begins with the first real sentence,
and the first requirement of RFC 768 is the one above.

## X2. A date stamp is still a section, and its content is a running head

`28|Aug 1980` is in RFC 768's outline. Section "28" reads:

    "RFC 768                                           User Datagram Protocol\n                                                            IP Interface"

That is the running head of a printed page. The section has no RFC content in it at all.

This was reported in the previous review as fixed. It was not. The fix added the bare date
stamp to `PAGE_FURNITURE`, which `collectLines` consults when building BLOCKS — so the text
is blanked. `findHeadings` never consults `isPageFurniture`, so the line is still offered
to the heading matcher, `NUMBERED_HEADING` reads "28" as a number and "Aug 1980" as a
title, and the section is created regardless. Cleaning the text and refusing to recognise
the line are two different decisions and only one of them was made.

Fix: `findHeadings` skips furniture lines, exactly as `collectLines` does. Checked against
the whole corpus, not RFC 768: a date stamp is a page-level artefact and every typeset-era
document has one per page.

Consequence while it stands: a caller who lists RFC 768's outline sees a section called
`28` and reads a page header. That is worse than a missing section, because it is
confidently wrong.

## X3. Body prose that opens with a bracketed tag is typed as a bibliography entry

`classifyBlock` (`classifyBlock`, `src/parse/text.ts:825`) tests the first line against
`/^\s*\[\s*[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*,\s*(?:Section|Appendix)[^\]]*)?\s*\]\s+/` and
returns `reference_entry` for any block opening with a bracketed tag. A tag at the start of
a line is not evidence of a bibliography.

Two measured instances:

- RFC 4343 §4.1, block `blk_7385d25da50cac4bd4234afe`: `"   [STD13] views the DNS
  namespace as a node tree.  …"` — an entire body paragraph, quoted from another document,
  dropped before sentence splitting by both passes. The golden rule G0085 ("indirect labels
  may be used …") is inside it.
- RFC 9117 §5, block `blk_d33f3c8d355dfb9d96845365`: `"   [RFC8955] indicates that the
  originator may refer to …"` — a body paragraph whose second half is ordinary prose
  carrying "a network should be designed …" (G0229). The block holds ordinary body text at
  the same three-column indent as every other paragraph of §5; only its first line differs.

Population: **184** blocks are typed `reference_entry` outside a `references`/`index`/
`authors` section, across **45** documents. 2 863 of the 3 047 such blocks are genuine
bibliography entries. **6** of the 184 carry an upper-case RFC 2119 keyword, **22** carry a
modal token in any case, and **zero** requirement rows are reachable from any of the 184.

Fix: bound `reference_entry` by the enclosing section being a bibliography, or by the block
having citation shape (tag, author, title, RFC number, date). Both conditions, not either,
or a bibliography entry quoted in a body section becomes prose.

**Judgement call to report, not to hide:** RFC 4343 §4.1 is a *quotation of another
document*, and §4 is where 4343 states its own position. Restoring the block makes the
quoted "may" visible. Whether quoted material should be presented as this document's
obligation is a reading decision, not a parse decision. The fix must surface it — a row
flagged as quoted material — not promote it silently. Corpus-wide, the fix must also report
how many of the 184 it reclassified, because that number is the measure of how much text
was invisible.

## X4. The bare `o` list marker is not a list marker to the block classifier

RFC 5155 §7.2.8 sets a bulleted condition list with bare `o` markers. `classifyBlock`'s
list test (`src/parse/text.ts:828`) accepts `[-*•]` or `N.`/`(a)` but not `o`, so four list
items are typed `paragraph` — even though `normative.ts:1293` (`LIST_MARKER`) knows the bare
`o`, which is why the flag `list_marker_stripped_from_clause` exists and fires elsewhere.

This is **not** what loses the sentence: reclassifying them `list_item` would not merge
blocks, because the strict pass splits per block regardless of kind (see Y1). The previous
hand-review note that attributed the miss to "the list marker" is a misattribution. It is
still a real block-kind defect, because a caller reading `blocks[].kind` sees prose where
the RFC set a list.

---

## X5. `toc_sections_without_a_heading` caps the list at 20 and reports no count

The warning is correct about what it found — `missing = toc.numbers − headings.some(number)`
and `headings` already contains the indented and underlined results, so a section that IS
supplied cannot be reported. That was verified by mutation: comparing column-0 headings
only reproduces the old `["2.1","3"]` where the corrected answer is `["3"]`.

Two defects remain in the warning itself, both about how much it says:

1. **It lists at most 20 numbers and reports no count.** A document that lost 300 sections
   reads exactly like one that lost 3. The whole purpose of a warning is that a caller can
   tell whether the cause is trivial or structural, and a silent truncation destroys that.
   Fix: report the count always, and mark the list truncated when it is.
2. **A contents entry whose section is set as an underlined title is reported as missing.**
   Fixing it means fuzzy-matching a contents title to an underlined title. Not measured
   from here — RFC 768's contents sits at column 0, which ends the scan with an empty
   number set — so it is recorded unmeasured rather than assumed absent.

Fix 1 is a two-line change and is the one that matters: an unmeasured defect stays a
defect, but a truncated report is a defect on every document that triggers it.

# Part 2 — extractor (`src/analysis/normative.ts`)

## Y1. The strict pass splits sentences per block, so a block boundary is a sentence boundary

This is the mechanism behind both live strict misses, and it is the largest single recall
loss in the corpus.

`splitSentences` (`normative.ts:1146`) is applied **per block** from `analyzeNormative`
(`normative.ts:732`). `groupBlocks` (`text.ts:729`) ends a block at every blank line and at
every page break (furniture is deliberately emitted as an empty separating line,
`text.ts:704-708`). So a sentence the RFC set across a page break becomes two blocks, and
the strict pass keeps only the half that carries the keyword.

RFC 1812 §4.2.2.2, G0017. Block `blk_0d4ca37f91e8013b34ae310f` ends:

    "   option, it MUST use the IP address of the logical interface on which"

and the next block in the section begins "   the packet is being sent." Emitted as
`req_5d14c156a9b90728`, `flags_json = []`, `parse_status = complete`, `confidence = 0.9`,
with `clause.action` = "use the IP address of the logical interface on which" — dangling on
a preposition. The 154 characters between the blocks are the form feed, the running head
`RFC 1812 … June 1995` and `Baker … [Page 42]`.

RFC 5155 §7.2.8, G0099. "If the following conditions are all true: o … o … then the
response MUST be constructed as a Name Error response." is four blank-line-separated blocks;
the strict pass emits only the fourth, with `clause.actor` = "then the response" and
`condition` = `null`. The condition the requirement is conditional on lives in blocks 1–3
and is unreachable from the emitted row.

The candidate pass **already has** the missing mechanism: `previousEndedOpen`
(`normative.ts:1109`), `continuesPrevious` (`:995`), `isFragment` (`:1054`), surfaced as
`continues_previous_block`. The strict pass has none of it. The fix is to give it the same
join, in the same place, with the same evidence.

Population, re-measured by `eval/audit/confidently-wrong.md` at `index_generation 1980`,
each figure under a stated definition. The original measurement in this file (274 rows,
220 unflagged) is **not reproducible** and is superseded — it came from a broader
definition that was never written down, which is precisely the kind of number that must not
survive in a record:

| definition | rows | of which `flags: []` | labelled `complete` |
| --- | --- | --- | --- |
| block ends without terminal punctuation **and** a form feed lies before the next block | **129** | **92** | 111 |
| any block-boundary split the next block continues | 134 | 93 | — |
| any row labelled `complete` that is not a complete sentence | **486** | — | 486 |

Worst instance: `req_9181039dba52a121`, RFC 8470 §6.1, a Standards Track document from
2018 — `"…SHOULD either delay forwarding the"`, cut at a page break, with
`actor: "support for a given request"`.

Related symptom, same root: **97** strict rows begin lower case and are not list markers
(31 documents) — the "this row is a sentence tail" shape.

Fix: continuation-join in the strict pass, driven from the block sequence, and a fragment
flag when the join does not close. Both, because the join fixes the sentence and the flag
tells the caller which rows are still not whole.

## Y2. A truncated requirement is emitted as `complete` with confidence 0.9 and no flag

`analyzeNormative` has no `continues_previous_block` equivalent and no "this row is a
fragment" flag, so a requirement cut in half is reported as `parse_status: complete`,
`confidence: 0.9`, `flags: []`.

This is worse for a caller than a missing row, because `coverage.total_requirements` is
trusted. A contract generated from a fragment has an obligation whose action dangles on a
preposition, and nothing in the response says so. Fix: when the join does not close, set
`parse_status: "fragment"` and add the flag. The count may still include it — but it must
say so, and a separate counter must report how many rows are fragments.

## Y3. `non_strict_candidates` is not a safety net for a strict miss, by construction

`normative.ts:1048` (`analyzeNormativeCandidates`) drops every upper-case keyword that the
strict pass already owns in a prose block (`reason === null`). So when the strict pass
emits a fragment, the candidate channel has been deliberately emptied and the fragment is
in no second pool. Verified for both Y1 cases: 0 candidate rows and 0 `fragments` rows
contain either half.

A caller paging both channels and taking the union still loses the sentence. Fix: the
strict pass must not claim ownership of a keyword whose row is a fragment; that row belongs
in the candidate list, where the continuation machinery will join it.

## Y4. `keyword_bearing_blocks_skipped` is case-sensitive, so weak-tier losses are invisible

`coverage.keyword_bearing_blocks_skipped` tests `TERM_PROBE` (`normative.ts:72`), which is
case-sensitive. The candidate pass selects its blocks by `listBlocksWithKeywords`
(`database.ts:1184`), which uses SQL `LIKE` and is therefore case-insensitive. The same
predicate is expressed twice, with different case semantics, so the counter counts only
what the strict pass would have scanned.

Measured: the two X3 body blocks carry only lower-case modals, so `reference_entry: 2`
appears in `blocks_skipped_by_kind` while neither is counted by
`keyword_bearing_blocks_skipped`, and no `normative_text_in_unscanned_blocks` warning
fires. A caller reading only the counter cannot see that a body paragraph holding a
permission was dropped — which is the entire reason that counter exists, added this round
to make the loss knowable.

Fix: one predicate, one case semantics, shared by the counter and the selector. The
counter must be the union of what both passes skip.

## Y5. `read` and `requirements` disagree about the same sentence

In all four live cases `show --section` puts the whole sentence in `data.text` while
`requirements` returns a fragment of it or nothing. Verified: `show 4343 --section 4.1` and
`show 9117 --section 5` return the probe; `show 5155 --section 7.2.8` returns both halves;
`show 1812 --section 4.2.2.2` returns the joined sentence in `data.text_clean`.

The bench builds its probes from exactly that reading. So the bench is not wrong — but a
caller who reads a section and then asks for its requirements must not get less than they
just read, and today they do. This is the general statement of Y1+Y3 and it is the
acceptance test for both: **for every section in the corpus, the set of sentences in
`requirements` plus the set in `non_strict_candidates` must cover every keyword-bearing
sentence in the section's `text`.** That is a checkable corpus invariant, and it belongs in
`eval/run-bench.mjs` next to the other label-free invariants.

---

# Part 3 — found by the adversarial pass, measured per stratum

`eval/audit/strata.md` stratified all 166 ingested documents along era, length, purpose,
shape, encoding, structure and keyword stance, and built a **ceiling test** to separate
"the document says little" from "the tool read little": count scannable prose blocks
carrying an UPPER-CASE keyword (case-sensitively — SQLite `LIKE` is case-insensitive and
using it doubles the count and inverts the result), and compare against requirements
emitted.

## What the ceiling test settled, including against my own framing

**7 861 keyword-bearing blocks → 10 966 requirements. The minimum per-block yield across
the whole corpus is 1.000.** Only 4 documents emit fewer requirements than
keyword-bearing blocks, and all four are accounted for: their single keyword-bearing block
IS the BCP 14 boilerplate. **Zero documents have ≥20 keyword-bearing blocks and zero
requirements.**

So there is no measurable block-level loss on the strict path, and Y1's prize is smaller
than the raw counts suggest: the strict pass does not miss blocks, it emits **fragments**
of the blocks it does cover. Both findings are true at once — a truncated first half still
counts as a requirement row. The work is therefore "join the halves", not "find the
missing blocks".

Two of this audit's own claims were **retracted during the work** and are recorded here
because a retraction is a result:

- "Notation is unread" is worth ~0.5% of requirements, not the order of magnitude the raw
  token counts suggest: of 1 689 stranded RFC 2119 tokens in non-prose blocks, 1 159 are
  the BCP 14 boilerplate and only ~340 are ASN.1 `OPTIONAL`. **The tables-and-notation
  workstream drops to the bottom of the queue on measured value, not on principle.**
- "Outline pollution costs 15% of yield" was an artefact of averaging ratios. Ratio-of-sums
  reverses the sign, so the two disagree; the report now claims only what both support.

The pre-1995 collapse in requirements/KB (0.823 → 0.000) is entirely a BCP 14 case
convention the tool already reports: conditioned on `stance: adopts`, mean confidence is
flat to three decimals (0.8907–0.8964) across 46 years. The expectation that quality
degrades with era is **false here** — fragment rate is LOWEST in 2013+ at 0.74 per 1000
prose blocks, and the 63-heading defect is confirmed fixed: 10 headings remain corpus-wide,
in 2 documents.

## S1. Candidate-list contamination, concentrated exactly where the strict list is empty

The 38 zero-requirement documents are where the candidate list is the ONLY channel, and it
is contaminated there. **621 of 9 596 candidates (6.5%) come from non-prose blocks; 140 are
boilerplate or page furniture.** The worst case is the whole list: **RFC 854's candidate
list is 15 of 77 rows consisting of `RFC 854 May 1983` page headers**, each tagged
`keyword: "May", shape: demand`.

`May` is a month. The classifier found a modal, a shape and a section for a line of a
printed page header. This is the single most visible false positive in the corpus, and it
is on a document a caller is most likely to ask about.

## S2. `keyword_usage` contradicts the same response's count

RFC 1812 returns `stance: "disclaims"` together with the note that "a zero requirement
count is expected" **in the same response as `total_requirements: 555`.** Two of the
three detections in the corpus are false, and the field is absent for 52 of 166 documents.

The field exists to make a zero explicable, so a false "disclaims" is worse than its
absence: it tells a caller to distrust a count of 555 that is actually the largest in the
corpus. A response that contradicts itself needs a completeness verdict, which is the
`coverage.completeness` work already in flight — and a `keyword_usage` that can be
verified rather than guessed.

## S3. 73 fabricated sections in 15 documents, 119 KB misfiled, all `quality: complete`

RFC 876 files **93% of itself** under section numbers lifted from mid-sentence digits. A
caller asking for section `4` of RFC 876 gets a fragment of a sentence, and the response
says `quality: complete`. 15 documents, 119 KB, and no warning on any of them.

`classifyBlock`/`findHeadings` in `src/parse/text.ts` are the mechanism: a line beginning
with a number is offered to the heading matcher regardless of what follows it.

## S4. 83 KB unreachable by `read(section=…)`

Across 4 documents. Ten of RFC 2052's requirement rows are flagged `in_front_matter` —
text that carries a requirement and is not reachable by the section number printed beside
it.

## S5. The corpus cannot support conclusions about itself

- **166 of 9 842 catalogue documents (1.69%).** The sampling rule (even spread over RFC
  number) skews the set **×10.3 toward Internet Standards** and **×0.36 away from
  Informational** — in opposite directions on the same metric.
- **Zero documents above 633 KB.** The largest-document behaviour is entirely untested.
- **Zero XML parses, though 43 XML assets sit on disk.** This is the mechanical reason
  errata are not joined to rows: errata arrive as XML and the XML is never read.
- **Zero registry-shaped documents and zero re-ingestions** in the sample. The one-snapshot
  per document finding is therefore also a sampling finding: re-ingestion is not exercised
  at all.
- Non-ASCII peaks at 0.072% of text, so the multi-byte offset work is barely covered by the
  corpus that exercises it.

## H0. Sixteen requirement rows state the OPPOSITE of their sentence, at confidence 0.9

`<UPPER KEYWORD> not` falls through the phrase rule, so the row is emitted with
`polarity: "positive"`. `req_76dcffb7c47de7e6`: *"A registrar MUST not generate 6xx
responses."* is returned as **MUST / positive**. Plus 25 `MAY NOT` rows.

A caller building a contract from that row requires the registrar **to** generate 6xx
responses. The row is in `requirements`, not in the candidate list, and it carries
`confidence: 0.9` and no flag. **Every one of these satisfies the conservation invariant**,
which is the proof that reach is not fidelity: an invariant that counts sentences cannot
see a sentence reported with the wrong meaning.

The mechanism is a fallthrough: the classifier tests the multi-word phrases (`MUST NOT`)
and, when a bare keyword is followed by a separate `not` token, the polarity test never
runs. The fix is to fold a following `not` into the phrase before classifying, and to add a
test that asserts polarity for `MUST not`, `SHOULD not`, `MAY NOT` and `NOT RECOMMENDED`
where the negation is separated from the keyword by whitespace or a line wrap.

## H0b. A quoted field name two characters before the keyword deletes the sentence

`isQuoted` is a 2-character window. In RFC 1123 §5.2.16, `"domain" MUST NOT interpret…`
puts a `"` two characters before the keyword, so the sentence is classified as a
*definition* mention — and the candidate pass then deletes it, because the strict pass
"owns" the keyword. Verified live: the sentence is in **neither** channel, and the only row
anywhere is a mention with `disposition: "definition"`.

RFC 3261 §19.

`eval/audit/hostile-inputs.md`. Method: the build was stale, so the auditor transpiled the
working tree to a scratch directory and used `RFC_MCP_DATA_DIR` with a scratch corpus,
committing bytes through `CorpusStore.commitDocument` exactly as `reanalyze` does, and
fetched real RFCs from rfc-editor.org as a reality check. The corpus of record was never
opened. Every case below is reproduced from the report.

## H1. An HTML 503 error page becomes an RFC whose requirements verify — HIGHEST PRIORITY

`fetchPublication` records `contentType` and **never compares it** (`sources.ts:253`);
`http.ts:267` rejects only non-200 and non-404. So a server error page is stored as a
document and analysed as one. Measured result: `status: "ok"`, 2 requirements at
`parse_status: "complete"`, and `verify_citation: "verified"` — quoting
`<p>The server MUST be restarted.`

This is the worst failure this project can ship, and it needs no adversarial input: any
upstream hiccup during a sync produces it. Every other guarantee in the tool is downstream
of this one — a citation that verifies means the bytes verify, and the bytes are an error
page. The `degraded` fact surfaces only on `resolve`, one call later, so a caller reading
`requirements` never learns.

Fix, in order: reject a body whose `contentType` is not text on ingest, as an error rather
than a document; make the text sniff a second gate, because a server can serve HTML with a
correct content type; and make a document whose first non-blank line is `<!DOCTYPE` or `<html`
a degraded snapshot that refuses to yield requirements. Test with a real captured 503 page
and assert that no `requirements` row exists for it.

## H2. Invalid UTF-8: wrong offsets, `complete` snapshot, verifier says `verified`

Measured: `byte_start 36` for a quote that begins at byte 30, so
`raw.subarray(36, 62)` does not contain the quote, while `verify_citation` returns
`verified` — because it validates the **block's** span, not the record's span. This
independently confirms the citation finding, and it also means the two defects compose: a
record whose span is wrong verifies anyway.

The parser already knows. It emits `byte_offsets_approximate_invalid_utf8`, and that
warning is then dropped twice: by `ensureSnapshot`'s cached path, which passes
`warnings: []`, and by the `quality` predicate, which does not consider it. The tool
computes the truth and then discards it on the way out.

Latent against today's upstream — the auditor verified live RFCs are valid UTF-8 — and
that is exactly why it is dangerous: there is no defence in depth, and the day an
IETF source serves Latin-1, offsets will be wrong and verified.

## H3. 2 000 `MUST` lines yield `total_requirements: 1` with every counter reading zero

`blocks_skipped: 0`, `keyword_bearing_blocks_skipped: 0`, and `mentions` silently cut to
500 of 2 000 by a hard-coded `getMentions(…, 500)` with no flag and no cursor. So a
caller receives a coverage block certifying that nothing was skipped while 1 999 lines
were dropped, and 1 500 mentions vanished with no signal. The coverage counters are only
true while the corpus stays inside an undisclosed bound.

## H4. The extractor is quadratic in BLOCK LENGTH, not sentence count

33 293 ms for 115 KB. A single 4.6 MB line did not finish in 300 s. The control that
identifies it: the same 3 200 sentences cost **689 ms spread across short blocks and
13 363 ms in one block**, so it is not the sentence count. Four per-sentence O(block)
operations — `byteOffsetFromChar` and `codePointCount(block.text.slice(0, …))` at
`normative.ts` 1169, 1172, 1259, 1261 — inside the loop at 1109.

The 29 s defect I fixed earlier this session was the LOSS COUNTER, and I never measured the
extractor, which carries the same class of work. The general fix is to compute the
char-to-byte and char-to-code-point prefix tables once per block instead of once per
sentence.

## H5. `read` truncation lies, and `byte_cursor` is a dangling pointer

`read(max_output_bytes = 64)` on RFC 3261 §20 returns `text` of 64 characters and
`text_verbatim` of **4 039**, untruncated. And re-issuing with the returned
`offset_bytes` returns page 1 again, because `offset_bytes` is read only in the `raw_slice`
branch. Six real sections are affected today — five in RFC 3261, one in RFC 9110 — so
paginating a real document is broken right now, and the cursor a caller is handed points
at nothing.

## H6. An undisclosed 5 000-block bound makes `scanned_blocks` wrong

`listBlocksWithKeywords` stops at 5 000 blocks with no documentation, so a 6 001-block
document reports `scanned_blocks: 501`. A number that is wrong by a factor of twelve,
printed as a count.

## Also measured, smaller, each one a broken promise

- `requirements()` has no output cap: 797 KiB to 1.7 MB per call.
- 41.5 s for one `batch` of ten hostile `requirements()` calls.
- 14.7 s to parse 5 MB of blank lines.
- 10 001 duplicate sections produced **zero warnings**.
- Silent clamps on `search`, `references`, `read`, `dependencies` and `diff` — `requirements`
  warns about its own clamp, these five do not.
- **Two advertised limits do not exist**: `maxRawSliceBytes` and `maxCompletionValues` have
  zero references outside `config.ts`. `capabilities` advertises limits that are not
  implemented, which is the same class of failure as the literal
  `references_extracted: true`.

## Recorded as correct, so it does not get "fixed"

The degenerate cases behave: empty file, single character, whitespace only, ten thousand
blank lines, front-matter-only, no sections, unterminated quote. The table containing
`MUST NOT` does not enter the requirement list. And the real corpus is fast: RFC 3261 is
2 959 ms to ingest and about 760 ms per call. These are the cases a fix must not regress,
and the report names them for that purpose.

---

# Closed, not carried forward



Two of the six reported misses are not misses in the current build. Both are emitted
verbatim, `flags []`, and both are recorded as found in `after.json`, `after2.json` and
`after3.json`; only `before.json` records them as missed.

| case | row | text |
| --- | --- | --- |
| RFC 3501 §6.3.2, G0058 | `req_ef57b5b5a4df0dd4` | "No changes to the permanent state of the mailbox … EXAMINE MUST NOT cause messages to lose the \Recent flag." |
| RFC 2865 §5.22, G0040 | `req_bd53b91b5c5c7a2b` | "It is intended to be human readable and MUST NOT affect operation of the protocol." |
| RFC 2865 §5.22, G0041 | `req_e936227f15d10948` | "Whenever the gateway address is specified as \"0.0.0.0\" …" |

The pre-round state that produced those misses is not re-derivable: one snapshot per RFC,
re-derived after the `before` run. So the historical miss cannot be re-examined, only
closed. `eval/results/before-miss-review.json` must be updated to say resolved, with the row
id as evidence, and must stop carrying "Open."

Also worth recording, and faithful rather than a defect: "It is intended to be human
readable and MUST NOT affect operation of the protocol." occurs verbatim in RFC 2865 §5.22
(`req_bd53b91b5c5c7a2b`), §5.11 (`req_32c2f4aacce15a7d`) and with a comma in §5.18
(`req_351e1c0dd6f5f9e3`) — four rows for one sentence of wording.

## Golden-probe errors found: 0

All four live probes are faithful quotes. The bench builds a probe by splitting the
*section's* `text` on `(?<=[.!?])\s+` and collapsing whitespace (`eval/lib/labelling.mjs`),
i.e. from `show`'s `text`, which is the reading with page furniture blanked. That is why
four probes are longer than any single row the tool emits: the tool's blocks are cut at
page breaks and blank lines, the section text is not. In all four the extra text is the
RFC's own, so the fix belongs in the tool.

## Documented boundaries: 0 of 6

Neither recorded boundary applies. The anaphora note (RFC 2181 §5.5) does not apply to
G0040/G0041 — both are self-contained and emitted whole. The modality note does not apply
to G0085/G0229 — in those the sentence was never read at all, the block was discarded
before classification, so no deontic/descriptive judgement was ever attempted. Every one of
the four live misses is a mechanical loss with a general fix, and none of them needs a
judgement call to fix.
