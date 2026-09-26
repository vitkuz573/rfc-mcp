# The bench

A measurement instrument for the scenario this server exists to serve: **RFC → normative
compliance contract → code**. It answers four questions and refuses to answer them
differently for different protocols.

```
node eval/build-golden.mjs            # 100 protocols, 272 labelled rules, with offsets
node eval/build-golden.mjs --verify   # prove the artefact: byte-identical, and every rule live
node eval/run-bench.mjs --tag after-floor   # the numbers, and the floor they sit on
```

Both scripts speak MCP over stdio to `dist/index.js` (`eval/lib/mcp.mjs`) — the same
`tools.rfc.*` surface an agent uses, with the snapshot pinned. Nothing reads the database,
so a number cannot be produced by a path no caller can reach.

## The floor comes first, and it voids a number

A 3-line grep — split a section into sentences, keep the ones containing a modal token,
print them — scores **100% of strict recall and 100% of weak recall** on the golden set with
the published matcher. The real tool scores less. That is not a curiosity: it means a
recall percentage from this bench carries no information unless the floor is printed beside
it, and the only way the next reader finds out is if the instrument says so itself.

So `run-bench.mjs` computes the floor **on every run**, from the same golden set, by the
same matcher, over the same section text the probes were cut from, and prints a recall
figure at or below its own floor as **VOID** with the floor beside it. Three extractors, in
increasing triviality, all real code in `eval/lib/floor.mjs`:

| key                 | what it does                                                                                 | lines |
| ------------------- | -------------------------------------------------------------------------------------------- | ----- |
| `F1_modal_sentence` | every sentence containing a modal token, any case, split on the labeller's own boundary rule | 3     |
| `F3_modal_block`    | every block containing a modal token, unsplit — no idea where a sentence ends                | 3     |
| `F2_whole_section`  | one row per section carrying the whole section; no split, no keyword test                    | 2     |

Two more numbers come out of the same computation and both matter:

- **The splitter sensitivity.** The same three lines under four sentence-boundary rules
  score `punct` 100%, `dot` 7.4%, `punct_or_newline` 2.5%, `none` 0.8% on strict recall.
  A "better" splitter — one that also breaks at line ends, which is what you want on
  hard-wrapped RFC text — scores a fortieth of the labeller's own. Recall is therefore set
  by whether the candidate extractor's boundaries agree with `labelling.mjs`'s, not by
  whether it found the statement, and the harness prints the spread and says so on every
  run.
- **The pair.** Strict recall against negative score. `F1` buys +8.2 points of strict recall
  for −6.4 points of contamination. Neither number alone is the finding; the trade is.

## Negative probes: the number that separates an extractor from a grep

A benchmark where a grep scores 100% has no floor to measure against, and precision on the
positive set cannot supply one — the positive set asks only whether a statement was found,
and a grep finds every statement. So the bench also measures what must **not** be extracted.

Every negative probe is produced by a named, published mechanism test over text the
extractor never sees (`eval/lib/negative.mjs`). Never hand-picked: the label **is** the
mechanism, and a reader can re-derive the set from the corpus without trusting anyone. Four
classes, plus one reported-but-not-asserted because the rule is contested:

| class                | rule                                                                                                                                               | pool it must not appear in |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `meta_language`      | a keyword in quotation marks, or a sentence that opens with "the key words" / "the terms" / is "to be interpreted"                                 | both                       |
| `descriptive_modal`  | a modal in a relative clause, a possibility, a courtesy, or a finite clause reporting a property — never a sentence carrying an upper-case keyword | both                       |
| `nonprose_block`     | an upper-case keyword inside a `table`, `figure` or `reference_entry` block                                                                        | both                       |
| `no_modal`           | no modal token at all, in a prose block                                                                                                            | `requirements[]` only      |
| `preformatted_block` | the same, inside a `preformatted` block                                                                                                            | **reported, not asserted** |

`no_modal` is forbidden from the strict list only, because a modal-free bound is a real
obligation — that is what the golden set's own `keyword-free-spec` class is. `preformatted`
is separate because the rule is genuinely contested: the next-wave design counts 292
preformatted blocks carrying a keyword as an acknowledged loss, and RFC 1122 indents its
body text at column 12, so the tool emitting RFC 1122's obligations is right and a
"never scan a non-prose block" rule would call it a false positive. Both readings are
defensible, so the number is reported and neither is asserted.

**Not measured, and it is the most valuable population:** an _upper-case_ descriptive modal
("The length MAY be zero"). Telling a deontic modal from a descriptive one is a grammatical
judgement, and the only mechanism available for it is the extractor's own `shape: demand` —
which is the claim under test. Labelling with it would make the check circular.

## Matching: two matchers, both reported

The bench used to ask one question — is the probe a substring of the row? That measures
containment, and containment is not extraction: a row carrying a whole section contains
every probe cut from that section, so a whole-section emitter scored 100% on every tier
under it.

The reported matcher asks whether the row is a **statement containing the probe**: the
probe must be a normalised substring of the row (unchanged) _and_ the row may not exceed the
probe by more than a stated **margin of 1.5×** (`eval/lib/match.mjs`). Both matchers run on
every rule on every run and both are printed, so a change in the numbers is attributable to
the matcher and not to the tool. The margin is a judgement, so the sweep (1.0, 1.25, 1.5, 2,
unbounded) is published too, along with the number of matches the bound excluded and the
distribution of the row/probe length ratio of the hits that survived.

Conservation asks the opposite question — is a sentence accounted for _anywhere_ in the two
lists — and uses plain containment there. Two questions, two matchers, and the reason is
written down so nobody "unifies" them later.

## Why the golden set is generated, not typed

A hand-written list of quotes is selected by the person who also reads the tool's output,
and every such list drifts toward the sentences the tool already finds. So the labels are a
published function of the document text (`eval/lib/labelling.mjs`):

- **Which 100 protocols.** The corpus sorted by RFC number, cut into 10 equal strata, 10
  evenly spaced from each. No document is added, dropped or reordered by hand. It spans
  1973–2024 across every layer: transport, routing, security, mail, web, directory, naming,
  time.
- **Which section.** Numbered sections sampled outward from the middle of the document
  (½, ¼, ¾, ⅛, ⅞, ⅜, ⅝) until the protocol has three rules. `references` and `authors` are
  skipped: eight bibliography entries and two author addresses were being admitted as
  probes, and the project's own miss review had already called all eight of the
  bibliography ones labelling errors.
- **Which sentence.** Any sentence carrying a modal token matched **case-insensitively**
  (`must|shall|should|may|required|recommended|optional`), length 45–260, rejecting captions,
  bullets, code, cross-references, printing artefacts, examples and table rows. Case is _not_
  part of selection.
- **Which tier.** Derived from case alone: an upper-case RFC 2119/8174 keyword makes the
  rule `strict`, anything else `weak`.

The consequence that matters: selection cannot prefer a tier, and it never consults
`requirements`. `build-golden.mjs` does not call that tool at all, so a recall number cannot
be circular.

## Reproducibility, and what is no longer comparable

`eval/golden.json` is now a pure function of three inputs — the bytes of `eval/corpus.json`,
the snapshots those documents resolve to, and `eval/lib/labelling.mjs` — and carries no
wall-clock field, because a field that changes every day makes a byte comparison impossible
and an impossible comparison is a check nobody runs.

```
node eval/build-golden.mjs --verify
# {"identical": true, "reverified": 272, "stale": 0, "verdict": "reproducible"}
```

Two questions, asked separately, because a file can be reproducible in one sense and not
the other. `identical` asks whether re-running the published rule over the same store
produces the same bytes. `reverified` asks whether every rule still names the bytes it was
cut from: each rule carries `snapshot_id`, `char_start`/`char_end` in the raw section text,
the same span in the normalised view, the number of times the sentence occurs in that
section, and a hash of the probe. A file that passes the first and fails the second is a
selection that reproduces and content that has rotted, which is a different defect with a
different fix.

**`eval/golden-baseline-2026-09-26.json` is a historical baseline, not a golden set**, and
its `$meta` says why: 33 of its 100 protocols are not what the published rule produces from
the committed 159-document corpus, 95 of 95 protocols had drifted, 0 of 260 rules carried a
snapshot id or an offset, and ten probes were unreachable in the section they named — RFC 959
`G0004` claims a 154-character sentence in section "5", which now returns 30 characters.
`build-golden.mjs` did not reproduce it and could not.

Every results file measured against that baseline carries a `$comparability` block saying it
is **not** comparable to a run made against `eval/golden.json`: `before.json`, `after.json`,
`after2.json`, `after3.json`, `redteam.json` and `before-miss-review.json`. A number that
silently becomes incomparable is a trap for the next reader. Nothing in those files is wrong
about the build they measured; they are simply measured against a set that cannot be
rebuilt.

## The two tiers never mix

A `strict` probe is matched **only** against `requirements[].exact_text`. A `weak` probe
**only** against `non_strict_candidates.candidates[].exact_text`. A provisional hit never
counts as a normative one — that would inflate recall by construction, because the
provisional list is three times the size of the requirement list on a pre-2119 document.

`keyword-free-spec` rules — a bound with no modal anywhere in the sentence — are reported as
their own class, and are VOID: the best trivial extractor also scores 0% on them, so the
class does not discriminate between anything.

## The numbers, and what each one is not

| number    | what it is                                                                                                   | what it is not                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| RECALL    | golden rules found, per tier, under the bounded matcher, beside the containment control and beside the floor | not a percentage until the floor is beside it; not comparable to `eval/results/before.json` and later            |
| PRECISION | emitted items a human agrees are normative                                                                   | **not computed by the harness.** It draws a deduped sample; `PRECISION-RUBRIC.md` says how a person labels it    |
| CALLS     | `tools.rfc.*` calls over three divisors, with the distribution and both worst documents                      | not "per 40 rules" as if 40 rules were a protocol: a measured document is worth 2.83 probes and 167 emitted rows |
| VERIFY    | one number per verdict condition                                                                             | not a pooled percentage of the store against itself                                                              |

**CALLS, three divisors.** The published figure divided by probes. All three are printed
because the reader has to know which one they are quoting before they quote it: per 40
**golden rules** (the published, meaningless one), per 40 **reported requirements** (what a
caller is actually buying), and per 40 **emitted rows**. The distribution is printed because
sparse documents and dense documents are expensive for opposite reasons — a 1-rule document
pays for a resolve and an unscoped requirements before a single rule is read, and a
555-requirement document is read in three pages because the schema caps a page at 200 rows.

**What is not in CALLS, and why.** `verify_citation` is the harness auditing its own output
and is counted separately (`audit_calls`); it was 52.9% of the old headline and a caller
building a compliance list never calls it. The section reads behind the label-free
invariants are made outside the counting wrapper and reported as `instrument_reads`: a guard
that can move the number it guards is part of the instrument rather than a check on it. The
corpus invariants cost 3–4 calls per document over all 159 documents and are excluded for
the same reason, with the exclusion stated in the output (`invariants.in_CALLS: false`).

**VERIFY, five conditions.** A single pooled number is what hid the finding, so each
condition is reported on its own (`eval/lib/verify-scenarios.mjs`):

| scenario              | contract                                 | what it is                                                                                                                                     |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `S1_same_derivation`  | `verified`                               | **the control, and the only tautology**: a citation read off a row of this derivation, verified against the snapshot this derivation came from |
| `S2_other_derivation` | `stale` or `not_found`, never `verified` | the same id against a different document's store                                                                                               |
| `S3_duplicate_quote`  | `ambiguous`, with every span named       | a sentence that occurs twice; the id names a sentence, not a place                                                                             |
| `S4_corrupted_id`     | `not_found`                              | one hex character changed                                                                                                                      |
| `S5_drifted_pin`      | `not_found`                              | a pin from before a re-sync: the store has moved on and the id the caller holds names nothing                                                  |

A scenario that cannot be constructed is reported as `unreachable` with `conform_pct: null`
— deliberately not 100, because "untested" and "passing" are different answers and only one
of them is being claimed.

## The exclusions are a number

`run-bench.mjs` used to drop every protocol whose golden rule list was empty. The filter was
on the **labeller's** output, not the tool's, so the documents the tool cannot reach were
the documents excluded from the measurement — including the only two in the corpus where the
tool returns nothing at all. A filter is allowed to exclude; it is not allowed to exclude
quietly. The excluded protocols are now named, and `EXCLUSIONS.replay` reports what the
same published labelling rule finds in them on the current outline, **in rules**, so the size
of the hole is a number rather than an argument.

## The second and third instruments

A labelled golden set of 100 protocols cannot see a defect that removes sections from an
outline, because the set samples sections _from_ the outline. So `run-bench.mjs` also
computes, on every run, over every ingested document:

- **label-free corpus invariants** — documents with zero strict requirements, zero
  candidates, both zero, sentence-fragment counts, unreadable blocks, duplicate `exact_text`
  rows, median and mean requirement length, keyword-bearing blocks skipped, the share of
  candidates classified `demand`, and the keyword stance;
- **`dangling_headings`** — subsection headings the sampled text shows and the outline omits.
  A guard is only a guard if someone looks at it, so non-zero is printed loudly;
- **conservation** — for every sampled section, every keyword-bearing sentence in
  `read(section).text` must appear in `requirements[]` or `non_strict_candidates[]`
  (`eval/lib/conservation.mjs`, the acceptance test stated in `eval/results/pending-fixes.md`
  Y5). Reported as a coverage rate split three ways: lost in a block the tool declares it
  does not scan, lost in `read(text)` and in no block at all, and **lost in a prose block
  with no stated reason** — the last is the part that means something is wrong rather than
  something was decided, and it is counted by none of the tool's own counters.

`eval/golden-ext.json` samples the documents outside the main set. It reports recall and
nothing else, and `comparable_with_main_bench` is `false` in both files. There is no
"before" there: a document with no addressable structure cannot be sampled, so no probe
could be cut from it and no rule could be missed.

**It is also now out of step with `golden.json`, deliberately.** `build-golden-ext.mjs` uses
the same `SKIP_KINDS_FOR_PROBE`, so adding `references` and `authors` changes which sections
it samples too. Rebuilding it is a separate piece of work and it is not done here: a stale
ext set is a published number with a known referent, and a silently-changed one is not. Its
numbers stay comparable with each other and not with anything measured since.

## What a miss is not

A miss is a defect only if the sentence binds an implementer. `eval/results/<tag>.json`
lists every miss and every match the matcher bound removed; the report classifies each one,
and a miss on a sentence that turned out to be descriptive is recorded as a label that was
too generous rather than as a tool defect. The reverse is also stated wherever it applies:
if recall rises and the negative score falls, that is overfitting and the report says so
with both numbers.

## Files

- `corpus.json` — inventory of the 159 ingested documents (which exist, not what they say)
- `golden.json` — 100 protocols, 272 rules, each naming its snapshot, section and offsets;
  `$meta.build_fingerprint` covers the corpus bytes, the labelling source and the resolved
  snapshots
- `golden-baseline-2026-09-26.json` — the previous artefact, marked
  `status: historical_baseline`
- `lib/mcp.mjs` — minimal stdio MCP client
- `lib/labelling.mjs` — the selection and tier rules, the `danglingHeadings` invariant, and
  `locate()`, the offset map that makes a stale rule detectable
- `lib/floor.mjs` — the floor extractors and the splitter sensitivity
- `lib/match.mjs` — the bounded statement matcher, the containment control, the margin sweep
- `lib/negative.mjs` — the negative-probe mechanisms
- `lib/conservation.mjs` — the conservation invariant
- `lib/verify-scenarios.mjs` — the five VERIFY conditions
- `build-golden.mjs` — writes `golden.json`; `--verify` proves it
- `run-bench.mjs` — writes `results/<tag>.json` and the precision sample
- `precision-sample.mjs` — draws a sample from one list without recomputing the numbers
- `apply-labels.mjs` — carries hand labels forward; the carry key is `(rfc, kind, text)` and
  contradictions between label files are reported, not overwritten
- `PRECISION-RUBRIC.md` — how a human labels an emitted item

## Tests

```
node --test eval/lib/labelling.test.mjs eval/lib/instruments.test.mjs
```

`instruments.test.mjs` tests the things that decide what the numbers _mean_: that the floor
extractors emit what they claim, that the bound is what separates a statement from a section
dump, that each negative generator fires on a sentence it must catch and not on one it must
not, that conservation's three buckets stay distinct, and that `locate()` round-trips
between the raw and the normalised view.
