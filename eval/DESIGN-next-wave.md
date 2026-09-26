# The next wave: anaphora, notation, deontic modality

Three items that earlier reviews called "the boundary of the automation". They are not.
Each is a specified mechanism with a measured population, and none of them requires a
judgement call at query time. This file is the launch spec: an agent picking one of these
up should not have to re-derive the design.

The rule that applies to all three, and the reason the earlier reviews were wrong to stop:
**a caller building a compliance contract needs the actor, the bound, and the table row.
"We cannot tell" is a valid answer to give when the evidence is absent; it is not a valid
answer to give when the evidence is in the same paragraph.** The honest form of "we cannot
tell" is a recorded `resolved: false` with the reason, not a silent empty field.

---

## 1. Anaphora: resolve the pronoun, record the resolution

### The population

538 of 10 618 strict requirement rows (5.1%, 82 documents) open with a pronoun as the
subject of the clause the keyword governs:

    "It MUST NOT be used as a source address."                     (RFC 1122)
    "This option is obsolete; it SHOULD NOT be sent, and it MUST be silently ignored if received."   (RFC 1812)
    "It is intended to be human readable and MUST NOT affect operation of the protocol." (RFC 2865)

They are already extracted. What is missing is that `clause.actor` is `null` for them, and
`parse_status` is `partial` with the flag `actor_not_explicit`. A caller generating a
contract from `clause.actor` gets nothing for 5% of its obligations, and the reason sits
one or two sentences above in the same block.

### What to build

A real antecedent chain over the block, with the resolution recorded rather than applied
silently.

1. `resolveAntecedent(sentence, blockText, keywordIndex)` in a NEW module
   `src/analysis/anaphora.ts`. No edits to `src/parse/text.ts`.
2. The search is over the same block, backwards from the sentence, sentence by sentence,
   and inside a sentence backwards by clause. Candidate antecedents are noun phrases in
   subject or object position. Resolution stops at the first sentence that yields a
   candidate with a compatible type, where type is inferred from the nearest noun: a
   protocol entity (a field, an option, a message, a record, a header), a process (a host,
   a server, a router, a client, an implementation), or a value.
3. `Requirement.clause.actor` becomes the resolved phrase when the pronoun is the subject
   and the resolution is unambiguous. It is NEVER set from a guess: if two candidates
   compete and neither wins on type, the actor stays `null`.
4. Three new fields on `Requirement`, all required so a caller can audit the resolution:
   - `antecedent: { text: string; char_start: number; char_end: number; distance: number; type: "entity" | "process" | "value" | "unknown" } | null`
   - `antecedent_status: "resolved" | "ambiguous" | "not_found" | "not_pronominal"`
   - `antecedent_candidates: number` — how many competed, so `ambiguous` is a count and
     not a shrug.
5. The `actor_not_explicit` flag stays whenever the actor is still null, and a new flag
   `actor_resolved_from_antecedent` marks a row whose actor was filled this way. A caller
   that wants only literally-stated actors filters on the absence of that flag.
6. Anaphora inside a REQUIREMENT's own sentence is not anaphora: "It MUST NOT be used" at
   the start of a block, where the previous sentence is a heading or a list item, resolves
   to `not_found`, not to the heading. Headings, list markers, captions and table rows are
   not candidate antecedents. Getting this wrong produces a confidently wrong actor, which
   is the failure mode that matters most here.

### Tests, in `tests/anaphora.test.ts`

Table-driven, at least 18 cases, in three groups:

- **Resolves, unambiguously:** a protocol-entity pronoun following a sentence that names
  one; a process pronoun following "a host MUST …" then "It MUST NOT …"; a value pronoun.
- **Does not resolve, and says so:** two competing entities of the same type in the two
  preceding sentences (`ambiguous` with `antecedent_candidates: 2`); a pronoun whose
  antecedent is a heading; a pronoun with no antecedent in the block; a pronoun across a
  section boundary, which must be `not_found` because the block ends.
- **The danger group:** a case where a plausible-but-wrong resolution exists, and the test
  asserts `resolved: false`. If an implementation cannot pass this group it must not ship;
  a wrong actor in a generated contract is worse than a missing one.

One test must assert that `coverage.total_requirements` is unchanged by antecedent
resolution. Anaphora must not move a single requirement in or out of the count.

---

## 2. Notation: read tables and preformatted blocks, structurally

### The population

326 blocks carrying an upper-case RFC 2119 keyword are currently unread, across 126
documents: 292 classified `preformatted` and 34 classified `table`. The loss is now
reported (`coverage.keyword_bearing_blocks_skipped`), which made it safe to go and fix
rather than to argue about.

Of those, 34 are genuine tables and the rest is a mix of aligned prose, pseudo-code and
ABNF/ASN.1 notation. The distinction matters and is already implemented: this release
added `looksLikeNotation`, which is what keeps a table out of the _prose_ list. Reading
notation is a separate channel with a separate list, for the same reason the candidate
list is separate: a caller who asks for requirements must never receive a field-table row
by accident.

### What to build

1. The parser must make notation **structurally addressable**: each row or logical line of
   a `table` block becomes its own `Block` with `kind: "table_row"`, a stable id, and exact
   offsets. `collectLines` already knows the block; the work is splitting a block into
   rows at line boundaries and keeping each row's bytes contiguous, so a citation over a
   row verifies that row. Do NOT merge adjacent rows, and do NOT renumber anything.
2. A new extractor output alongside the existing two: `notation_requirements`. Same shape
   as `Requirement`, plus `block_kind: "table" | "preformatted"` and `row_index`. It is
   never merged into `requirements` and never counted in `coverage.total_requirements`; the
   count is reported in `coverage` as `notation_requirements_total` so a caller can see
   both numbers and decide.
3. A row is a requirement-shaped statement if it carries an upper-case keyword AND the
   clause the keyword governs is an obligation. For a table row that means the row must
   have a resolvable subject, which is the hard case:
   - `QR | MUST be 0 (Query)` — the subject is the cell to the left in the same row. The
     table's own layout gives it, so use it.
   - `Resent-From: | MUST be present` — the subject is the row label.
   - A row with no left-hand label and no subject in the row is returned with
     `actor_not_explicit` and NOT with a guessed subject.
4. The candidate pass must stop treating notation as a single opaque block, so a caller who
   reads `non_strict_candidates` sees row-level rows rather than a 2 697-character blob.
5. Warnings: `notation_rows_extracted:N` and `notation_rows_without_subject:N`. A number
   that cannot be attributed is reported, not dropped.

### Tests, in `tests/notation.test.ts`

At least 12 cases, using real table shapes: a pipe table, a `+---+` rule table, a
`Label: | Value:` two-column table, an RFC 822 header block, a pseudo-code block with no
subject at all, a CDDL block, an ABNF production, and one case per warning. Plus two
cross-cutting assertions: `requirements` contains no row whose block is a table, and
`total_requirements + notation_requirements_total` is reported so a caller can see the
whole.

---

## 3. Deontic modality: finish the detector

`classifyRequirementShape` implements the action-verb test of RFC 2119 section 3. This
wave's other agent is tightening it against 11 measured cases. What remains after that is
the harder half, and it is the largest single cause of candidate-list imprecision: 51 of
131 hand-reviewed false positives are sentences where a modal is used descriptively.

The distinction is not lexical, so no word list will do it. A modal is deontic when it
addresses an actor that can be held to it. It is descriptive when it reports a property of
the protocol, a possibility the protocol permits without anyone being required, a courtesy,
or a modal inside a noun phrase or a relative clause. The signals:

- **grammatical mood**: an imperative or a root-modal clause with an explicit subject is
  deontic; a finite indicative clause reporting a property is descriptive;
- **the subject's type**: an implementer-type subject ("a host", "a server", "an
  implementation", "an originator", a named field's owner) can be held to a modal; a
  protocol-entity subject usually cannot ("the checksum **may** fail" reports a property);
- **attachment**: a modal inside a relative clause modifying a noun, or inside a gerund
  subject, modifies the noun, not an actor — "parameters which **may** be in place",
  "a field name **may** contain";
- **the surrounding frame**: a sentence inside a section whose title is `Introduction`,
  `Terminology`, `Background`, `Security Considerations` or a definition list is descriptive
  far more often, and that is a _document_ property already available, not a topic guess.

Implement it as a small set of named predicates with a documented decision order, and make
`shape` a claim the caller can audit: add `shape_basis: "mood" | "subject-type" |
"attachment" | "frame" | "keyword-lead"` naming which signal decided it, and
`shape_confidence`. `role: "unknown"` and `shape: "indeterminate"` must stay reachable —
they are honest answers and the tool promises they are read.

Test with at least 24 cases, at least a third of them `descriptive`, and with the 11
already-written cases in `tests/normative.test.ts` kept passing unchanged.

---

## What must not regress

Whichever of the three lands, all of these hold:

- `coverage.total_requirements` counts only prose requirements, never notation, never
  provisional, never declarative.
- `declarative_specifications` (the other agent's channel) never appears in `requirements`
  with or without `include_provisional`.
- A citation over any new row type verifies against the pinned snapshot.
- The four bench numbers are recomputed after the wave and reported, not assumed. A change
  that raises recall and lowers precision is overfitting to the golden set and is reported
  as such, with both numbers.
