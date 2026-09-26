# Precision rubric

`PRECISION` is the fraction of emitted items a human agrees are normative statements
for an implementer. It is labelled by hand, in `eval/results/<tag>-precision-labels.json`,
against the rules below. The harness never labels its own output.

Each sampled item carries its metadata: `kind` (`requirement` or
`non_strict_candidate`), `keyword`, `keyword_case`, `role`, `shape`, `reason`, and the
`text` the tool returned. Judge the `text`, not the metadata; the metadata is what the
tool _claims_, and the claim is what is being measured.

## Verdicts

- `true` — the sentence states an obligation, permission, prohibition or limitation on
  an implementation. Putting it in a generated compliance contract is correct.
- `false` — the sentence does not bind an implementer. Putting it in a contract is
  wrong, and the reason matters more than the verdict.

## Reasons for `false`

Record exactly one. These are the mechanisms the extractor has, so the list is the
extractor's failure surface, not a generic taxonomy.

- `definition_of_keywords` — the sentence defines or explains MUST/SHOULD/MAY, or
  reports that the document uses them. RFC 2119 and RFC 8174 are entirely made of
  these; an implementation has nothing to do with any of them.
- `descriptive_modal` — a modal used descriptively: a consequence ("this may cause a
  loop"), a possibility ("a server may be configured"), a courtesy ("the reader may
  wish to skip"). No actor is obliged.
- `non_modal_position` — a modal word that is not a modal here: a noun ("the MUST
  requirements"), a field name, part of an identifier, a quoted citation.
- `not_an_obligation` — the sentence describes what the protocol _is_ rather than what
  an implementation must do: motivation, history, comparison with another RFC, an
  example, a rationale.
- `list_introducer` — the sentence introduces a list ("the fields are as follows",
  "the options are:").
- `structural` — the item is not a sentence at all: a table row, a figure label, a
  field definition fragment, a fragment of a statement split by a page break.
- `reference_or_bibliography` — an entry, a citation, an author's address, a credit.

**Seven reasons, and only these seven.** `boilerplate` appears as a reason in
`before-precision-labels-candidates.json` (46 uses) and `after-precision-labels-candidates.json`
(11 uses), and it is not one of them. Those labels are not wrong — the RFC 2119 key-words
paragraph really is boilerplate — but the reason is outside the taxonomy, so a later reader
counting by reason cannot reproduce the judgement. Record `definition_of_keywords` for the
key-words paragraph, `not_an_obligation` for a copyright notice, and leave a `note` when the
sentence is genuinely a different thing.

## Verdicts for `kind: requirement`

A `requirement` is emitted because an upper-case RFC 2119 keyword was found in a prose
block. That is a syntactic test, and RFC 2119 §3 adds two more that the syntax does
not: only an action-verb clause can state a requirement, and the keywords are
case-sensitive (RFC 8174 §3). So an item in this list is a true positive when the
sentence obliges an implementer _and_ is not the specification talking about its own
keywords. A false positive here is more serious than one in the candidate list,
because it is counted in `coverage.total_requirements` and a caller who trusts that
count is wrong.

## Verdicts for `kind: non_strict_candidate`

Per RFC 8174 §3 an uncapitalised keyword has no normative force, so these are NOT
requirements and are excluded from `total_requirements`. The list is reported so that a
zero requirement count is not mistaken for the absence of normative language. A
candidate is a true positive when the sentence binds an implementer _and_ is not
`definition_of_keywords`. `role` and `shape` are the tool's own guesses; judge the text
and note where they disagree with the verdict — a disagreement is a finding, not a
reason to change the verdict.

## The two lists are judged by different heads

RFC 8174 §3: an uncapitalised keyword has no normative force. So the same sentence can be
`true` as a `requirement` and `false` as a `non_strict_candidate`, and that is not an
inconsistency — it is the two-headed standard above doing its job.

Which is why the carry key in `eval/apply-labels.mjs` is `(rfc, kind, text)` and not
`(rfc, text)`. The old key omitted `kind` and overwrote, so a contradiction between two
label files was stored silently. There already is one: rfc 7872, `true` in
`before-precision-labels.json` and `false` in `before-precision-labels-candidates.json`. The
script now reports such a collision and refuses to pick a winner. If you disagree with a
carried label, judge the sentence again and say so in a `note`; do not edit the earlier
file.

## The negative-probe rubric, for the one population that is not hand-labelled

The negative probes — statements that must **not** be in a compliance list — are _not_
hand-labelled. Each one is produced by a named mechanism test in `eval/lib/negative.mjs` and
the label **is** the mechanism, so the set can be re-derived from the corpus by anyone. That
is deliberate: a hand-picked negative is chosen by a person who has read the tool's output,
and it drifts toward the sentences the tool already rejects, which would make the score
flattering in exactly the way the positive set is.

What a mechanism cannot do is judge grammar, so two things are stated rather than guessed:

- A sentence carrying an **upper-case** RFC 2119 keyword is never labelled a descriptive
  modal. RFC 8174 gives it force, and the bench has no mechanism to argue with that.
- A sentence inside a **preformatted** block is reported as its own, contested class. RFC
  1122 indents its body text at column 12 and is therefore typed preformatted wholesale; the
  tool emitting its obligations is right, and a "never scan a non-prose block" rule would
  call it a false positive. Both readings are defensible, so the bench prints the number and
  asserts neither.

If you want the upper-case descriptive modals measured — "The length MAY be zero" is the
commonest false positive in RFC 2119 — they need a hand judgement, and the place to record
it is here: a new class, a named mechanism, and the population it fires on. Not a regex
borrowed from the extractor's own `shape` field, which is the claim under test.

## What to record

```json
{ "sample_id": "P001", "label": true, "reason": null, "note": "optional" }
```

or

```json
{ "sample_id": "P002", "label": false, "reason": "descriptive_modal", "note": "optional" }
```

Precision is reported overall and split by `kind` and by `keyword_case`, because a
number that is a weighted mix of a good list and a bad one hides which half is wrong.

## The sample is deduped, and that changes what precision means

22.6% of the rows the tool emits over the 100 measured protocols are duplicates of another
row in the same document — the worst document repeats one sentence twelve times. An
undeduped sample therefore labels the same sentence repeatedly, and its effective `n` is
smaller than its printed `n` in a way no reader can see.

Both samplers (`run-bench.mjs` and `precision-sample.mjs`) now dedupe on
`(rfc, normalised text)` and print how many duplicate rows they skipped. Two consequences:

- The reported precision is **sentence precision**, not row precision. A caller reading a
  list cares about the sentence.
- The carry-over rate in `apply-labels.mjs` is computed over distinct sentences, so it is
  comparable with the label files above even where the underlying sample was not deduped.

A change that raises recall and lowers the negative-probe score is overfitting, and both
numbers are reported together for exactly that reason.
