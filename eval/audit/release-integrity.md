# Release integrity audit: changes that can ship without their signal

Read-only audit. Nothing in `src/`, `tests/`, `eval/` or the corpus was modified. The only
commands run were `git status/diff/log/show`, `grep`, `sed`, `node` (string arithmetic, no
corpus access), `npx tsc -p tsconfig.json --noEmit` and `npx vitest run tests/contract.test.ts`.

## Observed state

**Version triple** (`contract-versions.json`, and identical hard-coded strings at
`src/core/config.ts:143-144`):

```
server    0.5.3
parser    rfc-text-1.7.3
extractor normative-2119-8174-1.6.3
```

`SCHEMA_VERSION = "8"` (`src/store/schema.ts:13`).
`CONTRACT_VERSION = "ietf-rfc/1"` (`src/core/types.ts:8`), unmoved for the whole project.

**Git state**: `HEAD = a48fa2c` on `main`, 7 commits ahead of `origin/main`. Working tree:
18 modified, 11 untracked, nothing staged.

```
 M CHANGELOG.md                          M src/mcp/tools.ts
 M eval/README.md                         M src/service/rfcService.ts
 M eval/corpus.json                       M src/store/database.ts
 M eval/lib/labelling.mjs                 M src/store/schema.ts
 M eval/results/before-miss-review.json   M tests/normative.test.ts
 M eval/run-bench.mjs                     M tests/protocol.test.ts
 M src/analysis/citation.ts               M tests/service.test.ts
 M src/analysis/normative.ts              M tests/store.test.ts
 M src/core/types.ts                      M tests/text-parser.test.ts
?? eval/DESIGN-next-wave.md               ?? eval/results/pending-fixes.md
?? eval/build-golden-ext.mjs              ?? eval/results/strict-miss-diagnosis.md
?? eval/golden-ext.json                   ?? eval/run-bench-ext.mjs
?? eval/lib/labelling.test.mjs            ?? tests/citation-stability.test.ts
```

`npx tsc -p tsconfig.json --noEmit` — clean.
`npx vitest run tests/contract.test.ts` — 7 passed.

`git diff --stat src/parse/` is **empty**. The parser (`src/parse/text.ts`) is byte-identical
to `HEAD`. The extractor (`src/analysis/normative.ts`) is +796/−20.

---

## 1. Is the coupling enforced, or only asserted?

### What is actually compared

`tests/contract.test.ts:8-32` reads `contract-versions.json` and `package.json` **at test
time** (good — the value is not duplicated in the test) and makes four assertions:

```
VERSIONS.server        === PACKAGE.version
config.parserVersion   === VERSIONS.parser
config.extractorVersion=== VERSIONS.extractor
config.version         === VERSIONS.server
```

`loadConfig()` (`src/core/config.ts:125-146`) does **not** read `contract-versions.json`.
The two derivation values are hard-coded string literals at `src/core/config.ts:143-144`.
`grep -rn contract-versions` finds exactly three hits in the whole repo: the test, a comment
at `src/store/schema.ts:77`, and CHANGELOG line 310. **No runtime code reads the file.**

### Answers to the four probes

| probe                                                                                                     | caught? | why                                           |
| --------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
| bump `package.json` version alone                                                                         | **yes** | `VERSIONS.server !== PACKAGE.version`         |
| bump `contract-versions.json` alone                                                                       | **yes** | `config.*` literals no longer match the file  |
| bump a default inside `src/` alone                                                                        | **yes** | `config.*` literal no longer matches the file |
| **bump the derivation in `src/` _and_ `contract-versions.json`, leave `server` and `package.json` alone** | **NO**  | see below                                     |

The fourth case is the one the file exists to prevent. Executed against the test's own four
assertions:

```
Hypothetical: parser 1.7.3 -> 1.7.4 in both places, server left at 0.5.3
   PASS VERSIONS.server === PACKAGE.version
   PASS config.parserVersion === VERSIONS.parser
   PASS config.extractorVersion === VERSIONS.extractor
   PASS config.version === VERSIONS.server
  => test result: PASSES (a parser bump ships under an unchanged server version)
```

### Why: the test is a fixed-point check, not a motion check

The test proves _the three current constants agree with each other_. It has no baseline —
nothing in the repo compares the current triple against the previous one, and nothing reads
git history. The test's own name asserts something it cannot do:

> `it("moves the server version whenever a derivation version moves", ...)`
> — `tests/contract.test.ts:25`

and the file's own claim is:

> "so a parser or extractor bump cannot ship under an unchanged server version"
> — `contract-versions.json:9`

Both are false. The historical incident the comment cites is real (`fbdbd3c` moved the parser
`1.5.0 -> 1.6.0` while `package.json` stayed `0.2.0`), and the fix did raise `server` to
`0.3.0` at `72eb373`. But nothing enforces it now: a two-file edit defeats the guard
completely.

### The other direction: what the test does not reach at all

**Derivation change with no version edit whatsoever.** The test has no access to code, so it
cannot notice that `src/analysis/normative.ts` changed. This is not hypothetical — it is
exactly what the working tree does (section 3).

**`contract-versions.json` is not shipped.** `package.json` `files: ["dist","README.md","LICENSE"]`.
The file the whole enforcement story rests on is dev-only. An installed client cannot read
the triple; `capabilities` reports only `server: {name, version}` (`src/service/rfcService.ts:2477`)
and the envelope's `provenance` reports the _snapshot's_ versions, not the running build's.

**A fourth copy of the triple, unowned.** `tests/citation-stability.test.ts:217-218`
hard-codes `parserVersion: "rfc-text-1.7.3"` / `extractorVersion: "normative-2119-8174-1.6.3"`
as literals. It is not compared to `contract-versions.json` by anything, so it will go stale
silently on the next bump and the test will keep asserting the old value into a stored column.

### Ways the triple becomes inconsistent while every test still passes

1. Bump `parser`/`extractor` in `src/core/config.ts` **and** `contract-versions.json`; leave
   `server`/`package.json`. All four assertions pass. _(demonstrated above)_
2. Change derivation code in `src/analysis/normative.ts` or `src/store/database.ts` and touch
   no version anywhere. Nothing can fail. _(this working tree)_
3. Bump `server` in `contract-versions.json` and `package.json` without any derivation change
   (pure release bump). Passes — the test cannot tell a release bump from a derivation bump,
   so it also never _forces_ the bump that matters.
4. A `SCHEMA_VERSION` bump with no triple change: `tests/store.test.ts:171` pins
   `SCHEMA_VERSION === "8"` in a test, and `tests/contract.test.ts` never looks at it. The
   two version systems are disjoint and no assertion spans them.
5. Point `package.json`'s `name` away from `rfc-mcp` so `readPackageVersion()`
   (`src/core/config.ts:150-167`) falls through to `"0.0.0"`. The test would catch it — this
   is the one case the config fallback cannot hide.

---

## 2. Schema version vs derivation version

`SCHEMA_VERSION` is 8. Migration 8 (`src/store/schema.ts:43-64`) adds
`requirements.stable_citation_id` and `mentions.stable_citation_id`, both
`TEXT NOT NULL DEFAULT ''`, and no backfill.

### The migration itself is honest

The comment at `src/store/schema.ts:51-58` and the test at `tests/store.test.ts:114-141`
agree: `""` means "never minted", the value cannot be recovered from the row (the section
_number_ is not on a requirement row), and `reanalyze --all` is the only honest repair.
`tests/store.test.ts:171` also pins `SCHEMA_VERSION === "8"` and that migration 8 has
`backfills === []`. Those claims check out.

### The client-facing consequence is not signalled anywhere

Trace the scenario: a client with a corpus written at schema 7 by build 0.5.3 starts 0.5.4.

1. `new CorpusStore()` runs `SCHEMA_SQL` then `applyMigrations()` then
   `setMeta("schema_version", "8")` (`src/store/database.ts:94-98`).
   Migration 8 adds the two columns. Every existing row reads `''`.
2. `schema_version` is **written and never read.** `grep -rn "getMeta\|schema_version" src/`
   returns `setMeta("schema_version", ...)` at `database.ts:97` and nothing else. No tool
   response, no `IndexStatus` field, no warning carries it.
3. `rfc_resolve` on an already-ingested RFC hits the cache short-circuit
   (`src/service/rfcService.ts:493` `hasSnapshotContent(...)` → `return { freshness: "cached" }`).
   It does not re-derive, does not warn, and returns the same `snp_…` id.
4. `requirements` returns every row with `stable_citation_id: ""`
   (`src/store/database.ts:1932-1937` passes `row.stable_citation_id` straight through).
5. The client cannot obtain a `scit_` id from anywhere, because every row it is handed is
   blank.

So the two states the audit asks about are not merely similar — on an un-rederived corpus
"never minted" is the _only_ reachable state, and a row that genuinely has no id is
distinguishable from it only by a fact the client cannot observe.

### `reanalyze --all`, the documented remedy, is a no-op on this release

`src/service/rfcService.ts:2807-2809`:

```ts
if (snapshotId === previous.id) {
  return { rfc, from: previous.id, to: previous.id, changed: false };
}
```

`snapshotId` is hashed from `(rfc, format, raw_sha256, metadata_hash, parserVersion,
extractorVersion)` (`rfcService.ts:2789-2791`). The triple did not move, so this hash is
**identical** to the stored id, so `reanalyze` returns early — before `parseRfcText`,
before `analyzeNormative`, before `commitDocument`. It prints `unchanged` for all 159
documents. The migration-8 columns stay `''` permanently, and the requirement rows keep
coming from the previous extractor.

The CHANGELOG's own reasoning ("A version bump requires `reanalyze --all` anyway",
`CHANGELOG.md:87-88`; `src/store/schema.ts:55-57`) is a conditional whose antecedent did not
fire. The remedy is gated on the very signal that was not sent.

### The one field that would have said so is hard-coded

`src/service/rfcService.ts:2459` — `documents.stale` is the literal `0` in the `status`
response (declared in `IndexStatus`, `src/core/types.ts:785`). It is pre-existing, not from
this round, but it is now the field that should be carrying "this corpus predates the
current derivation" and it can never fire. `status` does report `parser_versions` /
`extractor_versions` from the snapshots table (`database.ts:1551-1552`) — and because the
triple did not move, those equal the running build's values. A client diffing them concludes
the corpus is current.

### The `stale`/`verified` verdict degrades silently on the same corpus

`verifyStableCitation` (`src/service/rfcService.ts:2205-2240`) computes
`origins = this.store.stableCitationOrigins(stableId)` and `mintedIn` from it. On an
un-rederived corpus `stableCitationOrigins` filters `stable_citation_id != ''`
(`src/store/database.ts:1163-1165`), so `mintedIn` is `[]` and the verdict for an id that
_is_ in the pinned snapshot's text is `stale`, not `verified`. The only evidence that the
cause is "the corpus is un-rederived" is a prose `notes[]` string
(`rfcService.ts:2233-2236`) — not a field, not a warning, not in `provenance`. And as shown
in step 5, a client on that corpus cannot hold a `scit_` id to verify, so the note is
effectively unreachable.

### The distinguishing state the feature was built for is architecturally unreachable

`stableCitationOrigins`'s own comment (`src/store/database.ts:1157-1158`) says:

> "A parser bump deletes the snapshot it retired, so the row is the ONLY trace left"

The row is not left. `commitDocument` runs, at `src/store/database.ts:529`:

```sql
DELETE FROM snapshots WHERE rfc = ?
```

before inserting the new snapshot, and `sections`/`blocks`/`mentions`/`requirements` are all
`ON DELETE CASCADE` (`src/store/schema.ts:307, 342`). So a re-derivation of any document
destroys the previous derivation's `mentions` and `requirements` rows outright.
`snapshot_redirects` records `old_id -> new_id` but stores no derived rows.

Consequence: `mintedIn` can only ever be `[the currently pinned snapshot]` or `[]`. The
`stale`-with-a-named-minting-snapshot branch (`rfcService.ts:2224-2231`, whose text reads
_"it was minted in ${mintedIn.join(", ")} … which is what a parser bump produces"_) cannot
fire. The changelog presents that branch as the feature's value ("answers `stale` … against a
snapshot other than the one that minted it"). It is dead.

---

## 3. Uncommitted work and version state

`git diff --stat`:

```
 CHANGELOG.md                         |  103 +++
 eval/README.md                       |   43 +-
 eval/corpus.json                     | 1182 ++++++++++++++-----
 eval/lib/labelling.mjs               |   56 +-
 eval/results/before-miss-review.json |   57 +-
 eval/run-bench.mjs                   |   74 ++-
 src/analysis/citation.ts             |   82 +++
 src/analysis/normative.ts            |  816 +++++++++++++++++++++++-
 src/core/types.ts                    |  106 +++
 src/mcp/tools.ts                     |    4 +-
 src/service/rfcService.ts            |  480 +++++++++++++-
 src/store/database.ts                |   85 ++-
 src/store/schema.ts                  |   41 +-
 tests/{normative,protocol,service,store,text-parser}.test.ts | 760 ++++++++
```

### Does the working tree change what a client reads? Yes, in four places.

**`requirements` — yes, and the stored derivation moves.**
`src/analysis/normative.ts` changes three things inside the _stored_ path
(`analyzeNormative`, which produces the rows written by `commitDocument`):

| what                                                           | line                     | stored fields it moves                                                                                                                      |
| -------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SENTENCE_BOUNDARY` rebuilt with `SENTENCE_CLOSERS`            | `normative.ts:117-121`   | sentence boundaries → `exact_text`, `span.*`, `keywords_json[].char_*`, `context`, and the `req_…` row id (which is `citationId(sentence)`) |
| `endsWithAbbreviation` + new `isAnInitial`/`TRAILING_ELLIPSIS` | `normative.ts:1869-1925` | the abbreviation veto → same fields                                                                                                         |
| `LIST_MARKER` gains `[ \t]*`, `o`, `+`, `‣`, `·`, `\d{1,3}`    | `normative.ts:1987`      | `clause.actor` / `clause.condition` on list-item blocks                                                                                     |

`splitSentences` is called at `normative.ts:1120` inside `analyzeNormative` — the stored
path — so the boundary change reaches `mentions` and `requirements` rows directly. The
remaining extractor changes (`classifyRequirementShape` gaining `placement`, the new
`ModalContext`/lexicons, `analyzeDeclarativeSpecifications`) are reached only from
`analyzeNormativeCandidates` at `normative.ts:1435`, which is derived on demand and not
stored.

Demonstrated on the example the code's own comment cites:

```
text: '(Note that this example might change in the future.) Note that the term "public
       suffix" is controversial …'
OLD boundaries: []                              -> one sentence
NEW boundaries: [[50, ".) "]]                  -> two sentences
```

`git diff -U0 src/analysis/normative.ts | grep '^@@'` confirms the hunks: the stored path is
touched at `@@ -100 +117,5 @@`, `@@ -122,0 +144,22 @@`, `@@ -1144 +1870,5 @@`,
`@@ -1147,2 +1877,61 @@`, `@@ -1192,0 +1982,6 @@`. Everything else is candidate-path.

**`verify_citation` — yes.** New `scit_` branch, new `citation_id_kind` and `minted_in`
fields, and `sectionSentences` (`rfcService.ts:2029-2053`) re-runs `splitSentences` on
_stored block text at query time_ with the _current_ code. See below.

**`capabilities` — yes.** Gains `parse_notes` (`rfcService.ts:2544`; `git grep parse_notes
HEAD -- src/` → no hits, so it is new), plus new `reading_rules` / `limit_notes` prose.

**`read` — data unchanged, prose changed.** `page_furniture_lines` and `text_fidelity` both
exist at `HEAD` (`git grep -c page_furniture_lines HEAD -- src/` → types.ts 1, text.ts 1,
rfcService.ts 1). Only the `text_fidelity` sentence gained a clause
(`rfcService.ts:963-964`) and the `read` tool description was reworded (`tools.ts:172`).

### Would this alter offsets without the version moving? Yes.

`extractorVersion` is `"normative-2119-8174-1.6.3"`. It is one of the six inputs to the
snapshot id (`rfcService.ts:488-491`, mirrored at `2789-2791`):

```ts
const snapshotId = `snp_${shortHash(
  `rfc${rfc}|txt|${rawSha256}|${metadataHash}|${this.config.parserVersion}|${this.config.extractorVersion}`,
)}`;
```

The sentence splitter moved. The extractor version did not. So **one `snp_…` id now names
two different derivations**: the rows `analyzeNormative` wrote before this working tree, and
the rows the same code path writes now. The `req_…` row ids differ (they are
`citationId(snapshotId, blockId, sentenceByteStart, sentenceQuote)`), the `exact_text`
differs, the offsets differ, and `parse_status` / `confidence` can differ.

The corpus inventory proves the collision is live. `eval/corpus.json` was regenerated this
round and now records, for every document:

```json
"pv": "rfc-text-1.7.3",
"ev": "normative-2119-8174-1.6.3",
```

151 documents had `ev: normative-2119-8174-1.5.0`; all 151 moved to `1.6.3` at `a48fa2c`; 8
new documents were added (159 total). The recorded `ev` is _identical_ to what the changed
code will report for a derivation that has not happened yet. `pb` moved on 145 documents and
`req` on 95 (10110 → 10618 summed) as a result of the _previous_ extractor bump — under a
triple that had moved. This round changes the extractor again under the same `ev`.

And the corpus cannot be repaired even if someone notices: `reanalyze --all` short-circuits
(section 2), and `resolve` short-circuits on `hasSnapshotContent`. The two derivations will
coexist under one id indefinitely, and there is no code path that can separate them.

### The stable id does not survive this round either

`scit_` is `stableCitationId({rfc, sectionNumber, quote, occurrence})`
(`src/analysis/citation.ts:76-86`), minted at write from the requirement row's `exact_text`
(`src/store/database.ts:1730-1742`). The `quote` is a _split sentence_. This round changes
the splitter.

So an id minted by 0.5.3 hashes a merged two-statement "sentence". At the new build:

- `verifyStableCitation` re-splits the same stored block with the **new** `splitSentences`
  (`rfcService.ts:2035-2036`) and looks for that merged text. It is no longer a sentence.
- Verdict: `not_found`, with the note _"no sentence in RFC N section M reproduces this id"_
  (`rfcService.ts:2143-2150`).

That is against the very snapshot that minted it, and it is precisely the outcome the
changelog says the id was built to end: _"every citation written against them came back
`not_found` with nothing in the response to say what the text had been"_
(`src/core/types.ts:270-274`). The release instructs clients to run `reanalyze --all`; the
re-derive retires the `scit_` ids the same release told them to start using.

Residual, independent of this round: the id's stability rests on the section-_number_ string
being byte-identical across derivations. For typeset documents that string is the heading
text (`src/parse/text.ts:593` `Appendix ${…}`, `:614/:625` `number: trimmed`), so any
heading-title normalisation in a future parser bump retires every `scit_` for that document
while leaving the advertised "survives a re-derivation" property unchallenged.

---

## 4. CHANGELOG as a contract

Scope: the `### Fixed, third pass` (lines 8-67) and `### Added, third pass` (68-109)
sections, read against the working tree.

### The four fixes in "Fixed, third pass" that are not fixed

The section header is `Fixed`. Its intro says _"Six reported strict misses were diagnosed
against the current build before anything was changed"_. Six bullets follow. Four describe
work that is **not present**; two are present. There is no marker distinguishing them.

| bullet                                                                                                                                                                                                        | claim | verdict       | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A sentence cut by a page break was emitted as a complete requirement"                                                                                                                                        | fixed | **NOT FIXED** | `analyzeNormative` still does `for (const sentence of splitSentences(block.text))` at `normative.ts:1120` with no continuation join. `parseStatus = hasActor && hasAction ? "complete" : "partial"` at `:1233`; `Requirement["parse_status"]` is still `"complete" \| "partial" \| "heuristic"` (`types.ts:321`) — there is no `fragment`. `continues_previous_block` exists only on `NormativeCandidate` (`types.ts:371`) and is set only at `normative.ts:1476`, in the candidate path. |
| "`non_strict_candidates` was not a safety net for a strict miss, by construction"                                                                                                                             | fixed | **NOT FIXED** | The drop is still there: `normative.ts:1432-1434`, `.filter((entry) => entry.keyword_case !== "upper" \|\| reason !== null)`, under the comment _"The strict extractor already owns every upper-case keyword in a prose block"_.                                                                                                                                                                                                                                                          |
| "Body prose that opens with a bracketed tag was typed as a bibliography entry … Quoted material is now surfaced as quoted rather than promoted silently, and the fix reports how many blocks it reclassified" | fixed | **NOT FIXED** | `git diff --stat src/parse/` is **empty**. `classifyBlock` at `src/parse/text.ts:823-827` still returns `reference_entry` for any block opening `[tag] `. No `quoted` block kind exists. `grep -rn reclassif src/` → **no hits**.                                                                                                                                                                                                                                                         |
| "`coverage.keyword_bearing_blocks_skipped` was case-sensitive … One predicate, one case semantics, and the counter is the union of what both passes skip"                                                     | fixed | **NOT FIXED** | `TERM_PROBE = new RegExp(TERM_PATTERN.source, "u")` at `normative.ts:74` — no `i` flag. Its one call site is `normative.ts:1115`, inside the strict-pass block loop only. The candidate pass selects with `lower(text) LIKE '%must%'` (`src/store/database.ts:1191-1193`), which _is_ case-folding. The counter is still the strict pass's view.                                                                                                                                          |

A fifth defect, **Y5** in `eval/results/pending-fixes.md:234-247` ("`read` and
`requirements` disagree about the same sentence"), is not mentioned in the CHANGELOG at
all, in either state.

For the fourth bullet the _diagnosis_ is also wrong on its own terms. `TERM_PATTERN` is built
from `NORMATIVE_TERMS` (`src/core/types.ts:224-236`), whose keys are **upper-case literals**.
A case-sensitive pattern over an upper-case-only vocabulary is not a case-sensitivity
accident; the divergence is a deliberate strict vocabulary against an intentionally
case-folding `LIKE` prefilter. The measured consequence in `pending-fixes.md:224-229` is real
(two body blocks carrying only lower-case modals are invisible to the counter and to the
`normative_text_in_unscanned_blocks` warning), but "one predicate, one case semantics" is
not the mechanism. There is a second, unmentioned duplication: the value the client actually
reads is `snapshot.keyword_bearing_unscanned_block_count` (`rfcService.ts:1352`), written at
derivation time by a **third** expression of the predicate —
`NORMATIVE_KEYWORD_PROBE` at `src/store/database.ts:1710-1711`. So even a fix in the
extractor's `TERM_PROBE` would not change the reported number without a re-derive.

### The two fixes in "Fixed, third pass" that are present

- "A page of `requirements` re-shipped the whole candidate list" — implemented at
  `rfcService.ts:1509-1533` (`omitted_on_page`), with the warning
  `non_strict_candidate_rows_omitted_on_page_N` at `:1540` and the provisional counterpart at
  `:1556-1563`. Two defects inside it:
  - "Page 1 is unchanged" is **inaccurate**: page 1 gains `omitted_on_page: 0`
    (`rfcService.ts:1516`), a field that did not exist at `HEAD` (`git show HEAD:src/service/rfcService.ts | grep omitted_on_page` → no hits).
  - `coverage.provisional_omitted_on_page` is set whenever `include_provisional && page >= 2`,
    **unguarded by whether anything was omitted** (`rfcService.ts:1555-1562`). A document with
    zero candidates on page 2 sets `provisional_returned: 0` _and_
    `provisional_omitted_on_page: 2`. The candidate-list warning two lines up _is_ guarded
    (`page > 1 && whole.length > 0`, `:1539`), so the two omission signals in the same
    response disagree about what "omitted" means.
- "Two reported misses were not misses" — `eval/results/before-miss-review.json` is updated:
  G0040/G0041/G0058 move to `verdict: "resolved"`, and a `by_verdict` block is added whose
  `tool_defect` drops 11 → 8. The `totals` block keeps the BEFORE numbers and says so. This
  claim checks out.

### "The bench's section reach is now guarded by an invariant instead of by 100 rules"

Three separate problems with one entry.

1. **It is not a guard.** `eval/run-bench.mjs:551` is `process.exit(0)`, unconditional. The
   new block at `:534-548` only `console.log`s. A regression that reintroduces dangling
   headings produces a green exit code and a passing `npm run verify`.
2. **The detector was loosened in the same round, and the CHANGELOG does not say so.**
   `eval/lib/labelling.mjs` gains two new suppressions in `danglingHeadings`:
   `KEYWORD_LEAD.test(m[2])` and `continuesAtSameIndent(lines, i)`. The instrument that
   reported **63** is not the instrument that reports **0**. `eval/README.md:88-93` _does_
   disclose this ("two false-positive classes that the original did not"); the CHANGELOG
   attributes the whole 63 → 0 to the corpus being fixed. How much of the 63 the parser
   closed and how much the looser detector absorbed is unmeasured and unstated.
3. **The number is right but the scope is narrower than the entry implies.** `golden.json`
   still records `dangling_headings` for 100 protocols, 4 non-empty, **63 total** — the
   entry's "recorded value is 63" is exactly right. But the live check reads only
   `p.sections_used` (2-3 sections per protocol, e.g. RFC 959 → `["5","3"]`,
   `golden.json:64-68`), so "95 protocols, 0 with dangling" is measured over ~240 sampled
   sections, and 95 not 100 because 5 protocols failed to fetch. `eval/build-golden.mjs:212`
   — the generator of the very field the entry calls stale — is unchanged and now imports the
   looser detector, so a regenerated `golden.json` will also record 0 for the same mixed
   reason.

The new `eval/lib/labelling.test.mjs` is well-built (8 cases, both directions pinned) but
**the project's test command will not run it**: it imports `describe`/`it` from `node:test`,
while `package.json` `test` is `vitest run` and no script invokes `node --test`. Vitest's
default include (`**/*.{test,spec}.?(c|m)[jt]s?(x)`, `eval/` not excluded) collects the file,
so it is at best a no-op suite inside `npm test` and at worst a collection failure. Either
way the new invariant's test is not part of `npm run verify`.

### "Added, third pass" — checked

| claim                                                                                                                                                                                                             | verdict                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stable_citation_id` / `scit_` exists, store computes it on write, `verify_citation` accepts it and answers `stale` not `verified`, `ambiguous` reachable, `codepoint_*` are 0                                    | **present as described** — `citation.ts:37-104`, `database.ts:1729-1742`, `rfcService.ts:2070-2240`. But see section 2/3: the `stale`-with-named-minting-snapshot branch is unreachable (`DELETE FROM snapshots WHERE rfc = ?`), and the id does not survive this round's own splitter change. |
| "Migration 8, with no backfill … an index created by the migration and deliberately not by `SCHEMA_SQL`"                                                                                                          | **TRUE** — `schema.ts:43-64`; asserted at `tests/store.test.ts:163-176`.                                                                                                                                                                                                                       |
| "`capabilities` now names `page_furniture_lines`, the two loss counters, both citation id kinds and the paging rule. `read`'s `text_fidelity` names the same field, and the `read` tool description names it too" | **TRUE** — `rfcService.ts:962-964`, `:2538`, `:2540-2541`, `:2567`, `:2569`; `tools.ts:172`, `:288-289`. Asserted at `tests/protocol.test.ts:157-173`.                                                                                                                                         |
| "`parse_notes`: a document's reach can depend on how it was typeset … both counts are reported per snapshot in `warnings`"                                                                                        | **TRUE** — `rfcService.ts:2544`; the warnings are `indented_subsection_headings_recognised` / `underlined_headings_recognised`, emitted from the parser (`src/parse/text.ts`). Asserted at `tests/protocol.test.ts:175-190`.                                                                   |
| "`eval/golden-ext.json` … reports recall and nothing else, and `comparable_with_main_bench` is `false` … Precision is deliberately absent"                                                                        | **TRUE** — `golden-ext.json` `$meta.comparable_with_main_bench: false`, 63 protocols / 160 rules, and `grep -i precision` over the file returns 0.                                                                                                                                             |
| "Five of the 100 protocols produced zero rules"                                                                                                                                                                   | **TRUE** — `previously_unsampleable: [768, 792, 2052, 8448, 9650]`.                                                                                                                                                                                                                            |

### The claim not in the file, and the claim that is not where it is

**"`dist/` staleness aside the parser is byte-identical this round."** Not in `CHANGELOG.md`
anywhere. The underlying facts are both true and jointly misleading:

- `git diff --stat src/parse/` is empty — the parser is byte-identical. TRUE.
- `dist/` is a build of `HEAD`'s `src`: `dist/store/schema.js:12` has
  `SCHEMA_VERSION = "7"`, `grep -c SENTENCE_CLOSERS dist/analysis/normative.js` → 0,
  `grep -c stableCitationId dist/analysis/citation.js` → 0. So the whole round is absent
  from the built artifact, and `npm start` / `npm run inspect` run the _old_ build.

Naming the parser as the unchanged file while the file that determines the offsets of every
stored requirement (`normative.ts`) changed by 796 lines is the shape of claim this audit
exists to catch.

**`declarative_specifications` is shipped and announced nowhere.** `analyzeDeclarativeSpecifications`
(`normative.ts:1680-1820`, ~140 lines plus `DECLARATIVE_BASES` at `:1616-1636` and
`MAX_DECLARATIVE_SPECIFICATIONS = 200` at `:1614`) is a new keyword-free channel with three
published tests, a cap, and its own warnings. It is required on the public
`NormativeCandidateAnalysis` type (`types.ts:482-485`). It is:

- **absent from `CHANGELOG.md`** (`grep -i declarative CHANGELOG.md` → 0 hits);
- **absent from `capabilities`** (`grep -n declarative src/service/rfcService.ts` → 0 hits —
  the rows are computed on every candidate request and thrown away; `candidateTotals`
  at `rfcService.ts:1476-1500` has no `declarative_*` key);
- **but its warnings do reach the client.** `warningsOut.push(...analysis.warnings.map(w => "candidates:" + w))`
  at `rfcService.ts:1534`. So every `requirements` call that asks for candidates can now
  carry nine new, undocumented warning strings: `candidates:declarative_blocks_out_of_scope:N`,
  `_definition_section`, `_list_item`, `_fixed_boilerplate`, `_page_break_fragment`,
  `_caption_or_figure_label`, `_cross_reference`, `_bibliography_entry`
  (`normative.ts:1711-1725`) and `candidates:declarative_specifications_truncated_at_200`
  (`:1806`).

The project's own stated position on new warnings is at `CHANGELOG.md:168-170`:
_"A caller that treats warnings as fatal will see it on documents that were previously
silent."_ Nine such warnings arrive with no entry.

---

## 5. What a client upgrading would break on

`CONTRACT_VERSION` is `"ietf-rfc/1"` and has never moved, so the envelope's own
`contract` field is not a signal for any of the below. `data` is
`z.record(z.string(), z.unknown())` (`tools.ts:54`), so additive fields cannot break a
schema-validating client. The breakage is all in the _values_ and in the _omissions_.

| change                                                                                              | a reasonable client breaks?                                                                                                                                                                                                                                                                                                                                        | does the release say so?                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema 8 → `stable_citation_id: ""` on every row until re-derive, and re-derive is a no-op** (§2) | **yes, silently.** A compliance-list builder that records `stable_citation_id` per requirement writes an empty string for every obligation and has no field telling it to re-derive. The documented remedy (`reanalyze --all`) prints `unchanged` and does nothing.                                                                                                | **no.** The `Added` entry says only _"A version bump requires `reanalyze --all` anyway"_ — a conditional whose antecedent did not fire. No version bump, no instruction, no warning.                                                           |
| **`scit_` is minted from a sentence segmentation this release changes** (§3)                        | **yes.** An id recorded from 0.5.3 output returns `not_found` against its own snapshot after upgrade.                                                                                                                                                                                                                                                              | **no.** The entry's headline is _"a citation that survives a re-parse"_. The release ships the re-parse that breaks it.                                                                                                                        |
| **`non_strict_candidates` empty on page ≥ 2** (`rfcService.ts:1521-1531`)                           | **yes, for union-style callers.** A client that pages `requirements` and unions `requirements[]` with `non_strict_candidates.candidates[]` now loses every candidate row after page 1. It is _distinguishable_ (`omitted_on_page: n`, `note`, and the `non_strict_candidate_rows_omitted_on_page_N` warning), so a careful client is fine. An existing one is not. | partially: in `Fixed, third pass`, framed as a fix. It is **not** in a `Changed (breaking)` section — the release has none for this round, though `Changed (breaking), second pass` exists at `CHANGELOG.md:158` and is the established place. |
| **`include_provisional` rows omitted on page ≥ 2** (`rfcService.ts:1546-1563`)                      | **yes.** `coverage.provisional_returned` changes from `N` to `0` on every page ≥ 2 — a _number_ that previously described the document now describes the page. `provisional_omitted_on_page` is the new disambiguator, but it is also set when `N == 0`, i.e. when nothing was omitted.                                                                            | partially, in the same `Fixed` bullet. The false "omitted" case is not mentioned.                                                                                                                                                              |
| **`coverage` gains fields** — `provisional_omitted_on_page`; the new `declarative_*` never arrive   | **no** for the fields that land (`data` is a loose record; `coverage` is cast to `Record<string, unknown>` at `rfcService.ts:1555`).                                                                                                                                                                                                                               | the `coverage` additions are not in a `Changed` section.                                                                                                                                                                                       |
| **`capabilities` gains `parse_notes`, new `reading_rules`, new `limit_notes`**                      | **no**, additive strings.                                                                                                                                                                                                                                                                                                                                          | `Added, third pass` covers `parse_notes`; the rules/notes text changes are not enumerated.                                                                                                                                                     |
| **`text_fidelity` wording change** (`rfcService.ts:963-964`)                                        | **no** unless a client string-matches the sentence. It is prose, not a value.                                                                                                                                                                                                                                                                                      | yes, in `Added, third pass`.                                                                                                                                                                                                                   |
| **`verify_citation` gains `citation_id_kind` and `minted_in`; `scit_` requires `section`**          | **no** for existing `cit_` callers (both fields additive; `scit_` did not exist before).                                                                                                                                                                                                                                                                           | yes, in `Added, third pass` and in the tool description.                                                                                                                                                                                       |
| **new `candidates:declarative_*` warnings** (§4)                                                    | **yes, for the client class the project names explicitly** — one that treats unknown warnings as fatal. It will start failing on documents that were silent.                                                                                                                                                                                                       | **no.** Nine warning strings, zero CHANGELOG mentions, no `capabilities` entry.                                                                                                                                                                |
| **extractor output changes under an unchanged `ev`, so one `snp_…` names two derivations** (§3)     | **yes, and this is the worst case.** Two clients can hold the same `snapshot_id` and receive different `requirements` rows, different `exact_text`, different `req_…` ids and different offsets from the same server version.                                                                                                                                      | **no.** No entry, no version bump, no warning, and no code path that can detect or repair it (`reanalyze --all` short-circuits).                                                                                                               |
| **`golden.json` `dangling_headings` still records 63 while the bench says 0**                       | **no** (eval-only). But a reader of the eval artifacts is told two different things about the same field, and the detector changed in between.                                                                                                                                                                                                                     | the CHANGELOG says the file is stale; it does not say the detector changed. `eval/README.md` does.                                                                                                                                             |

---

## Ranked table

Ordered by consequence. "Ships undetected" = nothing in `npm run verify` (tsc + vitest +
build) fails, and nothing on any client-visible surface reports it.

| #   | risk                                                                                                                                                                                                                                                                                                                  | can it ship undetected?                                                                                                          | consequence                                                                                                                                                                                                                                                                                                            | evidence                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Extractor output changed (`SENTENCE_BOUNDARY`, abbreviation veto, `LIST_MARKER`) with `extractorVersion` frozen at `1.6.3`. One `snp_…` id names two derivations.**                                                                                                                                                 | **yes** — `tsc` clean, all tests green, the only guard is an equality among three constants that all moved together in _no_ file | every stored `requirements`/`mentions` row, `exact_text`, offset, `req_…` id and `clause.*` becomes ambiguous under an unchanged snapshot id; `verify_citation` on a `cit_` id can resolve to different text for the same id; `reanalyze --all` cannot separate them because it short-circuits on an unchanged id hash | `normative.ts:117-121, 1869-1925, 1987` vs `:1120`; `rfcService.ts:488-491`; `eval/corpus.json` records `ev: 1.6.3` for all 159 docs; `rfcService.ts:2807-2809`                                          |
| 2   | **The `contract-versions.json` coupling is a fixed-point check, not a motion check. A derivation bump in two files with an unchanged `server` passes all four assertions.** The file's own claim ("a parser or extractor bump cannot ship under an unchanged server version") and the test's own name are both false. | **yes** — demonstrated by evaluating the test's four assertions against that scenario                                            | the guard the project added specifically because the coupling "was promised once and not kept" does not keep it; the next silent bump is indistinguishable from this one                                                                                                                                               | `tests/contract.test.ts:25-32`; `config.ts:143-144`; `contract-versions.json:9`                                                                                                                          |
| 3   | **Migration 8's columns are permanently `''` on every existing document, and the documented remedy `reanalyze --all` is a no-op because the version did not move.** No field reports `schema_version`; `documents.stale` is hard-coded `0`.                                                                           | **yes**                                                                                                                          | every client that records `stable_citation_id` stores `""` for every obligation, with no way to learn a re-derive is needed or that the documented re-derive does nothing                                                                                                                                              | `schema.ts:43-64`; `database.ts:94-98, 529, 1163-1165`; `rfcService.ts:493, 2807-2809`; `rfcService.ts:2459`; `types.ts:785`                                                                             |
| 4   | **`scit_` does not survive this release.** The id hashes a split sentence; the release changes the splitter; `verifyStableCitation` re-splits at query time with the new code, so a 0.5.3-minted id returns `not_found` against its own snapshot.                                                                     | **yes**                                                                                                                          | the release's headline feature is falsified by the release; the `stale`-with-named-minting-snapshot branch is unreachable anyway because `commitDocument` cascades away the old rows                                                                                                                                   | `citation.ts:76-86`; `database.ts:1729-1742`; `rfcService.ts:2035-2036, 2143-2150`; `database.ts:529`; `rfcService.ts:2224-2231`                                                                         |
| 5   | **Four of six bullets in `### Fixed, third pass` describe work that is not present** (page-break fragments, candidate safety net, bracketed-tag blocks, `keyword_bearing_blocks_skipped`).                                                                                                                            | **yes** — `tests/store.test.ts` even asserts the _unfixed_ `""` behaviour as correct                                             | a reader trusting the changelog believes four measured recall defects are closed; 274 unflagged fragment rows and 184 dropped body blocks are still live                                                                                                                                                               | `normative.ts:74, 1115, 1120, 1233, 1432-1434, 1476`; `types.ts:321, 371`; `text.ts:823-827`; `git diff --stat src/parse/` empty; `grep -rn reclassif src/` empty                                        |
| 6   | **Nine new `candidates:declarative_*` warning strings reach the client, documented nowhere**, from ~140 lines of unannounced extractor code whose rows are never surfaced.                                                                                                                                            | **yes**                                                                                                                          | a client that treats unknown warnings as fatal — the class the changelog names at line 168-170 — starts failing on previously-silent documents                                                                                                                                                                         | `normative.ts:1614-1636, 1680-1820`; `rfcService.ts:1534`; `grep -i declarative CHANGELOG.md` → 0; `grep -n declarative src/service/rfcService.ts` → 0                                                   |
| 7   | **`non_strict_candidates` and `include_provisional` rows vanish on page ≥ 2 with no `Changed (breaking)` entry**, and `coverage.provisional_omitted_on_page` is set even when nothing was omitted. `provisional_returned` changes from `N` to `0`.                                                                    | **yes**                                                                                                                          | a union-style caller silently loses every candidate and provisional row after page 1; `provisional_omitted_on_page` is a false signal in the zero case                                                                                                                                                                 | `rfcService.ts:1509-1563`; `git show HEAD:src/service/rfcService.ts \| grep provisional_returned` → unconditional; no `Changed (breaking), third pass` section exists                                    |
| 8   | **The "invariant" guarding outline reach is a `console.log` behind an unconditional `process.exit(0)`, and its detector was loosened in the same round while the CHANGELOG attributes 63 → 0 entirely to the corpus.**                                                                                                | **yes** — green exit either way                                                                                                  | the defect class that produced 63 unreachable sections across 4 documents has no failing test; the 63 → 0 figure is not decomposable                                                                                                                                                                                   | `eval/run-bench.mjs:534-548, 551`; `eval/lib/labelling.mjs:275-292` (`KEYWORD_LEAD`, `continuesAtSameIndent`); `eval/golden.json` 4 protocols / 63 total; `eval/README.md:88-93` vs `CHANGELOG.md:63-66` |
| 9   | **`eval/lib/labelling.test.mjs` uses `node:test`; the project's runner is `vitest run` and no script invokes `node --test`.**                                                                                                                                                                                         | **yes** — and it may break `npm test` rather than being skipped                                                                  | the one new test for the one label-free invariant is not part of `npm run verify`                                                                                                                                                                                                                                      | `eval/lib/labelling.test.mjs:13-16`; `package.json` `test: "vitest run"`, no `node --test` script; vitest default include matches `*.test.mjs` and `eval/` is not excluded                               |
| 10  | **`CONTRACT_VERSION` is `"ietf-rfc/1"` and has never moved** across multiple breaking response changes.                                                                                                                                                                                                               | **yes**                                                                                                                          | the one field a client reads to detect a contract change is inert                                                                                                                                                                                                                                                      | `types.ts:8`; `git log` — unchanged since `f19f1db`                                                                                                                                                      |
| 11  | **`tests/citation-stability.test.ts:217-218` is a fourth, unowned copy of the derivation triple.**                                                                                                                                                                                                                    | **yes**                                                                                                                          | goes stale on the next bump; keeps asserting the old values into a stored column with nothing comparing it to `contract-versions.json`                                                                                                                                                                                 | `grep -rn "1\.7\.3" --exclude-dir=node_modules` → `config.ts`, `dist/`, `contract.test.ts` (via file), `citation-stability.test.ts`, `eval/corpus.json`                                                  |
| 12  | **`contract-versions.json` is not in `package.json` `files`.**                                                                                                                                                                                                                                                        | n/a                                                                                                                              | the file the enforcement story rests on is absent from the published tarball; no runtime code reads it, so an installed client cannot obtain the derivation triple from the package                                                                                                                                    | `package.json` `files: ["dist","README.md","LICENSE"]`; `grep -rn contract-versions` → test + comment + changelog only                                                                                   |
| 13  | **`dist/` is a build of `HEAD`'s `src`, so `npm start` and `npm run inspect` run the pre-round server** while the changelog describes the post-round behaviour.                                                                                                                                                       | **yes** — `dist/` is gitignored, so nothing in the repo notices                                                                  | anyone evaluating the release from the working tree gets 0.5.3 behaviour and 0.5.3 numbers                                                                                                                                                                                                                             | `dist/store/schema.js:12` `SCHEMA_VERSION = "7"`; `grep -c SENTENCE_CLOSERS dist/analysis/normative.js` → 0; `grep -c stableCitationId dist/analysis/citation.js` → 0                                    |
