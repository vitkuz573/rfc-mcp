# Red-team audit of the bench

Adversarial audit. `src/` was read but not modified. The only files written are this one
and `eval/audit/bench-red-team-probes.json` (machine-readable evidence for every number
below). One harness run was made, with the sanctioned tag: `node eval/run-bench.mjs --tag
redteam` → `eval/results/redteam.json`, `eval/results/redteam-precision-sample.json`.

**My run reproduces the project's numbers exactly**, so nothing below is a disagreement
about what the harness currently prints:

```
RECALL strict            108/118 = 91.5%   (byte-exact 5.1%)
RECALL weak/lower        109/129 = 84.5%   (byte-exact 1.6%)
RECALL weak/keyword-free   0/13  =  0%
VERIFY                   234/235 = 99.6%   {verified:234, not_found:1}
CALLS                    444 / 6.5 units of 40 rules = 68.31 per 40
```

---

## 0. THE FLOOR — a 3-line grep beats the tool on both headline recall numbers

**This is the headline. Read it before anything else.**

I wrote the deliberately bad extractor the brief asked for and scored it on the committed
golden set with `run-bench.mjs`'s own `findIn()`, unchanged:

> for every section of every sampled document, split the text on `/(?<=[.!?])\s+/` and emit
> **every sentence containing any modal word**, case-insensitively. No block
> classification, no prose/table/preformatted judgement, no action-verb test, no
> RFC 2119 case test, no ranking, no shape, no role. It cannot tell a strict row from a
> provisional one, so it offers every row to both pools.

| extractor                                     | rows emitted | strict             | weak/lower         | weak/keyword-free | overall              |
| --------------------------------------------- | ------------ | ------------------ | ------------------ | ----------------- | -------------------- |
| **BAD: modal-sentence grep**                  | 13,258       | **118/118 = 100%** | **129/129 = 100%** | 0/13 = 0%         | 247/260 = 95.0%      |
| **BAD: no split at all, one row per section** | 5,390        | **118/118 = 100%** | **129/129 = 100%** | **13/13 = 100%**  | **260/260 = 100.0%** |
| real tool (`eval/results/redteam.json`)       | 15,938       | 108/118 = 91.5%    | 109/129 = 84.5%    | 0/13 = 0%         | 217/260 = 83.5%      |

**The floor for strict RECALL is 100%. The tool scores 91.5%.**
**The floor for weak/lower-case RECALL is 100%. The tool scores 84.5%.**

The real tool's entire measured recall advantage — the 91.5% and the 84.5% — sits
_below_ what you get from grepping for `must|shall|should|may` and printing the sentence.
The only class where the tool beats the grep is `keyword-free-spec`, and there the tool
scores **0%** against the grep's 0%: on that class the two are tied at the floor and the
class is worth nothing as evidence of extraction quality.

The degenerate variant is worse for the bench. Emitting **one row per section carrying the
whole section text** — no sentence splitting at all — scores **260/260 = 100% on every
class including the keyword-free one**. `findIn()` is
`norm(row.exact_text).includes(norm(probe))`, so a row that contains the whole document
contains every probe cut from that document. There is no length cap, no per-row bound and
no penalty in the matcher. The bench would report 100% recall in all three tiers and
0/13 in none, for an extractor that does no extraction.

### 1a. The floor is also unstable, which is worse than a high floor

Same three lines, same regex, same document text, same matcher. Only the sentence-boundary
rule changes:

| splitter in the bad extractor                                | strict | weak/lower | overall |
| ------------------------------------------------------------ | ------ | ---------- | ------- |
| `/(?<=[.!?])\s+/` (the splitter `labelling.mjs` itself uses) | 100%   | 100%       | 95.0%   |
| `/\.\s+/`                                                    | 8.5%   | 19.4%      | 13.5%   |
| `/(?<=[.!?])\s+                                              | \n+/`  | 5.1%       | 1.6%    | 3.1% |

A "better" splitter — one that also breaks at line ends, which is what you want on
hard-wrapped RFC text — scores **3.1%** overall. The recall number is dominated by whether
the candidate extractor's sentence boundaries agree with the labeller's, not by whether it
found the statement. The published defence in `labelling.mjs` is that the selection is
"a published function of the document text only … returns the same sentences on every
machine". True — and that is exactly the problem: `rulesFromSection()` and the trivial
extractor are then the _same function_. A probe and its own floor-case extractor agree
byte-for-byte by construction, because the probe was defined as "whatever this one regex
finds first".

### 1b. Precision floor

Not computable from the bench, because the bench does not compute precision and no
precision number is reported anywhere in `eval/results/redteam.json`
(`PRECISION.status = "awaiting manual labels"`). The closest existing measurements are the
hand-labelled ones for the two output shapes a no-classification extractor produces:

| list                                       | what it is                                                                                           | precision          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `before-precision-labels-candidates.json`  | `kind: non_strict_candidate` — the provisional list, i.e. modal sentences with no RFC 2119 case test | **36.8%** (70/190) |
| `after-precision-labels-candidates.json`   | the same list after the round                                                                        | **29.2%** (54/185) |
| `before-precision-labels.json`             | `kind: requirement`                                                                                  | 79.5% (159/200)    |
| `after2-precision-labels-requirement.json` | the same after the round                                                                             | 94.3% (217/230)    |

A no-classification extractor emits the provisional population into the requirements pool.
The measured precision of that population is **29–37%**, and it is what the project
itself has measured. The PRECISION number the project reports today is `null`.

---

## 2. Is selection biased toward what the tool already finds?

**The stated premise is wrong, and the truth is worse.** `build-golden.mjs` never calls
`requirements` — I read the file; it calls only `resolve` and `read`. It does **not** skip
zero-rule protocols: it records them with `rules: 0` (lines 178–192). The exclusion lives
in `run-bench.mjs:97`:

```js
const protocols = [...byProtocol.values()].filter((p) => p.rules.length > 0);
```

That is a condition on the **labeller's** output, not the tool's. Same effect, and it is
the worst possible direction: the five documents dropped are the ones the tool cannot reach.

### 2a. The five dropped protocols, replayed on the current outline

| rfc  | golden says | replayed now                                | rules available now | would contribute |
| ---- | ----------- | ------------------------------------------- | ------------------- | ---------------- |
| 768  | 0 rules     | 0 sections yield rules                      | 0                   | 0                |
| 792  | 0 rules     | 0 sections yield rules                      | 0                   | 0                |
| 2052 | 0 rules     | Abstract                                    | 3                   | **3**            |
| 8448 | 0 rules     | Status of This Memo, Copyright Notice, 10.2 | 3                   | **3**            |
| 9650 | 0 rules     | Status of This Memo, Copyright Notice       | 2                   | **2**            |

**8448 and 9650 are the only two documents in the 159-document corpus where the tool
returns nothing at all** — zero strict requirements _and_ zero candidates
(`redteam.json → invariants.zero_strict_and_zero_candidates`). Eight golden rules the tool
would score 0 on are excluded from every denominator, by a filter, silently. `run-bench.mjs`
prints `95 protocols` and never says five are missing or why.

`eval/README.md:117` defends this: _"a document with no addressable structure cannot be
sampled, so no probe could be cut from it and no rule could be missed."_ Both halves are
falsified. 8448 and 9650 now have addressable structure, and `rulesFromSection()` run on
their sections yields 3 and 2 rules. The probes can be cut and the rules can be missed.

Separately: **64 of the 159 ingested documents are never sampled at all**, and 17 of those
64 are documents the tool returns zero strict requirements for.

### 2b. `read.text` versus blocks — and it disfavours the tool

Probes are cut from `read(section).text`. The tool's rows come from `blocks`. I fetched
`include:["text","source_map"]` for all 215 sampled sections (1,684 blocks) and located
every probe in both views:

|                                     | count                             |
| ----------------------------------- | --------------------------------- |
| probes                              | 260                               |
| present in the section's `.text`    | 250                               |
| present in **some block's** `.text` | 233                               |
| **in `.text` but in no block**      | **27 (10.4% of the denominator)** |

At least **10.4% of the recall denominator is text no block-classifying extractor can
reach at any quality**, because the block it lives in is typed `table`, `preformatted`,
`list_item` or is absent. This is the same mechanism the project's own miss review names
twice ("The block was classified preformatted because RFC 1122 indents its body text at
column 12"; "A real MUST NOT inside a block that also holds a numbered encoding table, so
the block is not prose"). The bias is real, systematic, and **against** the tool — which
means the reported recall is not flattered by it, but the denominator is padded by 10% with
probes that measure the parser, not the extractor.

### 2c. The golden set does not reproduce

`golden.json.$meta.protocol_selection` claims: _"10 equal strata of the corpus by RFC
number, 10 evenly spaced from each. No document is added, dropped or reordered by hand."_

Re-running `pickProtocols()` over the committed `eval/corpus.json` (159 documents):

|                                                             |        |
| ----------------------------------------------------------- | ------ |
| picked from the current corpus                              | 100    |
| picked but **absent from `golden.json`**                    | **33** |
| **in `golden.json` but not picked** from the current corpus | **33** |

`corpus.json` grew from 151 to 159 documents since HEAD (added: 3597, 8490, 8903, 8949,
9197, 9463, 9499, 9606). `eval/README.md:133` still says "inventory of the 151 ingested
documents". A third of the golden set is not what the published selection rule produces.

### 2d. The probes are not traceable to bytes, and 10 of them are unreachable

|                                                                |             |
| -------------------------------------------------------------- | ----------- |
| protocols with snapshot drift on the live run                  | **95 / 95** |
| golden **rules** carrying a `snapshot_id`                      | **0 / 260** |
| golden rules carrying a byte/char offset                       | 0 / 260     |
| probes absent from the current `read` of the section they name | **10**      |

`build-golden.mjs`'s header says _"A golden set that does not name the bytes it was cut
from cannot be re-verified after a re-sync."_ The pin exists at protocol level only; the
260 things that are actually scored carry nothing. Drift is printed and changes no number.

Worked example, and it is not a rounding issue. RFC 959, golden probes `G0004` (154 chars)
and `G0005` (121 chars) are recorded with `section: "5"`. On the current build:

```
read(section:"5")   -> text length 30, 0 blocks, content "5.  DECLARATIVE SPECIFICATIONS"
read(section:"5.1") -> text length 786, 6 blocks   (G0004's text is here)
read(section:"5.2") -> text length 3909, 10 blocks (G0005's text is here)
```

`build-golden.mjs` cuts probes from `read(...).text`. A 30-character text cannot yield a
154-character probe. **`node eval/build-golden.mjs` does not reproduce `eval/golden.json`.**
The same applies to `G0006`, `G0010`–`G0015` (RFC 1122 section "4" → 22 chars; RFC 1123
section "5" → 38 chars) and `G0035`.

### 2e. `references` and `authors` are not in `SKIP_KINDS`

Sections sampled by kind: `body` 204, **`references` 8**, **`authors` 2**, `appendix` 1.
`labelling.mjs`'s `SKIP_KINDS` omits both. Eight bibliography entries became golden
probes, and the project's own miss review classes every one of them `label_error`:
`G0123 G0153 G0156 G0168 G0194 G0204 G0210 G0249`.

---

## 3. Is matching too generous?

**Against the current implementation: no. Against the instrument: completely.**

`findIn()` is `norm(row.exact_text).includes(norm(probe))` — probe inside row, no bound on
the row. Measuring every one of the 217 hits:

|                                                                          |                           |
| ------------------------------------------------------------------------ | ------------------------- |
| row-to-probe normalised length ratio, min / q25 / median / q75 / **max** | 1 / 1 / 1 / 1 / **3.146** |
| hits with a row longer than the probe                                    | **1 / 217 (0.5%)**        |
| hits with a row >1.5× the probe                                          | 1 / 217                   |
| hits with a row >2× the probe                                            | 1 / 217                   |
| hits with a row >2 lines longer                                          | 45 / 217                  |
| hits where the row is not the probe verbatim                             | **1 / 217**               |

216 of 217 hits are exact-length. The real tool emits sentence-level rows and does not
exploit the loose matcher. The one real case is a defective probe the matcher **rewarded**:

> `G0158`, rfc 7680, ratio 3.146. Row: _"As noted by Mahdavi and Paxson [RFC2678], simple
> upper bounds … will be needed in practice. `{Comment: Note that, for many applic`"_
> Probe: _"{Comment: Note that, for many applications of these metrics, there may be no
> harm in treating a large delay as…"_

The probe is a mid-row `{Comment: …}` fragment of an Internet-Draft, cut because the
labeller's sentence splitter cannot break inside it, and the bench scored it a **hit**.

So the leniency is real but currently unused — and it is one edit away from being used. My
whole-section emitter takes 260/260 on the same harness, including 13/13 on the class the
real tool cannot reach at all. Nothing in `run-bench.mjs` would notice.

### 3a. `exact_pct` is a line-length measurement wearing a recall label

`run-bench.mjs:36-38` promises `exact_pct` shows "how much of recall depends on that
normalisation rather than on the extractor finding the statement."

|                                                      |                                            |
| ---------------------------------------------------- | ------------------------------------------ |
| byte-exact hits                                      | 8                                          |
| their normalised probe lengths                       | 48, 49, 52, 58, 59, 61, 63, **65**         |
| normalised-only hits                                 | 209, minimum probe length 54, **all > 65** |
| every found rule with probe length > 65 is non-exact | **true**                                   |

A probe longer than ~65 characters cannot fit on a typeset line, so byte-exact containment
is _arithmetically_ impossible. `exact_pct` = 5.1% / 1.6% measures sentence length. The
control works — and the answer it gives is that **96.3% of the recall signal (209/217)
rests on whitespace normalisation alone.** It is not a second opinion on the extractor.

---

## 4. Are the tiers actually separated?

**Enforced, and it is doing real work. The pools are not disjoint in content.**

Code, `run-bench.mjs:168`:

```js
const pool = rule.tier === "strict" ? f.strict : f.candidates;
const where = rule.tier === "strict" ? "requirements" : "non_strict_candidates";
```

`labelTier()` is `upperKeyword(sentence) ? "strict" : "weak"` — a pure function of the
probe text. A single probe cannot be both tiers, so no probe _content_ can drive the
ternary into the wrong pool. I could not construct a probe that matches in the wrong pool
and would be scored a hit by a tier-selection bug, because tier selection is not a
search — it is a lookup on a value the probe itself determines.

**But the two pools are not disjoint**, which is the precondition for such a bug mattering:

|                                                                    |                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| golden probes whose text is _also_ in the forbidden pool           | **2 / 260** — `G0028` (rfc 2119, strict), `G0244` (rfc 9422, strict) |
| documents where the same normalised text appears in **both** pools | **46 / 100**                                                         |
| rows involved in that overlap                                      | **640**                                                              |
| of those, currently scored as FOUND                                | 1                                                                    |

`G0028` is a miss today _precisely because_ the candidate-pool occurrence is refused. Merge
the two pools — a plausible "simplification" — and 2 rules flip to hits, plus any
upper-case statement the tool chose to demote. And the tool emits **640 rows that are
simultaneously in `requirements` and `non_strict_candidates`**: the provisional channel is
contaminated with RFC 2119 statements, which dilutes every precision number computed on
the candidate list.

I could not violate the separation with a probe. That part of the design is sound.

---

## 5. Are the hand labels trustworthy?

Two label populations exist and they are not equally good.

### 5a. The carry mechanism: `(rfc, norm(text))`, `kind` not in the key

`apply-labels.mjs:79` carries by `` `${item.rfc}|${norm(item.text)}` `` and `prior.set`
**overwrites**, so the last `--from` file listed wins. `kind` is not part of the key, and
the two pools have different verdicts under the rubric's own two-headed standard.

Across the four hand-label files (523 labelled rows, 499 distinct keys, 24 keys with more
than one row, 48 rows involved):

> **One key already carries both verdicts.**
> `7872 | "Code Components extracted from this document must include Simplified BSD License text as d…"`
> — **TRUE** at `before-precision-labels.json` `P156` (`kind: requirement`)
> — **FALSE / `boilerplate`** at `before-precision-labels-candidates.json` `before-CAND156` (`kind: non_strict_candidate`)

The project has already produced two different verdicts for one carry key, and the script
cannot see it. The other 23 duplicate keys agree, which is expected: identical text must
get an identical verdict under a rubric that judges the text, not the metadata.

### 5b. Non-unique `(rfc, text)` in the corpus

|                                                            |                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| rows the tool emits over the 100 documents                 | 16,025                                                                       |
| documents containing a duplicate `(rfc, norm(exact_text))` | **61 / 100**                                                                 |
| duplicate rows                                             | **3,624 (22.6%)**                                                            |
| worst multiplicity in one document                         | **12** (rfc 4271)                                                            |
| worst documents                                            | 3261:1480 (×10), 4120:331 (×6), 5280:313 (×6), 1122:292 (×4), 4271:246 (×12) |

So the carry key is _massively_ non-unique. Under the rubric's own logic that is harmless —
the same sentence deserves the same label — but it has two consequences the bench does not
account for:

1. `run-bench.mjs`'s precision sampler (lines 248–289) **dedupes nothing**. The 285-row
   sample contains 284 distinct `(rfc, text)` keys but only **233 distinct sentences**.
   The effective _n_ is 82% of nominal, and one sentence can be sampled 12 times.
2. `before-precision-labels-candidates.json` sampled "with a stride through each
   protocol's ranked candidate list" — a stride through a list that is 22.6% duplicates
   walks over the same sentences repeatedly. The label file admits "Duplicate rows in this
   sample: 4, against 7 in the BEFORE sample of 200."

### 5c. Independent re-judgement of 25 existing labels

Method: every 20th labelled row of the 523, offset 7 — R1…R25, deterministic, spanning all
four label files — re-judged by me against `eval/PRECISION-RUBRIC.md` on the text alone,
without the tool's metadata. Full rows in the probes file under
`A5_label_carrying.independent_re_judgement.rows`.

**Agreement: 24/25 = 96%.**

The single disagreement:

|                                    |                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R1` rfc 2045, `kind: requirement` | existing: **false / `list_introducer`**                                                                                                                                                      |
| text                               | _"Messages composed in accordance with this document MUST include such a header field, with the following verbatim text:"_                                                                   |
| mine                               | **true** — it states an obligation on the sender. The rubric's `list_introducer` is for a sentence that _only_ introduces a list ("the fields are as follows"). This one carries the `MUST`. |

One low-confidence agreement I am flagging rather than claiming: `R6` (rfc 2606,
_"\".example\" is recommended for use in documentation or as examples"_) is genuinely
50/50 between `true` and `not_an_obligation` — a special-use registry reservation is
arguably policy rather than an implementation duty. The rubric counts permissions, so I
recorded `true`.

One rubric violation found: **`boilerplate` is used as a reason** in
`before-precision-labels-candidates.json` (46 uses) and `after-precision-labels-candidates.json`
(11 uses). `PRECISION-RUBRIC.md` enumerates exactly seven reasons and says "Record exactly
one"; `boilerplate` is not among them. `R8`'s existing reason (`not_an_obligation`) and
several others do come from the rubric list, so this is inconsistency, not a missing
category.

**Verdict on the precision labels: they hold up.** 96% on a stratified independent
re-judgement, and the disagreements are on the rubric's genuinely ambiguous boundary.

### 5d. The golden labels are a different, much worse population

The 25 rows above came from the _precision_ files. The _golden_ probes come from
`labelling.mjs rulesFromSection()` — a different code path — and the project has already
published their failure count in `eval/results/before-miss-review.json`:

| verdict             | count                                 |
| ------------------- | ------------------------------------- |
| misses reviewed     | 48                                    |
| **`label_error`**   | **20 (41.7% of the misses reviewed)** |
| `unreachable_class` | 12                                    |
| `probe_artifact`    | 5                                     |
| `tool_defect`       | 8                                     |
| `resolved`          | 3                                     |

Over the whole golden set, **20 `label_error` + 5 `probe_artifact` = 25/260 = 9.6% of the
recall denominator is a defect the project has already admitted to in writing.** Eight of
the `label_error`s are bibliography entries (§2e). Twelve are `keyword-free-spec`, the
class the bench itself declares unreachable. The `corrected_recall` block in the same file
publishes hand-adjusted figures — strict "108/116 = 93.1%", weak "109/112 = 97.3%" — which
are not reproducible by any code in `eval/`.

PRECISION is only as good as the hand labels: they are good (96%). **RECALL's denominator
is the hand labels' worse sibling, and its defect rate is known, published, and 9.6%.**

---

## 6. Is VERIFY measuring anything?

**It tests the tool's self-consistency with its own store, not the tool's correctness.**

`run-bench.mjs` phase 3: for every rule counted **found**, take `citation_ids.slice(0, 2)`,
call the tool's `verify_citation`, and set `verified = (verdict === "verified")`.

What the tool actually does (`src/service/rfcService.ts:2240` `verifyCitation`): look the
`citation_id` up **in the store**, fetch the block **the stored record points at**, and
test `raw.slice(block.byte_start, block.byte_end).includes(match.exact_text)`. Integrity
checks (`sha256(raw)` vs `snapshot.raw_sha256`) run first. So it answers: _does the quote
the tool stored still occur in the block the tool stored?_

It cannot detect a wrong section, a wrong sentence boundary, a wrong classification, a
wrong tier, or a row that is not a requirement at all — the quote and the block come from
the same record, so they agree by construction.

### Worked counter-case: the verifier is wrong, the bench passes

`G0189`, rfc 8447, strict. Golden probe cut from **section 12**:
_"IESG Approval is REQUIRED for a Y->N transition."_
The tool's rows carrying that text are in **sections 7, 8, 9 and 14**. `slice(0, 2)` takes
sections 7 and 8. Live:

```
row.section=7  cit_87e8f5beb9e510dac7018303 -> verdict="verified" status="ok"
                locator=["7","TLS ExtensionType Values"]
row.section=8  cit_c90c13ba08fdf112a316ff80 -> verdict="verified" status="ok"
                locator=["8","TLS Cipher Suites Registry"]
```

VERIFY records **234/235 = 99.6%** for a hit that was matched by a row in a completely
different section than the probe names, and the citation the verifier blessed points at
section 7. `G0040` (probe 5.22, only match in 5.11), `G0107` (4.1.2.6 → 4.2.1.6), `G0140`
(6.4.3 → 6.4.7) and `G0259` (4.2 → 4.1) are the same shape. Eight further mismatches
(`G0005 G0006 G0010 G0011 G0013 G0014 G0035 G0088`) are benign parent/child cases where
the builder read a coarse outline entry and the tool attributes the row to the leaf.

### Three structural weaknesses

1. **Conditioned on the number under test.** Only _found_ rules are verified. The 43 misses
   contribute 0 checks. VERIFY is a rate over a subpopulation selected by recall.
2. **Truncated to two.** 238 citation ids hang off the 217 found rules; 235 were checked.
   2 rules have more than two matching ids and the remainder are dropped without comment.
3. **Untested against its own failure modes.** `by_verdict` is `{verified: 234, not_found: 1}`.
   `stale`, `ambiguous` and `integrity_failure` — the three verdicts that would indicate a
   real derivation problem — are **never observed**. The bench's 99.6% is untested against
   the conditions it exists to catch. The tool's own description of `scit_` ids says a
   stable id against another snapshot answers `stale`, not `verified`; 95/95 snapshots
   have drifted, so the `stale` path is exactly the one now in play and is not exercised.

---

## 7. Is CALLS measuring what it claims?

**No. The divisor is a count of golden probes, not a count of rules, and the headline is
58× the honest figure.**

`run-bench.mjs:233`: `const units = golden.rules.length / RULES_PER_UNIT` = 260/40 = 6.5.
`CALLS.note` asserts _"The per-40 divisor is the unit of work in the scenario: forty rules
is one protocol's worth of contract."_

| over the same 95 measured documents           |            |
| --------------------------------------------- | ---------- |
| golden probes (the divisor)                   | 260        |
| rules the tool reports (`total_requirements`) | **7,551**  |
| rows the tool emits                           | **15,938** |
| golden probes per protocol                    | 2.74       |
| emitted rows per protocol                     | **167.8**  |

| normalisation                          | calls per 40 |
| -------------------------------------- | ------------ |
| per 40 **reported requirements**       | **2.35**     |
| per 40 **emitted rows**                | **1.11**     |
| per 40 **golden probes** (as reported) | **68.31**    |

Forty rules is not one protocol's worth of contract here; a protocol is 168 rows. The
headline is 29× the requirement-normalised figure and 58× the row-normalised one.

**More than half of CALLS is the harness auditing itself:** `verify_citation` is 235 of 444
calls = **52.9%**. A caller who wants the compliance list pays 1 `resolve` plus 1–13
`requirements` pages per document and never calls `verify_citation` at all. The number
measures a measurement habit, not a cost of use.

### Per-protocol distribution (not the mean)

| golden rules | protocols | mean calls/protocol | mean emitted rows/protocol | pages observed |
| ------------ | --------- | ------------------- | -------------------------- | -------------- |
| 1            | 6         | **4.17**            | 115                        | 1,1,1,1,1,3    |
| 2            | 13        | 4.62                | 35                         | all 1          |
| 3            | 76        | 5.16                | 195                        | 1…13           |

**Yes, sparse documents cost disproportionately.** 4.17 calls per golden rule for a
1-rule protocol against 1.72 for a 3-rule protocol — a **2.4× penalty**. The fixed cost
(1 `resolve` + 1 unscoped `requirements`) is amortised over 2.74 probes on average and
over 1.0 on the sparse tail. And the sparse group is the one emitting 115 rows on 4.17
calls, so the cheapest-looking protocols in the distribution are not the cheapest.

---

## Summary table

| #   | attack                                       | what it found                                                                                                                                                                                                                                                                                      | does the number survive?                                                                   | evidence                                                                                  |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | **Can a trivial implementation score well?** | A 3-line modal-word grep scores **strict 100%, weak/lower 100%, overall 95%**. A no-splitter, whole-section emitter scores **260/260 = 100% on every class**. The tool scores 91.5% / 84.5% / 0%. Floor **exceeds** the tool on both headline numbers.                                             | **STRICT RECALL: NO. WEAK/LOWER: NO. The numbers are below the floor.**                    | `probes.json → A1_floor`; `floor.mjs` reuses `findIn()` verbatim                          |
| 1b  | Is the floor stable?                         | Same 3 lines, splitter `/\.\s+/` → 13.5%; `…\|\n+/` → 3.1%. Recall is set by splitter agreement with `labelling.mjs`, not by extraction.                                                                                                                                                           | **NO — the number is not a property of the extractor.**                                    | `probes.json → A1_floor.splitter_sensitivity`                                             |
| 1c  | Precision floor                              | Bench reports no precision. Measured precision of the unclassified modal population: **36.8%** (before) / **29.2%** (after).                                                                                                                                                                       | **PRECISION: unreported, so unverified.**                                                  | `before/after-precision-labels-candidates.json`                                           |
| 2a  | Conditioning on the outcome                  | Premise mis-stated: `build-golden.mjs` never calls `requirements`; `run-bench.mjs:97` filters on the **labeller's** `rules.length > 0`. 5 protocols dropped; 3 would now yield 8 rules; **8448 and 9650 are the only 2 documents where the tool returns nothing at all.** 64 of 159 never sampled. | **PARTIALLY — the 5 exclusions are real conditioning; the stated mechanism is wrong.**     | `probes.json → A2_selection.conditioning_on_the_outcome`; replay via `rulesFromSection()` |
| 2b  | `text` vs blocks                             | **27/260 (10.4%)** of probes are in a section's `.text` but in **no block**. Bias runs **against** the tool.                                                                                                                                                                                       | **Denominator is inflated by ≥10% with parser-limited probes.**                            | 215 sections, 1,684 blocks, `include:["text","source_map"]`                               |
| 2c  | Is the selection rule honest?                | 33/100 of `golden.json` is not what `pickProtocols()` produces from the committed 159-doc corpus.                                                                                                                                                                                                  | **NO — `$meta.protocol_selection` does not describe the artefact.**                        | `pickProtocols()` replay; `git show HEAD:eval/corpus.json`                                |
| 2d  | Traceability                                 | 95/95 snapshot drift; **0/260 rules carry a snapshot or offset**; **10 probes unreachable** in the section they name (rfc 959 `read("5")` = 30 chars, cannot contain a 154-char probe).                                                                                                            | **NO — `build-golden.mjs` does not reproduce `golden.json`.**                              | live `read` transcript; `probes.json → A2_selection.golden_probes_not_reproducible`       |
| 2e  | `SKIP_KINDS`                                 | `references` (8) and `authors` (2) sections sampled; 8 bibliography probes admitted, all classed `label_error` by the project.                                                                                                                                                                     | **PARTIALLY — 8 known-bad probes in the denominator.**                                     | kind census; `before-miss-review.json`                                                    |
| 3   | Is matching too generous?                    | Current tool: **1/217** hits with a longer row (max ratio 3.146, a defective `{Comment:…}` probe rewarded). Instrument: **260/260 = 100%** for a whole-section emitter, no cap.                                                                                                                    | **Implementation: YES (barely). Instrument: NO — unbounded, 1 edit from being exploited.** | `probes.json → A3_matching_generosity`                                                    |
| 3a  | Is `exact_pct` a control?                    | Byte-exactness is a pure function of probe length ≤ 65 chars. 209/217 hits (96.3%) rest on normalisation alone.                                                                                                                                                                                    | **NO — it measures line length, not the extractor.**                                       | length/exactness correlation                                                              |
| 4   | Tier separation                              | Enforced by one ternary; tier is a pure function of the probe, so **no probe can be driven into the wrong pool**. But the pools **overlap**: 2/260 probes also in the forbidden pool; **46/100 documents, 640 rows in both**.                                                                      | **YES for separation. NO for pool disjointness.**                                          | `probes.json → A4_tier_separation`                                                        |
| 5a  | Label carrying                               | Carry key omits `kind` and overwrites. **One key already carries both verdicts** (rfc 7872, TRUE as requirement / FALSE as candidate).                                                                                                                                                             | **UNSOUND but low incidence — 1 contradiction in 499 keys.**                               | 4 label files, 523 rows                                                                   |
| 5b  | Non-unique `(rfc,text)`                      | **3,624/16,025 rows (22.6%)** are duplicates within a document; worst multiplicity 12. Precision sample: 285 rows, 233 distinct sentences.                                                                                                                                                         | **Sampler dedupes nothing; effective n is 82% of nominal.**                                | `probes.json → A5_label_carrying.non_unique_rfc_text_in_the_tool_corpus`                  |
| 5c  | Re-judged 25 labels                          | **24/25 = 96% agreement.** One disagreement (rfc 2045, labelled `list_introducer`, is a `MUST`). One 50/50 flagged. `boilerplate` is used as a reason and is **not in the rubric's seven**.                                                                                                        | **YES — the precision labels hold up.**                                                    | `probes.json → A5_label_carrying.independent_re_judgement`                                |
| 5d  | Golden-label quality                         | Project's own review: **20/48 reviewed misses are `label_error` (41.7%)**; 25/260 = **9.6%** of the denominator is a known defect. `corrected_recall` (93.1% / 97.3%) is hand-adjusted and not reproducible by any code.                                                                           | **NO — the recall denominator is in known bad shape.**                                     | `eval/results/before-miss-review.json`                                                    |
| 6   | VERIFY                                       | Tests the tool's store against itself. `G0189`: probe from section 12, matched by rows in sections 7/8/9/14, `slice(0,2)` verifies 7 and 8 → `verified`. Conditioned on recall; truncated to 2; `stale`/`ambiguous`/`integrity_failure` never exercised.                                           | **NO — 99.6% is a self-consistency rate.**                                                 | live `verify_citation` transcript; `probes.json → A6_verify`                              |
| 7   | CALLS                                        | Divisor is 260 golden probes, not rules. Honest: **2.35** per 40 reported requirements, **1.11** per 40 emitted rows — vs **68.31** as reported. **52.9% of calls are `verify_citation`.** Per-protocol: 4.17 calls/rule (1-rule docs) vs 1.72 (3-rule docs) = **2.4× penalty**.                   | **NO — the headline is 29–58× the honest figure and measures the harness, not a caller.**  | `probes.json → A7_calls`                                                                  |

### What is genuinely sound

- The two-tier separation logic (`run-bench.mjs:168`) cannot be driven into the wrong pool
  by probe content, and it is currently refusing 2 real cross-pool matches.
- The 25 precision labels I re-judged independently agree 24/25.
- `danglingHeadings` is a real label-free invariant and reports 0/95 on the current build,
  matching the README's claim.
- The harness speaks the real MCP stdio surface to `dist/index.js` with snapshots pinned.
  No number is produced by a path a caller cannot reach.
- `snapshot_drift` is reported rather than hidden, even though nothing acts on it.

### Reproduction

```
node eval/run-bench.mjs --tag redteam      # reproduces every headline number
```

`eval/audit/bench-red-team-probes.json` holds the floor computation, the per-rule tier
table (260 rows with pool, section match, length ratio, citation ids), the 25
re-judgements with my verdicts and reasons, and every count quoted above.
