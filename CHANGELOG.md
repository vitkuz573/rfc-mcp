# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Fixed, after the adversarial pass

Ten read-only auditors worked this corpus to refute it rather than confirm it. Their
consolidation is `eval/audit/SYNTHESIS.md`; the per-finding evidence is in
`eval/audit/`. What follows is only what is in the tree. Everything the pass found and did
not fix is in the next section, and a diagnosis is not a fix.

**Versions.** `parser rfc-text-1.7.3 → 1.8.0`, `extractor normative-2119-8174-1.6.3 →
1.7.0`, `server 0.5.3 → 0.6.0`. The extractor bump was owed and not paid at the time: three
changes inside `analyzeNormative` - the sentence boundary, the abbreviation veto and
`LIST_MARKER` - alter rows that `commitDocument` stores, so **one `snp_` id was naming two
derivations**, and `reanalyze` could not repair it because it returns `changed: false` before
parsing when the id hash is unchanged. A snapshot id is a hash of the document, its bytes
and the last two triple values, so an unversioned derivation change is invisible by
construction. The version test that was supposed to prevent this is a fixed-point check with
no baseline and does not.

- **A web page can no longer become a document.** `fetchPublication` recorded the
  `content-type` and never compared it, and the HTTP layer rejected only non-200 and
  non-404, so an HTML 503 error page was stored as an RFC and analysed as one: measured
  `status: "ok"`, 2 requirements at `parse_status: "complete"`, and `verify_citation`
  returning **"verified"** - quoting `<p>The server MUST be restarted.` No adversary is
  needed; any upstream hiccup during a sync does it, and every other guarantee here is
  downstream of a citation resolving to the right bytes. The bytes are now the gate and the
  header is corroboration: a missing header is tolerated, because a proxy may strip one, but
  a body that sniffs as markup or as binary is refused with a retryable `UPSTREAM_CONTRACT`.
  Fourteen tests, six of which assert that a real document is **not** refused - with a
  charset parameter, with a form feed, with a BOM, the XML rendition, and a body whose angle
  brackets are below the sniffed head.
- **Sixteen requirement rows stated the opposite of their own sentence.** `MUST not` matched
  the positive `MUST` and was reported `polarity: "positive"`, `confidence: 0.9`, no flag -
  `req_76dcffb7c47de7e6` is "A registrar MUST not generate 6xx responses.", which as written
  instructs a contract to require the registrar to generate them. RFC 2119 §3 is explicit
  that the negation belongs to the construct and must be in the same case, so the sentence is
  not strictly well-formed; the choice was between two wrong answers and only one is
  dangerous. It is now `MUST NOT` / negative with a `negation_case_not_upper` flag, so a
  caller wanting strict case conformance sees the deviation and a caller wanting the meaning
  sees the prohibition. The window is one word across any whitespace, and it stops at a
  clause break, so "MUST, not because it is optional" stays positive.
- **`MAY NOT` was missing from the keyword vocabulary.** RFC 2119 §3.8 defines it and it is
  as normative as `MUST NOT`; without it an upper-case `MAY NOT` matched the positive `MAY`
  and was reported as an opportunity where the RFC states a prohibition. Its absence also
  made a new code path throw a `TypeError` on RFC 1812 and RFC 2068, found by the parser
  audit rather than by any test. The lookup is guarded as well, so a future vocabulary gap
  degrades to the positive reading instead of taking a `requirements` call down.
- **A quoted field name no longer deletes the sentence.** `isQuoted` was a two-character
  window in each direction, so RFC 1123 §5.2.16's `"domain" MUST NOT interpret…` became a
  *definition* - and the candidate pass deletes a definition because the strict pass already
  owns the keyword. The sentence was in **neither** channel; RFC 3261 §19.1.1's `"phone"
  SHOULD be present` is the same window compounded by the mention cap, so it is invisible and
  no counter moves. A keyword is quoted when the quotes enclose **it**, which is the only
  reading under which the function answers its own question.
- **Every candidate and mention span now addresses its own sentence.** Measured: **0 of 2 211**
  candidate rows had a span that addressed their `exact_text` - the span was the
  four-character `MUST` and the text began five characters earlier - and 13 747 mention rows
  had the same shape, with a mention's `citation_id` hashing the keyword's offset against the
  sentence's text. The requirement path already carried the correction; these two did not.
  The keyword's position is preserved in `context`.
- **`blocks.ordinal` is a document counter, so block order is a total order.** It was
  per-section, and `listBlocksWithKeywords` ordered by it alone: measured over 43 documents
  spanning every typeset era, **41 had duplicate `(snapshot, ordinal)` pairs** - 19 347 of
  them - and **41 were read in non-document order**, with within-bucket order falling back to
  the `blocks` primary key, which is hash order. `max_candidates` truncation and the fragment
  state machine both read through it. Now 0 and 0, and `ORDER BY ordinal` **is** document
  order. Block ids are deliberately unchanged by the id formula, because `blk_` ids are
  cited.
- **A bracketed tag in body prose is prose again.** `reference_entry` now requires both a
  bibliography context and citation shape, because a tag at the start of a line is not
  evidence of a bibliography: `[STD13]`, `[RFC8955]` and `[RFC1010]` are the same shape and
  only the last is a citation. **144** such blocks sat outside a bibliography across the 43
  documents; 17 were reclassified to prose and those 17 are the measure - RFC 4343's `[STD13]`
  quotation and RFC 9117's `[RFC8955]` paragraph among them, each carrying an obligation that
  was in no channel at all. `reference_entry` outside a bibliography: **118 → 0**. Quoted
  material is surfaced rather than promoted: it lands in the candidate channel and
  `coverage.total_requirements` does not move, because whether a quotation is this document's
  obligation is a reading decision and the caller is the one who makes it.
- **An underlined heading's rule is no longer section content.** All 75 were affected:
  `read(768, "Fields")` began `"------\n\nSource Port is an optional field…"`, so the first
  sentence of every underlined section started with a row of dashes and the section's first
  real statement was neither classifiable nor quotable - which is why RFC 768 yielded **zero**
  golden rules despite containing "The UDP module must be able to determine the source and
  destination internet addresses". The heading now spans both lines.
- **`findHeadings` refuses page furniture, as `collectLines` already did.** A bare date stamp
  is in `PAGE_FURNITURE`, so the text was blanked - but the heading matcher never consulted
  it, so RFC 768's outline still listed a section numbered `28` titled `Aug 1980` whose entire
  content was a printed page's running head, and RFC 1350 two more. Cleaning the text and
  refusing to recognise the line are two decisions; only one had been made. The stamp remains
  in the section's verbatim text and in its `furniture_lines`: reported, not hidden.
- **RFC 1812's appendices are no longer inside its REFERENCES section.** `APPENDIX` was
  matched case-sensitively, so `APPENDIX A. REQUIREMENTS FOR SOURCE-ROUTING HOSTS` matched
  nothing, `11. REFERENCES` ran from line 7433 to 9258, and because the extractor skips a
  `references` section **every requirement those six appendices state was absent** - and the
  tool's answer to "where are the appendix obligations" was "those are references". 200 → 206
  sections, and 212 blocks moved out of the skipped bucket. Roman labels are read as the
  labels they are, and a dot leader in a title is refused.
- **A count in a sentence is not a section number.** RFC 876 filed **93% of itself** under
  numbers lifted from mid-sentence digits: 9 sections → 3, with 33.6 KB of 36.3 KB re-filed
  under the structure the document actually has. The rule asks the document whether it numbers
  its sections at all, and the period rule is the publication format's own spelling of a
  heading - `2.  Rules` is one, `483 hosts were tested` is not.
- **The masthead is prose and the title is a heading.** Every RFC's masthead was typed
  `table` and its centred title `preformatted`, because `looksLikeNotation` reads "two columns
  separated by a run of spaces" at any indent. The discriminator is that a masthead's second
  column is **right-aligned on a repeated edge** while a data table's is ragged. Measured over
  43 documents: 43 mastheads re-typed, **38 titles typed `heading` with zero false positives**,
  and the counter that decides `coverage.completeness` drops 4 078 → 3 954. **The honest
  answer did not change: 0 documents reach `complete` before, 0 after** - every RFC also
  carries packet diagrams, field tables and ASN.1. The fix did not reach a verdict, and the
  report says so rather than tuning the rule until one appeared.
- **`diff` says when a mode did not run.** `diff.ts` gave up above 2 000 lines per side,
  fell back to a structural diff, and wrote the reason into a local array that `DiffResult`
  had no field for - so the explanation was computed and thrown away, and
  `diff(5246, 8446, "text")` was byte-identical to `mode: "structure"` while reporting
  `status: "ok"`. `DiffResult` now carries `run`, with the requested mode, the mode that ran,
  the line counts and the ceiling.
- **Four code-review findings in the citation and paging work.** `provisional_entries_included:N`
  was pushed on every page with the whole-document count, so reading RFC 3261 produced **49
  wrong machine-readable warnings** on pages that carried none; a page ≥2 with zero candidates
  emitted a stub saying "the 0 candidate rows are on page 1", contradicting the contract line
  added in the same change; a candidate's `stable_citation_id` was minted on the way out and
  the resolver's note promised `reanalyze --all` as the remedy, which can never fix an id
  nothing stores; and `getSectionByNumber` was `LIMIT 1` over a **non-unique** column -
  **113 of 159** snapshots have a duplicated section number and RFC 1350 has ten sections
  numbered `2` - so 12 rows resolved against the wrong section. The resolver now searches every
  section the number names.
- **An `ambiguous` citation named the same place twice.** `verify_citation` built
  `locator.span` from the **block's** extent while the quote was the **record's** text, so two
  records in one paragraph - which is what a paragraph stating two obligations looks like -
  produced two citations with identical locators. Measured: **15 of 27** ambiguous answers
  reported the same locator twice, so the response said "this sentence appears twice" and
  handed over one address twice, and the caller's only documented way to disambiguate had
  nothing to select on. The span is now the record's own offsets in all four units, with lines
  counted from the record. Verified on RFC 1812: two rows in one block both returned
  `27727..28240` and now return `27729..27870` and `27872..28057`, each equal to its own
  stored row's span. The bench's `S3_duplicate_quote` condition went **12/27 to 27/27**, and
  all five VERIFY conditions now pass at 100%.
- **The contract stopped asserting things it had not measured.** `confidence` is documented as
  a function of `parse_status` rather than as a score it varies within, because it is a pure
  function of it. `dependencies(direction: "incoming")` reported 0 edges with
  `truncated: false` while emitting `inbound_relations_truncated_at_378/789/2567`. And the
  `search` scope field named the text index while the search had covered the whole catalogue,
  so a caller concluded the opposite of the truth; every consulted scope is now named, with
  `miss.consultable` separating "no such thing" from "not in what you have".
- **A fabricated citation in this file was removed.** `RequirementShape` and the `requirements`
  tool description cited "the action-verb test of RFC 2119 section 3" and **quoted rules 1, 2
  and 4 that do not exist in that document**: a text search of RFC 2119 and RFC 8174 for
  "action verb" returns nothing, §3 is the list of keyword definitions, and §6 is the guidance
  to authors. The test is a convention, not a rule of the specification, and the code now says
  so. An evidence-first tool asserting a citation it had not verified was the worst class of
  error available to this project.

### Found, not fixed — recorded because a diagnosis is not a fix


An adversarial pass over the six reported strict misses localised four of them, and the
fixes are **not in this tree**. They are written up with the query that reproduces each one
in `eval/results/pending-fixes.md`, and they are listed here because the alternative is
worse: a changelog that reports a diagnosis as a repair teaches a reader to stop reading
it. Nothing below ships.

- **A sentence cut by a page break is emitted as a complete requirement.**
  `splitSentences` runs per block, and a page break is a block boundary, so the strict
  pass keeps only the half carrying the keyword and reports the fragment as
  `parse_status: complete`, `confidence: 0.9`, `flags: []`. Measured, each figure under a
  stated definition: **129** rows are blocks that end without terminal punctuation with a
  form feed before the next block, of which **92** carry no flag and **111** are labelled
  `complete`; **134** are a block-boundary split the next block continues, 93 unflagged.
  Wider still, **486** rows are labelled `complete` and are not complete sentences. An
  earlier figure of 274 for this class is **not reproducible** under either definition and
  came from a broader one that was never written down; the reproducible numbers are carried
  here instead. 19 more are cut at a blank line; 97 rows in 31 documents begin lower case
  and are not list markers. Live
  proof that this is not theoretical: RFC 8470 §6.1 (Standards Track, 2018) emits
  "…SHOULD either delay forwarding the" with `actor: "support for a given request"`, and
  RFC 959's only requirement is
  "The server MUST close the data connection under the following conditions:" with
  `condition: null`, `parse_status: complete`, `flags: []` — and its citation verifies.
  A contract built from that has an obligation whose condition is missing and a
  certificate saying nothing is wrong. (`pending-fixes.md` Y1, Y2.)
- **`non_strict_candidates` is not a safety net for a strict miss, by construction.** The
  candidate pass drops every upper-case keyword in a prose block because the strict
  extractor already owns it, so when the strict pass emits a fragment the second channel
  has been emptied on purpose and the sentence is in neither pool. (`Y3.`)
- **Body prose opening with a bracketed tag is typed as a bibliography entry.**
  `classifyBlock` returns `reference_entry` for any block starting `[…]`, so a paragraph
  quoting another document is dropped before sentence splitting. **184** such blocks sit
  outside any bibliography across 45 documents; 22 carry a modal; zero requirement rows
  were reachable from any of them. (`X3.`)
- **`coverage.keyword_bearing_blocks_skipped` is case-sensitive, so the weak tier's losses
  are invisible in the counter added to expose losses.** It tests a case-sensitive probe
  while the candidate pass selects blocks with SQL `LIKE`, which is not; the same predicate
  written twice with different case semantics. (`Y4.`)
- **Every candidate and mention row's span addresses the keyword, not its own sentence.**
  Measured: **0 of 2 211** candidate rows had a span that addressed their `exact_text` —
  the span was the four-character `MUST` and the text began five characters earlier — and
  the same shape holds on 13 747 mention rows, where a mention's `citation_id` hashes the
  keyword's offset against the sentence's text, so the id names one string and locates
  another. The requirement path already carried the correction; these two did not. **Fixed
  in this tree** (sentence-level span, keyword position preserved in `context`); the
  code-point fields the requirement path also carries are still missing here, because the
  span type for these rows is declared in `src/core/types.ts` and was being edited
  concurrently. Declared, not done.
- **`verify_citation` does not check the row's span.** It tests whether the quote occurs
  anywhere in the block, and returns the *block's* extent in `locator.span`, so a quote
  verifies against a span that may point somewhere else in the same block. Live proof: a
  mention returns `verified` with a 358-character span for a 118-character quote whose
  own span is eight characters. Not fixed.
- **The `stale` verdict is unreachable on the snapshot-scoped path** (0 of 23 324
  constructions), and the different-derivation case returns `not_found` instead. So one
  of the five documented verdicts cannot occur, and a caller branching on it is reading a
  value that never appears. `integrity_failure` needs disk corruption. Not fixed.
- **`stable_citation_id` is less stable than its name.** It hashes a *sentence*, and
  sentences come from the splitter, which is part of the derivation — the exact thing a
  re-parse changes. Its other input, the section number, is also a parse output: the
  indented-heading repair recorded below took RFC 1122 from a five-entry outline to 122
  sections. A change in how headings are recognised renumbers sections, and every id under
  them changes with no version bump. Separately, the store never passes an occurrence
  index, so 10 requirement ids each cover two different obligations in two different
  blocks. What it does hold, verified: invariance to block ids, byte offsets and snapshot
  ids. Not fixed, and the documentation must stop implying more than that.
- **A standard is not findable by naming the protocol.** `search("SMTP")` ranks RFC 5321
  at 54 of 57. Four documents carry the byte-identical title `Simple Mail Transfer
  Protocol` and score 17.29 / 17.08 / 15.36 / **8.77** — the lowest is the one in force.
  `search("File Transfer Protocol")` ranks RFC 959 at 28 of 28. Not fixed, and it is the
  first thing an engineer does.
- **`diff` reports a clean result between two empty extractions.** `diff(2178, 2328,
  mode:"requirements")` returns `changes: []`, `summary: {}`, `truncated: false`,
  `status: "ok"`, no warnings, because both OSPF documents extract zero requirements. An
  OSPF engineer is told the 1998 Internet Standard changed nothing relative to the 1991
  draft. `status: ok` is an assertion. Not fixed.
- **`coverage` has no completeness verdict, and `keyword_usage` is absent on precisely the
  documents that need it.** RFC 2328 reports `total_requirements: 0` *and*
  `keyword_bearing_blocks_skipped: 0` — a typed certificate of absence, with a note telling
  the caller to read the zero as "not a gap". The thread through all of the above: the
  tool's honesty lives in `warnings`, its assertions live in `coverage`, and a compliance
  contract is a machine-readable artefact, so it reads the assertions. Not fixed.
- **A read of `requirements` on RFC 8446 returns 2 180 036 bytes for 427 rows in 3 calls**
  — 133× the advertised `max_output_bytes`, with no bound and no size preview. Two
  documented flags reduce it by 74%. Not fixed.

### Fixed, third pass

Two reported misses were not misses. RFC 3501 §6.3.2 (`req_ef57b5b5a4df0dd4`) and RFC 2865
§5.22 (`req_bd53b91b5c5c7a2b`, `req_e936227f15d10948`) are emitted verbatim with no flags;
only the pre-round run recorded them as missed, and the pre-round derivation is not
re-derivable, so they are closed rather than re-examined. `eval/results/before-miss-review.json`
now says resolved, with the row id as evidence. Two earlier attributions were wrong and are
corrected rather than softened: G0040 was called anaphoric and a documented boundary when the
sentence is emitted whole and its subject is inside it, and G0099 was blamed on a list marker
that was not the blocker - reclassifying the `o` markers would not have merged blocks, because
the strict pass splits per block regardless of kind.

- **A page of `requirements` re-shipped the whole candidate list.** Every page carried up to
  2 000 rows of `non_strict_candidates`, on the pages where the caller has already been given
  it. Page 1 is unchanged; later pages get the identical counts, an empty `candidates` array,
  `omitted_on_page: n` and a `note` naming page 1 and how to get the rows again. A caller that
  pages and finds nothing must be able to tell "there are none" from "they were on the previous
  page". `include_provisional` rows follow the same rule - they are candidate rows, and
  without this the fix is defeated by one flag - with `coverage.provisional_omitted_on_page`
  alongside.
- **The bench's section reach is now guarded by an invariant instead of by 100 rules.** A
  golden set cannot see a defect that removes sections from an outline, because it samples
  sections *from* the outline. `run-bench.mjs` recomputes `dangling_headings` per protocol on
  every run. Measured: **95 protocols, 0 with dangling**, including RFC 959, 1122, 1123 and
  2300 where the recorded value is 63. The guard's reads are made through `mcp.call` and do
  not enter the CALLS figure, because a guard is not the thing being measured.

Four further items in this round were **diagnosed and not fixed** on the day and are written up
in "Found, not fixed" above; three of them were fixed in the adversarial pass that followed and
one - the sentence cut by a page break - is still open. The counter that was case-sensitive is
the entry that matters: it was added in this release to make a loss knowable, and it counted
only the losses the strict pass would have seen.

### Added, third pass

- **`stable_citation_id` (`scit_`): a citation that survives a re-parse.** The existing
  `cit_` id hashes the snapshot, the block, the byte offset and the quote, so every one of
  those changes on a routine parser bump - 94 of 100 pinned snapshots in the corpus had to
  be re-pinned, and a citation recorded in a contract became unverifiable. The new id
  derives from what a re-parse does not change: the RFC number, the section number as a
  string, the quote, and an occurrence index. The store computes it on write, because the
  section number is not on the row. `verify_citation` accepts it and answers `stale` - not
  `verified` - against a snapshot other than the one that minted it, because the caller's
  pinned bytes are not the bytes the text came from; and `ambiguous` is reachable, naming
  both spans, when the same sentence stands twice in a section. Bytes, chars and lines are
  exact; `codepoint_start`/`codepoint_end` are 0 on a stable match, because nothing records
  a sentence's code-point offset inside a block and deriving one from a possibly-repaired
  decode is a number nobody checked.
- **Migration 8, with no backfill.** `requirements.stable_citation_id` and
  `mentions.stable_citation_id`, plus an index created by the migration and deliberately
  not by `SCHEMA_SQL`, which would fail against any existing corpus. No backfill, because
  the section number is not on the row: this is a re-derivation, not a backfill, and
  backfills re-run on every process open - measured at minutes per start. A version bump
  requires `reanalyze --all` anyway.
- **The contract says what it lost and how it parses.** `capabilities` now names
  `page_furniture_lines` (the field that says which lines were emptied to produce
  `text`, without which "printing artefacts removed" is a claim a caller cannot check), the
  two loss counters, both citation id kinds and the paging rule. `read`'s
  `text_fidelity` names the same field, and the `read` tool description names it too - the
  emptying is the design, and a response that hid which lines were emptied would be hiding
  the design.
- **`parse_notes`: a document's reach can depend on how it was typeset.** Section discovery
  recognises indented numbered titles and underlined titles, because RFCs before about 2010
  were typeset; both counts are reported per snapshot in `warnings`; a document with neither
  is expected to be modern-format. This is the single most surprising property of the
  parser and it was previously only inferable from a warning.
- **A third instrument: the documents the golden set could not sample.** Five of the 100
  protocols produced zero rules, because pre-2010 subsection titles were missing from their
  own outline and the bench samples sections from the outline. `eval/golden-ext.json`
  samples those documents again from an outline that now lists them, plus every other
  ingested document outside the main set. It reports recall and nothing else, and
  `comparable_with_main_bench` is `false`: a document with no addressable structure cannot
  be sampled, so no probe could be cut from it and no rule could be missed - a before/after
  pair would be a number with nothing behind it. Precision is deliberately absent, because
  a precision figure over rows nobody has reviewed is decoration.

### Fixed, second pass

The first pass was measured, and measuring it found four more problems, one of them a
regression of its own making.

- **A pipe table was read as a paragraph, and the whole table entered the requirement
  list as one row.** RFC 5322's field table is 2 697 characters of `+---+` rules and
  pipe-delimited cells. It sat at three columns of indent, and the prose test only ran on
  blocks indented six or more, so `classifyBlock` returned `paragraph` without looking. A
  contract line that is a table is worse than a missing one, because it gets quoted and
  cited. `looksLikeNotation` - pipe cells, a `+---+` rule, a CDDL or schema rule header, a
  block that is mostly one quoted string, box drawing - now runs at every indent, because
  indent says where the typesetter put a block and not what the block is. RFC 9472's CDDL
  data model, 2 031 characters, went the same way. The count is reported either way: RFC
  5322 goes 265 -> 57 requirements, RFC 9110 430 -> 408, and those rows were never
  obligations.
- **A global regex was shared across analyses, and one boolean test moved the starting
  point of every later scan.** `TERM_PATTERN` carries `g`; `test()` advances `lastIndex`,
  and `String.prototype.matchAll` copies `lastIndex` into the clone it walks. The loss
  counter added below called `TERM_PATTERN.test(...)`, and requirements silently stopped
  being found in the same process. The symptom was two tests that passed alone and failed
  together, which is the only shape this bug has and the reason five review rounds could
  not reproduce it. Sentence scanning goes through `matchTerms()`, which resets
  `lastIndex` first, and the boolean question uses a non-global clone.
- **`coverage` now says how much text was not read, and how much of it mattered.**
  `blocks_skipped_by_kind` and `keyword_bearing_blocks_skipped`, plus a
  `normative_text_in_unscanned_blocks:N` warning on every response. Tables and preformatted
  text are out of scope by design; a specification that states its rules in a field table
  reports a low count, and until now nothing on the response distinguished that from an
  absence. Corpus-wide, 278 non-prose blocks carry an RFC 2119 keyword and none of them is
  scanned. RFC 1122: 312 blocks skipped, 19 of them keyword-bearing.
- **The first version of that counter cost 29 seconds per `requirements` call, which is
  worse than the silence it removed.** The per-kind breakdown ran on every call, and its
  plan scanned all 53 530 blocks in the corpus and joined them to `sections`: 29 500 ms on
  RFC 3261, measured, where the rest of the same query is 10 ms. Two things came out of
  it. The counts are now written to the snapshot row at derivation time, beside
  `prose_block_count` - the loss is a property of the derivation, not of the question. And
  the migration that would have backfilled them does not: backfills re-run on **every**
  open, so a slow one is not a one-time migration cost but a permanent tax on start, and
  the honest version of this backfill took minutes per start. A version bump already
  requires `reanalyze --all`, which is what populates them. RFC 3261: **29 000 ms -> 326
  ms**, with the same numbers reported. The missing index was the obvious suspect and was
  not the cause - `blocks_by_section` already leads with `snapshot_id`. It was the plan.
- **Two more of the RFC Editor's fixed texts are excluded** from the candidate list - the
  other two shapes of the same BCP-13 legal notice, found by measurement rather than by
  reading RFC 13. They were 11 of 185 rows in a hand-checked sample.

### Changed (breaking), second pass

- `server.version` 0.5.0 -> 0.5.3, parser `1.7.0` -> `1.7.3`, extractor `1.6.0` -> `1.6.3`,
  store schema 6 -> 7 (`snapshots.unscanned_block_count`,
  `keyword_bearing_unscanned_block_count`, `unscanned_block_kinds_json`). Snapshots
  re-derived for all 159 documents from stored bytes; no network fetch. Migration 7
  carries no backfill on purpose, so a corpus that is not re-derived reports 0 for the new
  counters; the version bump is what requires the re-derive.
- `coverage` gains `blocks_skipped`, `blocks_skipped_by_kind`,
  `keyword_bearing_blocks_skipped` and `unscanned_note`. Additive.
- A `requirements` response on a document with keyword-bearing non-prose text now carries a
  `normative_text_in_unscanned_blocks:N` warning. A caller that treats warnings as fatal
  will see it on documents that were previously silent.

## [Unreleased]

### The bench came first

Every number below was measured before it was changed, on a 100-protocol golden set
(`eval/`, 260 labelled rules, 1973-2024, eight layers) that runs only through
`tools.rfc.*`. The golden set is generated by a published rule, not typed: the corpus is
cut into ten strata by RFC number and sampled evenly, sentences are chosen because they
carry a modal token **matched case-insensitively**, and the tier is then derived from case
alone. Selection therefore cannot prefer a tier, and no label was ever taken from the
extractor's output. `strict` is matched only against `requirements[].exact_text` and
`weak` only against `non_strict_candidates.candidates[].exact_text`, because mixing them
inflates recall by construction.

| number | before | after | what moved it |
| --- | --- | --- | --- |
| RECALL, strict | 87.3% (103/118) | **91.5% (108/118)** | indented body text read as prose |
| RECALL, weak (lower-case modal) | 84.5% (109/129) | 84.5% (109/129) | unchanged; 17 of its 20 misses were the bench's own fault |
| RECALL, keyword-free specs | 0% (0/13) | 0% (0/13) | unchanged, and structurally unreachable |
| PRECISION, requirement list | 79.5% (159/200 hand-labelled) | **94.3% (217/230)** | one row per statement; the newly reachable rows are real prose |
| PRECISION, candidate list, comparable slice | 26.3% (30/114) | **31.4% (44/140)** | boilerplate exclusion |
| CALLS per 40 rules | 120 | **68.3** | requirement page size |
| VERIFY | 99.3% (267/269) | 99.6% (234/235) | - |

Candidate-list precision as a whole reads 36.8% -> 29.2%, and that comparison is **not
valid**: the change removed 1 447 rows from that list corpus-wide, and the rows it
removed were mostly the upper-case ones - 58 of 190 sampled rows before, 21 of 185 after
- because they were statements the strict pass should have owned. The comparable slice
is the lower-case rows, which did not move: 26.3% -> 31.4%, +5.1 points, 140 hand-labelled
rows.

Hand review of all 48 "before" misses: **11 were tool defects, 5 were probe artefacts
(the tool had returned the statement and the probe over-captured it), 20 were faults in
the bench, and 12 were keyword-free specifications.** Corrected for the bench's own
faults, the strict tier missed 8 statements of 116 - 93.1%, not 87.3%. Both figures are
reported; the raw one is what the harness prints.

### Fixed

- **An indented paragraph was read as preformatted, so a whole era of documents reported
  almost no requirements.** `classifyBlock` called every chunk with a six-column indent
  `preformatted`, and RFCs from 1973 to the mid-1990s indent their BODY TEXT - RFC 1122
  sets every paragraph at column 12. The strict extractor reads prose blocks, so it read
  almost nothing: RFC 1122 reported **17** requirements while its own candidate list held
  **255 upper-case modal-and-demand statements from the same text**, every one of them
  marked `non_prose_block`. Those were not provisional statements; they were the
  requirements of the document, counted as absent. A paragraph is prose whatever column
  it starts in, and what marks notation is the absence of sentences - no terminal
  punctuation, a low share of word-like tokens, internal column alignment, box drawing.
  Corpus-wide: 10 110 -> 11 640 requirements, and RFC 1122 goes 17 -> 305, RFC 1123
  23 -> 264.
- **An indented subsection title was body text, so the statements under it were
  unreachable.** RFCs of that era set subsection titles by indenting them, three columns
  per level, and `findHeadings` treated every indented line as prose. RFC 1122's outline
  was five entries long - 1 through 5 - and the 114 titles below it were not unreadable
  but unreachable, because no query returns a section the outline does not name. The two
  conditions that keep this from promoting a paragraph are properties of the typeset
  page, not of any document's subject: the number must be at least two components deep
  (a level-1 title in these documents sits at column 0 and is already found there), and
  the line below must be indented **further** than the candidate, which is what a title
  does and a paragraph does not. Contents entries are excluded by region. 4 838 titles
  recognised across the corpus, 19 documents gained sections and none lost any.
- **An underlined section title was not a section at all.** RFCs from 1973 to the
  mid-1980s were typeset: their titles carry no number and no fixed name - RFC 768 titles
  its sections "Introduction", "Format", "Fields" - so no list of known titles can find
  them. The entire body of RFC 768 was one section called "Front Matter" and
  `read(section=…)` could not address any of it. 75 titles recognised corpus-wide; RFC
  768 goes from 3 sections to 11.
- **A date in a front matter became a section.** `28 August 1980` parsed as section 28
  titled "Aug 1980", and RFC 768's outline duly contained an entry called `28`. The bare
  date stamp and the `title ... RFC n` running foot of that era are now claimed as page
  furniture, which is also where they belonged: they had been surviving into the text a
  caller copies.
- **`max_results` on `requirements` was silently clamped to 20, the search page limit.**
  The input schema advertises a maximum of 200; the service clamped to
  `limits.maxSearchResults`. RFC 3261 holds 876 requirements, so reading the whole
  compliance list cost 44 calls where 5 suffice, and nothing in the response said the
  caller's number had been discarded. `maxPageSize` is now its own limit, and a clamp is
  reported as `max_results_clamped:500->200` rather than left to be inferred from
  `limits.applied`. CALLS per 40 rules: **120 -> 71.1**, and the extra pages needed to
  read a full list fell from 321 to 25.
- **The candidate list was a quarter boilerplate.** In a 190-item hand-checked sample, 46
  rows were one of two fixed texts the RFC Editor prints on every modern RFC: the status
  notice whose only verb is a pointer to the info page, and the BCP-13 legal notice
  about redistributing the document. Neither says anything about the protocol. Both are
  now excluded on a whole-sentence match, and the exclusion is counted
  (`boilerplate_statements_excluded:N`) - a filter nobody can see is indistinguishable
  from a filter that hides a miss.

### Changed (breaking)

- `server.version` 0.3.0 -> 0.5.0, parser `rfc-text-1.6.0` -> `rfc-text-1.7.0`, extractor
  `normative-2119-8174-1.5.0` -> `normative-2119-8174-1.6.0`, store schema 5 -> 6 (new
  `requirements.keywords_json`). Every snapshot id changed, and `snapshot_redirects`
  resolves the old pins transitively, so a historical citation still verifies. The corpus
  was re-derived from stored bytes for all 151 documents; no network fetch was involved
  and no document text changed.
- **The strict extractor emitted one row per KEYWORD, not per statement.** The candidate
  list was fixed to one row per statement in an earlier round; the strict list was not, so
  "EMTU_R MUST be greater than or equal to 576, SHOULD be either configurable or
  indefinite, and SHOULD be greater than or equal to the MTU of the connection" came back
  three times, and `coverage.total_requirements` - the number a caller builds a contract
  on - counted one sentence as three requirements. Corpus-wide **1 411 of 11 640 strict
  rows, in 96 of 119 documents**, repeated a sentence already in the same list. What
  remains after the fix - 209 rows in 43 documents - is genuine repetition: RFC 2865 says
  "It MAY be used in Access-Accept packets" in six different attribute sections, and those
  are six different places in the RFC. The strict list now carries `keywords[]` with each
  keyword's own strength, polarity and offsets, so collapsing loses nothing: `term` is the
  first keyword, which is what a caller filtering on `term` has always meant.
- A requirement's `span` and `citation_id` now cover **the statement** instead of the
  first keyword inside it. A caller anchoring a contract line to a requirement quotes the
  sentence, and a citation that verified four letters of it verified nothing about what
  the contract would say.
- `non_strict_candidates` on a document whose only candidate-shaped sentences were the
  RFC Editor's fixed texts can now be empty where it was not. Two documents in the
  corpus (RFC 8448, example handshake traces, and RFC 9650, a registry of bit values)
  report zero requirements and zero candidates; both were reporting the status notice.
- `max_results` on `requirements` now reaches its advertised 200. A caller that relied on
  20-row pages will see fewer, larger pages from the same cursor sequence.
- New parse warnings `indented_subsection_headings_recognised:N` and
  `underlined_headings_recognised:N`. They are counted rather than applied quietly
  because a document whose structure is found only because of how it was typeset is a
  parse whose reach depends on its era, and that should be visible.


### Changed (breaking)

- `read` on a section: `text` is now the section's content with printing artefacts removed.
  It was the byte-exact slice, so on a pre-1990 RFC the field a caller would naturally copy
  from carried the printed page's running head, its running foot, and a raw form feed. The
  exact slice is not dropped and its span still denotes it — it is `text_verbatim`, with
  `text_sha256_verbatim`, the emptied line numbers in `page_furniture_lines`, equal line counts
  in both, and `text_clean` kept as an alias of `text` for 0.2.0 callers. The `section` object
  with a source map still carries the verbatim text. Citations are unaffected:
  `verify_citation` works on blocks, which have carried no furniture since `rfc-text-1.3.0`.
  This was reported in five consecutive review rounds and answered each time with an
  explanation of why the old default was defensible; explaining it was never the fix.
- `server.version` is coupled to the derivation versions and the coupling is enforced.
  `contract-versions.json` records the triple, and `tests/contract.test.ts` fails when
  `loadConfig()` disagrees with it — so a parser or extractor bump cannot ship under an
  unchanged server version. The previous entry in this changelog claimed 0.2.0 fixed the
  missing signal, and then the parser moved 1.5.0 -> 1.6.0 under that same 0.2.0, which is
  exactly the failure the claim was supposed to prevent.

### Fixed

- The sentence splitter never split at a hard line break. Its separator class was spaces and
  tabs, so a period at the end of a line never ended a sentence: twenty separate statements on
  twenty consecutive lines came back as one, and `exact_text` for a requirement or candidate
  could be a whole hard-wrapped paragraph. That inflated the `demand` bucket directly — the
  action-verb test scans the clause it is given, and a paragraph almost always contains a verb,
  so a paragraph was classified `demand` whatever it said. A line that does not end with
  terminal punctuation still continues into the next one, so wrapped sentences quote whole.
- An indented "Table of Contents" was never recognised. `extractToc` required the header at
  column 0, and RFC 1035 writes it at column 28, so the whole contents was indexed as body
  text — which is where "Inverse queries (Optional) 40 6.4.1." came from, reaching search
  results and candidate lists as though the RFC had said it. The absence is now reported as
  `table_of_contents_header_not_found` rather than passing silently. The unnumbered titles
  ("Abstract", "References", "Author's Address") are likewise matched on the trimmed line, so
  an indented one is still a heading.
- One row per statement, not per keyword occurrence. A sentence holding two keywords was
  emitted twice, and because the action-verb test reads the clause after the keyword, the same
  text could be filed under two different shapes at once — so filtering on `shape` could not
  say which row described the real statement. 28 duplicated texts in RFC 1035, now 1 (a
  sentence that genuinely appears in two sections). Every keyword keeps its own classification
  in `keywords`.
- The candidate pass no longer reads a different document than the strict one. It applies the
  strict extractor's section-kind and block-kind skips, so a bibliography entry ("[RFC-1010] J.
  Reynolds, ... which should be consulted") and the authors' address are excluded. The strict
  count already excluded them, and `interpretation.caveat` promised the candidate list did too.
  Counts are reported as `candidate_sections_skipped` and `reference_entry_blocks_skipped`.
- A sentence a page break split in half is reported separately. A block is a contiguous byte
  range, so a sentence running across a page break becomes two blocks and the second opens
  mid-clause — "in this memo, and may be datagrams." The text is verbatim and correct; it is not
  a whole statement, so it is flagged `continues_previous_block` and moved to a `fragments` key
  instead of appearing in the list a caller reads as rules. Nothing is dropped.

- The action-verb test of RFC 2119 section 3 is now applied to every non-strict candidate,
  as `shape`. The specification defines when a keyword has effect: rule 1 admits MUST "only in
  a sentence that also contains an action verb", rule 2 requires "an explicit action to be
  prohibited", rule 4 requires "some action to be permissible". So a clause with no action verb
  is not a requirement by the specification's own criterion, not by a judgement about mood.
  Measured on RFC 1035: "Redesigned services may become available in the future" goes from
  `modal` to `description`, and "This procedure should include:" to `list_introducer`.
  "it may be unable to load zone data" stays `demand` — it is genuinely ambiguous, and the
  `indeterminate` value exists so the lexicon's coverage is visible rather than assumed.
- A form feed no longer hides from the furniture check. `isPageFurniture` tested the
  *trimmed* line, and `trim()` removes U+000C as whitespace, so it was asking whether the
  empty string is a form feed and the answer was always no. 1157 section texts carried a raw
  `\f` — an invisible control character in text a caller copies into code. The line is now
  recognised, reported in `page_furniture_lines`, and dropped from `text_clean`.
- The column-0 warning no longer reads as data loss. It counted numbered lines not used as
  headings and called them rejected, which is what a reader took it to mean. Those lines are
  content by design and are kept as exact, searchable blocks: RFC 2119's five are the
  definitions of MUST and MAY, and RFC 1034's nine are headings that were recovered. The
  warning now says they were kept, and the loss-shaped signal is reported separately as
  `toc_sections_without_a_heading` — a number the table of contents promises and no heading
  supplies.
- `maxQuoteChars` is no longer advertised as a limit that does not exist. It was declared in
  `capabilities.limits` and enforced nowhere, while the corpus holds a requirement sentence of
  2697 characters against an advertised 1200. Enforcing it would truncate a quote away from the
  bytes it came from and make it unverifiable, so the limit is documented as not enforced and
  `limits_notes` says to page with `read(max_output_bytes)` and its `byte_cursor` instead.

### Added

- `include_provisional` on `requirements`. A document that predates RFC 2119 states its rules
  without the keywords, and the main normative API returned an empty list for the two most
  important DNS documents; a compliance list was not generatable at all. The surviving
  candidates are now appended to `requirements`, each flagged `provisional: true`, and stay
  out of `coverage.total_requirements`. For RFC 1035 that is 135 entries against a strict count
  of 0.
- Server-side `role` and `shape` filters on `requirements`. The `note` had been telling callers
  to filter on `role=modal` while the schema only accepted `scope`, `term` and `keyword`, so
  the filtering was the caller's to do by hand.
- Candidates are ranked rather than left in document order. The first page of RFC 1035 opened
  on "The optional completion services ... have been deleted"; it now opens on statements that
  can carry an obligation. Ties keep document order, so ranking reorders and never drops.
- `ensure_top_catalog_hits` on `search`. `ensure_rfcs` needs numbers the caller already has,
  which does not answer "which RFC describes X" over 9842 catalogued and 121 ingested documents
  — and guessing a number is how a caller ends up reading RFC 4649 expecting DANE. The catalog
  covers every document, so it now proposes the numbers, the server ingests them, and the
  response reports each with its title.
- `limits_notes` in `capabilities`, stating for each limit whether it is enforced.

### Changed

- Version 0.1.0 → 0.2.0 → 0.3.0. Three rounds of changes had shipped under an unchanged
  `server.version`, so there was no signal that snapshot ids had been retired and callers had to
  diff `parser_version` by hand to find out. See the breaking-changes entry above for why the
  bump alone was not the fix.
- Parser `rfc-text-1.4.0` → `rfc-text-1.6.0`. See `snapshot_redirects` above: any historical pin
  is one hop from the current id.
- The `read` and `search` tool descriptions state the `text` / `text_clean` distinction, the
  `include` / `source_map` matrix, and that a case-insensitive text hit is not a requirement.

### Not changed, and why

- A snapshot id is a hash of the document, its bytes and the rule versions that derived it, so
  a parser or extractor bump retires every id. That is the property that makes an id mean
  "these exact bytes under these exact rules", and weakening it to keep pins alive would let a
  citation verify against a derivation it was not made from. What is fixed instead is the cost:
  a retired pin now names the document and its current id, and redirects are rewritten
  transitively so re-pinning is one call rather than one per release.
- Whether a sentence is deontic or descriptive is not decidable from surface syntax.
  "A server may be unable to load zone data" and "A server must handle queries concurrently"
  are both modal with an action verb. The tool reports what it can decide and marks the rest
  `indeterminate`; deciding intent needs a reader, not a lexicon.
- Text search covers ingested documents only. Ingesting all 9842 is a storage and freshness
  policy decision, not a code fix. The coverage is now stated in every response and
  `ensure_top_catalog_hits` closes the discovery loop.
- Errata remain an overlay and are never applied to publication text. Applying them would make
  a citation unverifiable against the published file, which is the file a reader checks against.
- Anaphora across a block boundary is not a parser defect. RFC 2181 §5.5 reads "Information
  sections, as required.  However it should not be repeated in the same, or any other, section" —
  a whole sentence with an anaphoric subject, returned as one candidate and correctly not flagged
  as a fragment. Deciding what "it" refers to needs the preceding sentence, which is a reading and
  not a parse. `verify_citation` names the block, and the preceding block of the same section is
  one call away.

### Fixed (earlier in this release)

- `errata` no longer returns an empty list for `status: "any"`, and `status:
  "held_for_document_update"` now matches. The filter was passed to SQL verbatim, so the
  explicit "every status" value matched nothing, and the enum's snake_case spelling never
  equalled the display text the RFC Editor ships (`held for document update`) — 16 of
  RFC 1035's 29 errata were unreachable through any value the schema accepts. Status is
  canonicalized in one place (`canonicalErrataStatus`), both spellings resolve, and every
  response carries `status_filter`, `total_unfiltered` and `available_statuses`, so an empty
  result names the statuses that do have errata instead of looking like an RFC without any.
- The text search grammar has the boolean operators it was documented as lacking. `OR`, `AND`
  and `NOT` are recognised in upper case only, because a lower-case `or` is a word that occurs
  inside RFC prose and reinterpreting it would change the meaning of an ordinary search. Every
  response flags which operator was applied.
- Text search states its own coverage. `corpus` now reports `catalog_documents` and a
  `ingested_text_only:<n>/<m>` string, and a zero-hit result from a partially ingested corpus
  is flagged, so "the term is absent from what I loaded" can no longer be read as "the term is
  absent from the RFC corpus". `ensure_rfcs` ingests up to 20 named documents before searching.
- `requirements` reports what the strict extractor rejected. A count of 0 could not be told
  apart from a parser gap: RFC 1035 writes "Z  Reserved for future use.  Must be zero in all
  queries and responses" and RFC 4033 uses a lower-case "must" throughout, and neither is a
  requirement by the letter of RFC 8174 §3 — yet both bind an implementer.
  `non_strict_candidates` lists them with `keyword_case`, the structural `reason`, and `role`
  (`modal` / `non_modal` / `unknown`) so vocabulary false positives such as "the recommended
  method" can be filtered out. `role: "unknown"` means the shape was not decidable without a
  parser and is never folded into either bucket. Candidates are not requirements and never
  enter their count. `coverage.prose_blocks_scanned` states how much of the document was read.
- List markers no longer leak into a parsed clause. RFC 2822 markers reached the extractor
  attached, so the actor read `o  The RRSIG RR and the RRset` — 81 stored rows in the DNS
  corpus. Markers are stripped, the hard-wrapped layout of a clause is collapsed, and
  `list_marker_stripped_from_clause` records that it happened. `exact_text` and the offsets
  still address the original bytes, so every citation remains verifiable.
- `read` accepts `max_output_bytes` from 64 instead of 1024. The floor was a page size, not a
  byte budget, and rejected a question the server can answer exactly; truncation was already
  reported, so a small budget narrows an answer instead of failing it.
- A section read now carries `text_clean` and `page_furniture_lines` when the section has
  page furniture, and warns with the line numbers. `text` remains a verbatim slice, because
  its char and byte span have to denote exactly the string reported beside them — that
  invariant is what lets a caller locate what it read — so the furniture stays in it. The
  cleaned rendering is reported alongside, with the line count preserved, instead of leaving
  the caller to guess which lines to distrust. A caller copying `text` into an implementation
  was copying `Mockapetris    [Page 26]` into it.
- `requirements` reports a document's own stance on the requirement language as
  `keyword_usage`, with a citation. RFC 2181 §1 opens with "This memo does not use the oft
  used expressions MUST, SHOULD, MAY, or their negative forms", which is why its requirement
  count is legitimately zero; RFC 2119 and its successors instead adopt the language, where a
  low count is the surprising outcome. A zero count that the document itself explains was
  being indistinguishable from a zero count that hid a gap.
- A read that lists blocks without `source_map` now warns. Such a response carries block rows
  whose `text` is empty, which is a success that answers a different question than the one
  asked; the default (`include` omitted) is unaffected and still returns the text.
- A retired snapshot id explains itself, and stays one hop from the current one. A
  rule-version bump re-derives every document under a new id, and a caller holding an older pin
  got a bare `NOT_FOUND`. Retired ids are recorded in `snapshot_redirects` and the error now
  names the document and its current id. Redirects are rewritten transitively on replacement,
  so a pin from three releases ago resolves to the current id in a single step rather than
  walking a chain of intermediate ids — without that rewrite it resolved to an id that was
  itself already retired, and the caller was told to try again.
- Page furniture is recognised in both publication eras. RFCs predating the current plain-text
  format carry a running head (`Mockapetris      [Page 26]`) and a running foot
  (`RFC 1035   Domain Implementation and Specification   November 1987`); neither matched the
  anchored patterns, so each became a paragraph block of its own and split the field table
  around it — 2545 such blocks in the corpus. The running foot is pinned by requiring a month
  and a four-digit year as its last two fields, so a body line that merely mentions a page
  number still survives. Dropped lines are counted in the parse warnings.
- `verify_citation` resolves a candidate's citation. Candidate citations are computed on
  demand, so the id was not among the stored records and verification returned `not_found` for
  a fact the server had just handed out. The id is now recomputed over the block's sentences,
  the same way a search hit's is.
- `reanalyze --all` re-derives every ingested document from stored bytes, which is the
  counterpart of a parser or extractor version bump. Run it after bumping either version;
  enumerating every RFC by hand was the step most likely to be forgotten.

### Added

- `non_strict_candidates` on `requirements` (see above).
- `by_role` and `by_shape` on the candidate analysis, so a caller can see how much of the list
  was actually decided and discount the rest.
- `keyword_usage` on `requirements`: whether a document disclaims the requirement language
  ("this memo does not use ... MUST") or adopts it, with a citation (see above).
- `text_clean` and `page_furniture_lines` on a section read (see above).
- `furniture_lines` on a stored section, with a migration.
- `prose_block_count` on a snapshot, with a migration backfill, so a requirement count is
  reported next to the number of blocks it was derived from.
- `snapshot_redirects`, so a retired snapshot id resolves to its replacement.

### Changed

- Parser `rfc-text-1.2.0` → `rfc-text-1.6.0`, extractor `normative-2119-8174-1.4.0` →
  `normative-2119-8174-1.5.0`. Both are part of snapshot identity by design, so every
  `snp_<hash>` minted under the old versions is retired. `reanalyze --all` re-derives the
  corpus from stored bytes without re-fetching anything.
- `resolve` with `with_xml` now stores the RFCXML asset for a document that is already cached.
  The flag was only honoured on the path that re-derives a document, so on an already-ingested
  RFC it returned the cached snapshot without the asset and the following
  `read(target: "xml_outline")` failed with `NOT_CACHED` — while telling the caller to
  re-resolve with `with_xml`, advice that could not change anything. The asset is not part of
  snapshot identity, so it is attached to the existing snapshot rather than minting a new one.
- An `xml_outline` read on a document the RFC Editor publishes without RFCXML now fails with
  `NOT_FOUND` and states that no such representation exists. It previously returned the same
  `NOT_CACHED` as an unstored asset, which asked a caller to retry a request that could never
  succeed. Across the corpus, 9 of the DNS-family documents are in this state: the editor
  returns 404 for their `.xml`, and the catalog correctly lists no `xml` format for them.

- Text search no longer fails with `INTERNAL` when a `section:` filter or `block_kinds` is
  combined with a query: the FTS5 subquery referenced the table by name while the outer query
  aliased it, which SQLite could not resolve.
- `total` and `next_cursor` of a filtered text search are now computed with the same filters as
  the returned rows. `countBlockMatches` accepted `section_prefix` and `block_kinds` and then
  ignored them, so totals were inflated and pagination never terminated.
- A catalog refresh no longer destroys ingested documents. `upsertCatalogInner` deleted and
  re-inserted the catalog row, and since `snapshots.rfc` references `catalog(rfc)` with
  `ON DELETE CASCADE` that silently removed every snapshot, section, block, requirement and asset
  of the affected RFCs — a full `sync` would have emptied the corpus. The row is now updated in
  place.
- The FTS5 index no longer accumulates rows for deleted snapshots. FTS5 virtual tables ignore
  foreign keys, so the cascade never reached `blocks_fts`; each re-ingest leaked a full text
  index, which inflated totals, skewed bm25 ranking and could surface a `snapshot_id` that no
  longer existed. The index is now purged per RFC on replacement, `vacuum` removes stale rows, and
  search only returns rows whose snapshot is still present.
- `refresh: true` actually re-fetches. The HTTP layer supported conditional revalidation, but
  nothing set the flag, so a fresh TTL cache answered the request while the response claimed the
  document was resolved from upstream.
- Re-observing unchanged bytes no longer mints a new `snapshot_id`. The metadata hash covered
  `observed_at`, so identical content produced a different id depending on when it was fetched.
- Citations returned by `rfc_search` are verifiable. They cover a whole block rather than a stored
  requirement record, so `rfc_verify_citation` now resolves them against the block bytes instead of
  reporting `not_found`.
- Unknown or misspelled tool arguments are rejected with `INVALID_ARGUMENT` instead of being
  silently dropped, and the message lists the accepted names. Every `batch` operation is validated
  against the schema of the tool it names.
- Catalog search no longer fails with a SQL syntax error when a `status:` or `stream:` facet is
  combined with a text term: the facet clause was appended as a second `WHERE`.
- `rfc:`, `status:` and `stream:` now actually narrow a catalog search. `rfc:` was ignored
  entirely, and the facet comparison matched a JSON blob against a partial object, so it never
  matched. Slug and display name are both accepted.
- A filter that the selected scope cannot honour is now reported in `warnings` rather than
  dropped: `filters_not_applied_to_catalog` for `section:` and `relation:` in a catalog search,
  `filters_not_applied_to_text` for `status:`, `stream:` and `relation:` in a text search.
- A query made only of catalog facets (`status:std stream:IETF`) is answered from the catalog
  instead of failing, and an explicit `scope: "text"` is reported as relaxed rather than ignored.
- `relation:` now filters a text search. It resolves through a new normalised
  `reference_citations` index, so results are the blocks that really contain a citation site of a
  normative / informative / in-body reference. Unsupported values are rejected with
  `INVALID_ARGUMENT` instead of being ignored.
- `reanalyze` re-derives a snapshot when the parser or extractor version changes. The reuse check
  compared only `(rfc, format, bytes, metadata hash)`, so a version bump looked like unchanged
  content: the freshly computed analysis was discarded and `reanalyze` reported a new snapshot id
  that was never written. Rule versions are now part of that check.
- A field filter with no value (`status:`) is now rejected with `INVALID_ARGUMENT` instead of
  being searched for as an ordinary word.
- `rfc_read` with `target: "xml_outline"` now returns the parsed RFCXML structure. The outline
  was parsed and then discarded, so the target always answered with an empty list.
- The RFCXML reader no longer skips the body of a document. RFCXML v3 wraps sections in
  `<middle>`; only direct children of `<rfc>` and back matter were read, so the outline of a
  modern RFC contained a handful of back-matter sections instead of its ~300 real ones.
- The RFCXML reader recovers section numbers from the v3 page name (`section-1.1` → `1.1`,
  `section-appendix.a` → `Appendix A`), takes the visible heading from `<name>` when `<title>`
  is absent, and uses the element name as the authority for the references section. A body
  section titled "URI References" is no longer classified as the references section, so the XML
  and plain-text outlines now agree: for RFC 9110 all 293 shared section numbers carry the same
  kind in both representations.
- The RFCXML reader collects citations from `<xref target="...">`, which is the reason to read
  the XML at all: the target is exact, while the rendered label is presentation. A degraded XML
  parse now states its warnings instead of only flipping the status.
- A cited non-IETF document now gets its own identity instead of being reported as unresolved.
  When the entry text designates the document — `FIPS 197`, `ISO/IEC 10646:2003`, `ITU-T X.680`,
  `ANSI X3.4`, `NIST SP 800-38C`, `UAX #15`, or a URL — the reference is reported with
  `target_kind: "external"`, `resolution: "external"` and the recovered `external` identity, and
  appears in the dependency graph as a `cites_external` edge. Across the 60-document corpus this
  resolves 159 references that were previously lumped in with genuinely unidentifiable ones
  (unresolved dropped from 196 to 37). The remainder are books and papers with no designation and
  no URL, and stay `unresolved` — that is what the state means.
- The store applies schema migrations on open. `SCHEMA_SQL` only creates missing tables, so a
  column added to an existing table never reached a corpus that already had that table; the
  reanalyze that introduced the external-identity columns failed loudly rather than corrupting
  anything. Migrations are now declared, idempotent and checked against the live schema, and an
  index over a migrated column is created by the migration rather than by the base schema.

## [0.1.0] — 2026-09-26

First public release. Evidence-first, strictly read-only MCP server for the IETF RFC corpus.

### Added

**MCP surface**

- 15 read-only tools with zod input schemas, `outputSchema` and MCP annotations:
  `capabilities`, `resolve`, `metadata`, `read`, `search`, `requirements`, `references`,
  `dependencies`, `diff`, `errata`, `history`, `source`, `verify_citation`, `status`, `batch`.
- 10 snapshot-addressed `rfc://` resource templates plus static `rfc://index/status` and
  `rfc://catalog/manifest`.
- 6 workflow prompts: `brief`, `requirements_audit`, `compare`, `dependency_review`,
  `citation_check`, `offline_review`, each carrying the evidence discipline and the rule that RFC
  text is untrusted data.
- Dual-era stdio transport: MCP revision `2026-07-28` with automatic fallback to the classic
  `initialize` handshake (`protocol: "auto"` in OpenCode).
- Self-describing `rfc_capabilities` contract: guarantees, tools, resources, prompts, search
  grammar, limits, upstream sources and policy.

**Evidence model**

- Immutable, content-addressed snapshots (`snp_<hash>`) over
  `(rfc, format, raw bytes, metadata hash, parser version, extractor version)`.
- Deterministic citation ids (`cit_<hash>`) verifiable byte-for-byte through
  `rfc_verify_citation` with verdicts `verified | stale | ambiguous | not_found |
  integrity_failure`.
- Offsets reported in three units — UTF-8 bytes, UTF-16 code units, Unicode code points — plus
  line numbers, with the guarantee `rawBytes.slice(byte_start, byte_end) === text`.
- Envelopes carrying `status`, `provenance`, `warnings`, `next_cursor` and hard `limits` on every
  response.

**Parsing and analysis**

- RFC Editor plain-text parser (`rfc-text-1.2.0`): column-1 headings with table-of-contents
  authority, appendix/references/authors/index classification, page-furniture removal that also
  splits blocks, paragraph/list/preformatted/table/reference-entry classification, exact offsets,
  deterministic ids.
- Hardened RFCXML reader (RFC 7991 v3, RFC 7749 v2): DTD and entity declarations rejected, XInclude
  never resolved, bounded depth/nodes/text, authoritative section tree with anchors.
- RFC 2119 / RFC 8174 extraction: eleven keywords, upper case only, longest phrase wins,
  strength/polarity derivation, clause structure (`condition`, `actor`, `action`, `exception`),
  explicit `parse_status` and `confidence`, and mentions instead of requirements for code, tables,
  figures, reference sections, quoted definitions and keyword discussion.
- Reference extraction with normative/informative classification, resolved RFC/BCP/STD/FYI targets
  and in-body citation sites with offsets.
- Typed bounded dependency graph; `inferred` edges are never produced.
- Structured diffs across `text`, `structure`, `requirements`, `metadata` and `references`, with
  `modality_changed` distinguished from breaking changes.

**Storage and operations**

- SQLite store using the built-in `node:sqlite` with FTS5; atomic per-document commits,
  monotonic index generations, integrity-bound cursors, rebuildable search index.
- Operator CLI: catalog sync, bulk and targeted ingestion, status, outline, requirements,
  references, search, show, verify, diff, offline `reanalyze`, `reindex`, `vacuum`.
- `rfc-mcp reanalyze` re-derives all analysis from already stored bytes, fully offline, with no
  re-fetching.

**Safety**

- HTTPS-only host allowlist, no user-supplied URLs, bounded size/time/concurrency, ETag
  revalidation, stale-on-error with explicit warnings.
- Bounded search grammar; FTS5 input is always quoted literals; punctuated phrases are expanded
  into an AND of their parts.
- RFC text treated as untrusted data; author email addresses stripped at the source boundary;
  structured logs with redaction; no model-visible write tool.

### Fixed

- Byte offsets in BOM-prefixed documents: `TextDecoder` strips a leading `U+FEFF` by default, which
  shifted every byte offset by three and made exact citations unverifiable. Decoding now uses
  `ignoreBOM: true`; invalid UTF-8 is reported as `byte_offsets_approximate_invalid_utf8` and
  citation verification falls back to exact character offsets.
- Page furniture inside a paragraph no longer splits the stored text from the raw bytes, so a
  sentence spanning a page break is contiguous and verifiable.
- Actor extraction for main clauses with an exception tail
  ("… except that the server MUST NOT …") now yields the real actor and the
  `exception_before_keyword` flag.
- Unnumbered sections (`Abstract`, `References`, `Author's Address`, …) are addressable by title.
- Heading-only sections (e.g. `19. References` immediately followed by `19.1`) are preserved
  instead of being dropped.

[Unreleased]: https://github.com/vitkuz573/rfc-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vitkuz573/rfc-mcp/releases/tag/v0.1.0
