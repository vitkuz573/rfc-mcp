# The bench

A measurement instrument for the scenario this server exists to serve: **RFC → normative
compliance contract → code**. It answers four questions and refuses to answer them
differently for different protocols.

```
node eval/build-golden.mjs            # 100 protocols, 260 labelled rules
node eval/run-bench.mjs --tag before  # the four numbers
node eval/run-bench.mjs --tag after   # the same four numbers after a change
```

Both scripts speak MCP over stdio to `dist/index.js` (`eval/lib/mcp.mjs`) — the same
`tools.rfc.*` surface an agent uses, with the snapshot pinned. Nothing reads the
database, so a number cannot be produced by a path no caller can reach.

## Why the golden set is generated, not typed

A hand-written list of quotes is selected by the person who also reads the tool's
output, and every such list drifts toward the sentences the tool already finds. So the
labels are a published function of the document text (`eval/lib/labelling.mjs`):

- **Which 100 protocols.** The corpus sorted by RFC number, cut into 10 equal strata,
  10 evenly spaced from each. No document is added, dropped or reordered by hand, so
  the bench cannot drift toward a family the extractor happens to handle. It spans
  1973–2024 across every layer: transport, routing, security, mail, web, directory,
  naming, time.
- **Which section.** Numbered sections sampled outward from the middle of the document
  (½, ¼, ¾, ⅛, ⅞, ⅜, ⅝) until the protocol has three rules.
- **Which sentence.** Any sentence carrying a modal token matched **case-insensitively**
  (`must|shall|should|may|required|recommended|optional`), length 45–260, rejecting
  captions, bullets, code, cross-references, printing artefacts, examples and table
  rows. Case is _not_ part of selection.
- **Which tier.** Derived from case alone: an upper-case RFC 2119/8174 keyword makes
  the rule `strict`, anything else `weak`.

The consequence that matters: selection cannot prefer a tier, and it never consults
`requirements`. `build-golden.mjs` does not call that tool at all, so a recall number
cannot be circular.

## The two tiers never mix

A `strict` probe is matched **only** against `requirements[].exact_text`. A `weak` probe
**only** against `non_strict_candidates.candidates[].exact_text`. A provisional hit never
counts as a normative one — that would inflate recall by construction, because the
provisional list is three times the size of the requirement list on a pre-2119 document.

`keyword-free-spec` rules — a bound with no modal anywhere in the sentence — are
reported as their own class. No keyword-driven extractor can reach them by design, and
folding them into the headline number would hide a structural limit inside an average.

## Matching

Whitespace-normalised containment, applied to probe and candidate alike, because RFC
text is hard-wrapped and `exact_text` keeps the line breaks. Both verdicts are reported
(`found` and `exact_pct`) so the reader can see how much recall depends on that
normalisation rather than on the extractor finding the statement.

## The four numbers

| number    | what it is                                           | where it comes from                                                         |
| --------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| RECALL    | golden rules found, per tier and per class           | `run-bench.mjs`, phases 1–2                                                 |
| PRECISION | emitted items a human agrees are normative           | **hand-labelled**, `PRECISION-RUBRIC.md`; the harness only draws the sample |
| CALLS     | `tools.rfc.*` calls per 40 rules, with the breakdown | every call the harness makes                                                |
| VERIFY    | `verify_citation` → `verified` on every matched item | phase 3                                                                     |

## The second instrument

A labelled golden set of 100 protocols cannot see a defect that removes sections from an
outline, because the set samples sections _from_ the outline. So `run-bench.mjs` also
computes **label-free corpus invariants** over all 151 ingested documents: documents with
zero strict requirements, zero candidates, both zero, sentence-fragment counts, duplicate
`exact_text` rows, median and mean requirement length, the share of candidates classified
`demand`, and the keyword stance. No labels, no protocol knowledge, and it keeps guarding
the corpus when the golden set is too small to notice.

`build-golden.mjs` records one more: `dangling_headings` — subsection headings the
sampled text shows and the outline does not list. That is what caught the defect this
round fixed, and it needs no golden rule to catch it.

## What a miss is not

A miss is a defect only if the sentence binds an implementer. `eval/results/<tag>.json`
lists every miss; the report classifies each one, and a miss on a sentence that turned
out to be descriptive is recorded as a label that was too generous rather than as a tool
defect. The reverse is also stated wherever it applies: if recall rises and precision
falls, that is overfitting to this set and the report says so.

## Files

- `corpus.json` — inventory of the 151 ingested documents (which exist, not what they say)
- `golden.json` — 100 protocols, 260 rules, with the selection rules in `$meta`
- `lib/mcp.mjs` — minimal stdio MCP client
- `lib/labelling.mjs` — the selection and tier rules, as code
- `build-golden.mjs` — writes `golden.json`
- `run-bench.mjs` — writes `results/<tag>.json` and the precision sample
- `PRECISION-RUBRIC.md` — how a human labels an emitted item
