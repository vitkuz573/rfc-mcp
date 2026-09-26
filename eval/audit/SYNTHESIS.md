# Synthesis: what the adversarial pass established

Ten read-only auditors worked this corpus from ten angles, each told to refute rather than
confirm, each required to show its attempts. This file is the consolidation, ordered by
consequence for a caller building a compliance contract. Sources are in `eval/audit/`;
per-finding evidence, queries and reproduction steps are in the individual reports and in
`eval/results/pending-fixes.md`.

## The one-line diagnosis

**The tool is exact about bytes and unreliable about itself.** The offset layer is right to
the character; the self-describing layer contains booleans that are literals, a confidence
score that is a lookup of another field, and a `truncated: false` printed while truncating.
That is precisely backwards from what a compliance contract needs: bytes are the cheap part
to get right, and the self-description is what a caller branches on.

## What is confirmed sound, with the attempts shown

This is not a short list and it is the reason the rest is worth fixing.

- **Offsets are exact.** 8 517 sections, 53 530 blocks, 10 966 requirement rows; every
  byte, char, code-point, line and hash check exact, including `raw[span] == text` — the
  decoded slice equals the stored text, not merely a plausible one. 0 mismatches.
- **Requirements' spans address their own text.** 12 209 of 12 209 in char, byte _and_
  code-point units, plus lengths and lines. 0 mismatches across six independent checks.
- **`verify_citation` works for what it is given.** 1 288 of 1 288 requirements and 2 829
  of 2 829 mentions verified.
- **Coverage counters are true.** Recomputed from the tables on 166 snapshots and through
  the tool on 159 documents: 0 mismatches.
- **Every duplicate is genuine.** All 160 duplicate-`exact_text` groups adjudicated, not a
  sample: each is backed by that many literal occurrences in the normalised document.
- **Tier separation cannot be violated.** A probe cannot be driven into the wrong pool; the
  ternary is not failable. The hand precision labels hold at 24 of 25 on independent
  re-judgement.
- The errata overlay, author-email stripping, the advertised surface counts, batch
  validation, zero-hit search flagging and `history` are all true as described.

## The four findings that break a contract

### 1. `confidence` carries no information

`confidence` is a pure function of `parse_status`: 10 586 rows at 0.9 and 380 at 0.7, no
third value, no variation within a status. It is a lookup dressed as a score. A caller
ranking a compliance list by confidence is ranking by a field that says "complete" vs
"provisional", which they can read directly. Either it earns its place by varying within a
status, or it should go; a confidence number that is a relabelled boolean teaches a reader
to trust a number.

### 2. `resolve.analyses.references_extracted: true` is a literal

It is asserted, not measured, over four documents whose reference sections yielded **zero**
rows: RFC 1812 (316 reference-section blocks), 1122 (70), 1123 (84), 3229 (30).
`dependencies(1812)` then reports 4 metadata edges, `unresolved: []` and
`truncated: false` — "this document cites nothing". A caller asking what a document depends
on is told the answer is empty, with a field asserting the analysis that would have found
the answer ran and succeeded.

### 3. `truncated: false` is printed while truncating

`dependencies(direction: "incoming")` returns **0** inbound edges while emitting
`inbound_relations_truncated_at_378`, `_789`, `_2567` and `truncated: false`. Measured cause:
`listBlocksWithKeywords`-style upstream selection takes the first 100 candidate rows, the
RFC-name filter then discards all of them, and for **8 of 10** documents measured live the
result is 0 of 100 surviving. The truncation counter and the `truncated` flag are computed
from different things, and the flag reports the one that looks better.

### 4. A row that is not a sentence is reported as a complete one

129 requirement rows in 39 documents are cut mid-sentence at a page break and reported
`parse_status: "complete"`, `confidence: 0.9`; 86 carry `flags: []`. Worst:
`req_9181039dba52a121`, RFC 8470 §6.1 — a Standards Track document from 2018 — emitting
`"…SHOULD either delay forwarding the"` with `actor: "support for a given request"`, and
its citation verifies.

Wider: **486** rows are labelled `complete` and are not complete sentences. An earlier
figure of 274 for this class is **not reproducible** under either stated definition; the
measurable figures are 129 (92 unflagged, 111 labelled complete) at a form feed, 134 (93
unflagged) at any block boundary, and 486 for the class as a whole. The 274 came from a
broader definition that was never written down and has been removed from the record.

## General mechanism found, one line to fix

`fragments[].note` promises "the first half is in an earlier block of the same section" for
**12 of 57** rows where there is no first half, and the fault is true for **all 89** false
positives at block level. Cause: `listBlocksWithKeywords` orders by `ordinal` alone
(`src/store/database.ts`), and **ordinals restart per section**, so "the previous block" is
frequently a block in a different section. Any walk over blocks that assumes `ordinal` is
monotone across a section set is wrong, and this is the one place where a single missing
`ORDER BY` produced a lie in the output.

## Also false, smaller but each one breaks a stated promise

- **`text_fidelity` says "Line counts are equal in both"** and it is false on **every
  truncated read** — RFC 793 §3.9 returns 834 against 1 941. The promise holds only for a
  read that returned in full, and the string does not say so.
- **`page_furniture_lines` names lines that were never emptied**: 905 sections across 128
  documents where `text === text_verbatim`. It reports what was _detected_, not what was
  _changed_.
- **`zero_or_few_requirements_but_N_non_strict_candidates` fires on documents with 555 and
  995 requirements.** A warning whose threshold does not include the largest documents in
  the corpus is a warning nobody can act on.
- **BCP 14 boilerplate is inside the filter the tool advertises as clean.** 110 rows across
  109 RFCs are the `"MUST" … "OPTIONAL"` paragraph that RFC 2119 itself requires in every
  RFC, and **all 110** are `shape: demand / role: modal / keyword_case: upper` — exactly the
  set the `requirements` description tells a caller to filter to for obligations. Plus 40
  copyright-boilerplate rows and RFC 2181's own definition of "Recommended".

## The measurement itself was measuring nothing

The headline result of the pass, and it invalidates the session's own numbers.

- A three-line extractor returning any sentence containing a modal word scores **strict
  118/118 and weak 129/129** against the unmodified matcher. "One row per section, no
  split" scores **260/260**. The tool scores 91.5% and 84.5%. **The floor is above the
  tool.**
- The floor is unstable: the same three lines score 100%, 13.5% or 3.1% depending only on
  the sentence splitter. Recall was measuring splitter agreement with the labeller.
- **The golden set does not reproduce.** 33 of 100 protocols differ from the published
  stratified pick; 95 of 95 snapshots drifted; **0 of 260 rules carry a snapshot id or an
  offset**; RFC 959 probes claim a section that returns 30 characters. It is a historical
  artefact, not a golden set.
- **VERIFY was a tautology** — 99.6% store against itself, with `stale`, `ambiguous` and
  `integrity_failure` never exercised once.
- **CALLS divided by probes, not rules**, and 52.9% of all calls are `verify_citation`.
- 20 of 48 hand-reviewed misses are `label_error`: 9.6% of the recall denominator was a
  known defect of the bench, counted against the tool.

Only **precision** survived, because it is the only figure built on hand labels that
independently re-judge at 24 of 25.

## Structural limits, with the reason

- **One snapshot per document, forever.** `group by rfc having count>1` returns nothing;
  `commitDocument` deletes prior snapshots. So a document cannot be diffed against its own
  successor, `modality_changed` is 0 of 500 because the match key includes a section number
  that revisions change, and **there is no erratum-to-row join at all**.
- **The mechanism for that is concrete: zero XML parses, with 43 XML assets on disk.**
  Errata arrive as XML; the XML is never read. Not an unfinished feature — an unexecuted
  step.
- **166 of 9 842 catalogue documents (1.69%).** The sampling rule skews the sample ×10.3
  toward Internet Standards and ×0.36 from Informational on the same metric. Zero documents
  above 633 KB, so large-document behaviour is untested; zero re-ingestions, so the
  snapshot-lifecycle findings are also sampling findings.
- **The strict path does not lose blocks.** 7 861 keyword-bearing blocks → 10 966
  requirements, minimum per-block yield 1.000, and zero documents with ≥20 keyword-bearing
  blocks and zero requirements. The strict pass's defect is emitting _fragments of blocks it
  covers_, not missing blocks — which changes the work from "find what is missing" to "join
  what is split".

## Two claims the auditors retracted, recorded because a retraction is a result

- "Notation is unread" is worth ~0.5% of requirements, not the order of magnitude the raw
  counts suggest: of 1 689 stranded RFC 2119 tokens in non-prose blocks, 1 159 are BCP 14
  boilerplate and ~340 are ASN.1 `OPTIONAL`. The tables-and-notation workstream drops on
  measured value.
- "Outline pollution costs 15% of yield" was an artefact of averaging ratios; ratio-of-sums
  reverses the sign. Only what both support is claimed.

Also retracted: the expectation that quality degrades with document era is **false here**.
Fragment rate is lowest in 2013+ at 0.74 per 1 000 prose blocks, and conditioned on
`stance: adopts` mean confidence is flat to three decimals across 46 years.

## One auditor's own bug, recorded for the same reason

The contract-honesty auditor's first freshness probe reported
`stale_cache_served_after_upstream_failure` on a healthy revalidation. That was the probe's
fault — it built `HttpClient` without `defaultTtlMs`. Reported as such in the report rather
than quietly corrected.

## A hazard nobody had considered

`CorpusStore`'s constructor **writes on open**. Every auditor that touched the corpus of
record had to work against frozen `cp` copies to avoid mutating it, and one auditor's
walkthrough ingested six documents as a side effect of documented read-looking calls
(`ensure_top_catalog_hits` ingests on cache miss). A store that writes when merely opened
is a hazard for every future audit and for any caller who opens a corpus to look at it.

## What a fix must not do

Every number in this file is a property of a specific corpus generation, and the corpus
moved repeatedly during the audit (159 → 166 → 182 snapshots, generation 1953 → 1981). A
fix that cites a count must cite the generation it was measured at, and the bench must
record it. Several findings were also measured against `dist/`, which is behind `src/`: the
build answers with a two-argument `classifyRequirementShape` that never looks at the clause
before the keyword, so the extractor changes made this round are not in the thing that
answers queries until it is rebuilt.
