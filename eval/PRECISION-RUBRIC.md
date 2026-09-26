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
