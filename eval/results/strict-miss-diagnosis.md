# Diagnosis of six reported recall misses

Read-only investigation. Nothing in `src/` was touched; the only artefact of this session is
this file. No database write, no build, no commit.

## What state was measured

| item | value |
| --- | --- |
| corpus | `~/.local/share/rfc-mcp/corpus.sqlite`, `corpus_id rfc-mcp:9a3591827422`, `index_generation 1953` |
| derivation versions | parser `rfc-text-1.7.3`, extractor `normative-2119-8174-1.6.3` |
| latest bench run | `eval/results/after3.json`, `run_at 2026-09-26T07:28:18.686Z` |
| strict pool | `requirements[].exact_text` (bench `run-bench.mjs:168`, tier `strict`) |
| weak pool | `non_strict_candidates.candidates[].exact_text` (`run-bench.mjs:119`, tier `weak`; the bench never reads `non_strict_candidates.fragments`) |
| match rule | whitespace-normalised containment, probe inside emitted text (`run-bench.mjs:156`) |
| golden ids | G0017 (1812), G0058 (3501), G0099 (5155), G0085 (4343), G0229 (9117), G0040+G0041 (2865) |

The first check run for every case was the one the brief asks for: read the golden probe
against what the tool emits **now**, through the same code path a caller uses
(`node dist/cli.js requirements <rfc> --json`, paginated exactly as the bench paginates).
Two of the six are not misses any more. The remaining four are real defects, and in every
one of them the golden probe is a faithful quote of the RFC — proved below from the
document's own text, not from the tool.

**Golden-probe errors found: 0.** The bench builds a probe by splitting the *section's*
`text` on `(?<=[.!?])\s+` and collapsing whitespace (`eval/lib/labelling.mjs:20,117`), i.e.
from `show`'s `text`, which is the reading with page furniture blanked. That is why four
probes are longer than any single row the tool emits: the tool's blocks are cut at page
breaks and blank lines, the section text is not. In all four the extra text is the RFC's
own, so the fix belongs in the tool, not in the probe.

### Provenance of the line numbers cited here

Two different code states are in play, and they must not be confused:

* Every **observation** in this report came from `node dist/cli.js …`. `dist/` was built at
  **12:31:37 local** and the corpus was derived by that build (`parser rfc-text-1.7.3`,
  `extractor normative-2119-8174-1.6.3`, re-derived 12:25–12:31, `last_successful_sync
  07:25:42Z`, which is unchanged by this session — `failures` is still empty, 10 618
  requirement rows, 125 documents).
* Every **line number** is from the working tree `src/`, which has uncommitted changes that
  were being made *while this diagnosis ran* (`src/analysis/normative.ts` mtime 12:52:04,
  `src/service/rfcService.ts` 12:51:46, against a `dist/` built at 12:31:37; `dist/` does not
  contain the working tree's new `scit_` citation prefix). Those edits are in
  `SENTENCE_BOUNDARY` and the abbreviation veto only — they do not touch
  `PROSE_BLOCK_KINDS`, the block gate, the `reference_entry` skips, the upper-case filter, or
  the per-block `splitSentences` call, i.e. none of the mechanisms below. `src/parse/text.ts`
  is unmodified, so its line numbers are exact.
* Line numbers are as of `src/analysis/normative.ts` md5 `ba55815ab188cc7735e6d82e2e0b4d13`,
  `src/service/rfcService.ts` md5 `4770c2df40821d997721958811d96eff` and
  `src/parse/text.ts` md5 `f25fb5985dc47406bf69495cd23fd931` (checked 12:53 local). If a file
  has moved again, grep for the symbol names — they are given alongside every number.

---

## Case 1 — RFC 1812 §4.2.2.2, G0017 (strict, MUST) — MISS

### The sentence as the RFC writes it

> When a router inserts its address into such an option, it MUST use the IP address of the
> logical interface on which the packet is being sent.

`show 1812 --section 4.2.2.2 --json` → `data.text_clean` returns exactly that, with the page
break in the middle as blank lines:

```
   option, it MUST use the IP address of the logical interface on which
<blank lines: the page break>
   the packet is being sent.  Where this rule cannot be obeyed because
```

### The block

| field | value |
| --- | --- |
| block | `blk_0d4ca37f91e8013b34ae310f`, ordinal 0 of `sec_79f2d20e07448b3fc53a9cdf` |
| `blocks.kind` | `paragraph` |
| section | `4.2.2.2` "Addresses in Options: RFC 791 Section 3.1", `sections.kind = body` |
| extent | chars 106510–106790, lines 2347–2350 |
| text | `   Routers are called upon to insert their address into Record Route,\n   Strict Source and Record Route, Loose Source and Record Route, or\n   Timestamp Options.  When a router inserts its address into such an\n   option, it MUST use the IP address of the logical interface on which` |

The next block in the same section, `blk_8ffc30e9fcb83d51896b0dfe` (ordinal 1, `paragraph`,
chars 106944–107850), begins `   the packet is being sent.` The 154-character gap between the
two blocks is the page break; the raw bytes there are the form feed, the running head
`RFC 1812         Requirements for IP Version 4 Routers         June 1995` and
`Baker                       Standards Track                    [Page 42]`.

### What the extractor did

* **Strict: saw it, truncated.** `requirements.req_5d14c156a9b90728`, `exact_text`
  = `"When a router inserts its address into such an\n   option, it MUST use the IP address of the logical interface on which"`,
  span chars 106672–106790, `flags_json = []`, `parse_status = complete`, `confidence = 0.9`,
  `clause = {actor: "it", condition: "When a router inserts its address into such an option", action: "use the IP address of the logical interface on which", exception: null}`.
  The action dangles on a preposition and the condition loses its main clause.
* **Mentions: saw it, same truncation.** `mentions.men_1a6cece284d62cd8`, `disposition = requirement`, `flags_json = []`.
* **Candidates: did not see it, by design.** `normative.ts:1048` (`analyzeNormativeCandidates`) drops every upper-case
  keyword that the strict pass already owns in a prose block (`reason === null`), so the
  truncated half is in no second channel. Verified: 0 candidate rows and 0 `fragments` rows
  in RFC 1812 contain either the head or the tail of the probe.

### Mechanism

A page break ends the block mid-sentence, `groupBlocks` (`src/parse/text.ts:729`, blank/furniture
line at `:733`/`:736`, furniture deliberately emitted as an empty separating line at `:704-708`)
makes that a block boundary, and `splitSentences` (`src/analysis/normative.ts:1146`) is
applied **per block** from `analyzeNormative` (`normative.ts:732`) — so a block boundary is a
sentence boundary, and the strict pass emits the first half as a complete requirement with no
fragment flag. The candidate pass has exactly the missing half of the mechanism
(`previousEndedOpen` at `normative.ts:1109`, `continuesPrevious` at `:995`,
`isFragment` at `:1054`, surfaced as `continues_previous_block`); the strict pass has none of it.

### Fix location

Sentence assembly, not classification: the parser's block boundary (`groupBlocks`,
`src/parse/text.ts:729`) or the splitter (`splitSentences`, `src/analysis/normative.ts:1146`).
The block is already `paragraph` in a `body` section, so no classifier change is involved.
The block classifier is *not* at fault: the continuation at column 3 is correctly a paragraph.

Corpus-wide size of the same defect, measured on the current DB by locating requirement rows
whose block ends mid-sentence (no terminal punctuation, not a colon-terminated list introducer)
and whose next block in the same section opens lower case, then separating the two by whether a
furniture line lies between them:

| class | mid-sentence cut blocks | strict requirement rows sitting in the first half | documents | rows with no flag |
| --- | --- | --- | --- | --- |
| cut at a **page break** (this case) | 825 | **274** | 38 | 220 |
| cut at a **blank line** inside one sentence (case 3) | 2 602 | **19** | 8 | 6 |

Related symptom, same root: **97** strict rows begin lower case and are not list markers
(31 documents) — the "this row is a sentence tail" shape, of which case 3 is one.

---

## Case 2 — RFC 3501 §6.3.2, G0058 (strict, MUST NOT) — **NOT A MISS NOW**

### The sentence as the RFC writes it

> No changes to the permanent state of the mailbox, including per-user state, are permitted;
> in particular, EXAMINE MUST NOT cause messages to lose the \Recent flag.

### The block

| field | value |
| --- | --- |
| block | `blk_0cd858a284fa6c75b98bf286`, ordinal 3 of `sec_964953f6d66ff449c6a81ec3` |
| `blocks.kind` | `paragraph` |
| section | `6.3.2` "EXAMINE Command", `sections.kind = body` |
| extent | chars 76442–76765, lines 1868–1872 |

### What the extractor did — the sentence is emitted, verbatim

```
$ node dist/cli.js requirements 3501 --scope 6.3.2 --json
req_ef57b5b5a4df0dd4 | 6.3.2 | MUST NOT | complete | flags=[]
  "No changes to the permanent state of the mailbox, including\n      per-user state, are permitted; in particular, EXAMINE MUST NOT\n      cause messages to lose the \Recent flag."
```

`requirements.req_ef57b5b5a4df0dd4`, span chars 76590–76765, `flags_json = []`,
`parse_status = complete`, `confidence = 0.9`; `mentions.men_72fab26f096985a8` carries the
same text with `disposition = requirement`. Normalised, the emitted text equals the probe
exactly, so `findIn` (`run-bench.mjs:156`) matches. `after.json`, `after2.json` and
`after3.json` all record G0058 as found; only `before.json` records it as a miss.

### Mechanism

None in the current build. For the record, the historical miss is not re-derivable: the
corpus holds exactly one snapshot per RFC (159 snapshots, 1 per document), all re-derived at
`parser 1.7.3 / extractor 1.6.3`, and the re-derive happened *after* the `before` run
(`before.json` `run_at 05:52:38Z` reports 116 requirements for RFC 3501; the current
derivation reports 233). The pre-round state that produced the miss is no longer on disk, so
any account of it is a guess; what is provable is only that the current derivation returns
the sentence whole. The stale hand-review note in `eval/results/before-miss-review.json`
("Self-contained. Open.") should be closed as resolved, not carried forward.

---

## Case 3 — RFC 5155 §7.2.8, G0099 (strict, MUST) — MISS

### The sentence as the RFC writes it

> If the following conditions are all true: o the QNAME equals the owner name of an existing
> NSEC3 RR, and o no RR types exist at the QNAME, nor at any descendant of QNAME, then the
> response MUST be constructed as a Name Error response (Section 7.2.2).

The RFC prints this as four blank-line-separated blocks (raw text, verified):

```
   If the following conditions are all true:

   o  the QNAME equals the owner name of an existing NSEC3 RR, and

   o  no RR types exist at the QNAME, nor at any descendant of QNAME,

   then the response MUST be constructed as a Name Error response
   (Section 7.2.2).
```

### The blocks

| ordinal | block id | `blocks.kind` | text |
| --- | --- | --- | --- |
| 1 | `blk_3b64cf704c465b55aaff989f` | `paragraph` | `   If the following conditions are all true:` |
| 2 | `blk_f7114639147496e769cc735f` | `paragraph` | `   o  the QNAME equals the owner name of an existing NSEC3 RR, and` |
| 3 | `blk_3fac094a99a05be7e97695ac` | `paragraph` | `   o  no RR types exist at the QNAME, nor at any descendant of QNAME,` |
| 4 | `blk_7d00ce14b5eb1bc74e7bbd05` | `paragraph` | `   then the response MUST be constructed as a Name Error response\n   (Section 7.2.2).  Or, in other words, …` |

All four are in section `7.2.8` "Responding to Queries for NSEC3 Owner Names",
`sections.kind = body`. The `o` bullets are `paragraph`, **not** `list_item`, because
`classifyBlock`'s list test (`src/parse/text.ts:828`) accepts `[-*•]` or `N.`/`(a)` but not a
bare `o` marker — even though `normative.ts:1293` (`LIST_MARKER`) *does* know the bare `o`,
which is why the flag `list_marker_stripped_from_clause` exists and fires elsewhere.

### What the extractor did

* **Strict: saw only the tail.** `requirements.req_824bf964996e52d7`, `exact_text`
  = `"then the response MUST be constructed as a Name Error response\n   (Section 7.2.2)."`,
  span chars 44078–44160, `flags_json = []`, `parse_status = complete`, `confidence = 0.9`,
  `clause = {actor: "then the response", condition: null, action: "be constructed as a Name Error response (Section 7.2.2).", exception: null}`.
  The condition the requirement is conditional on lives in blocks 1–3 and is not reachable
  from this row: `condition` is `null` and the actor is the word "then".
* **Mentions: same tail only.** `mentions.men_4034d3f5c9c6d703`, `disposition = requirement`, `flags_json = []`.
* **Candidates: nothing.** Blocks 1–3 carry no keyword; block 4's upper-case MUST is filtered
  out of the candidate list by `normative.ts:1048`. Verified: 0 candidate and 0 fragment rows
  for RFC 5155 contain the head or the tail of the probe.

### Mechanism

Same root cause as case 1, different trigger: `groupBlocks` (`src/parse/text.ts:729`) ends a
block at every blank line, so a bulleted condition list inside one sentence becomes four
blocks, and `splitSentences` (`normative.ts:1146`, called per block from `analyzeNormative`
at `:732`) treats each block boundary as a sentence boundary — so the sentence keeps only its
last clause. The `o`-marker blindness of `classifyBlock` (`src/parse/text.ts:828`) means the
list items are also mis-typed as prose, but that is not what loses the sentence: reclassifying
them `list_item` would not merge blocks, because the strict pass splits per block regardless
of kind. The hand-review note in `before-miss-review.json` ("the list marker costs it") is
therefore a misattribution; the list marker is not the blocker.

### Fix location

Sentence assembly again — either continuation-joining in `splitSentences`
(`src/analysis/normative.ts:1146`) driven from the block sequence, or not breaking blocks at
blank lines that continue a sentence (`groupBlocks`, `src/parse/text.ts:729`). The `list_item`
test at `src/parse/text.ts:828` is worth widening to the bare `o` for correctness of the
block kinds a caller sees, but it is not sufficient on its own. Verified on the block sequence
of §7.2.8: ordinals 3→4 are a blank-line mid-sentence cut (no furniture line between lines
1112 and 1114), which puts `req_824bf964996e52d7` in the "cut at a blank line" class above —
19 such rows in 8 documents corpus-wide.

---

## Case 4 — RFC 4343 §4.1, G0085 (weak, lower-case "may") — MISS

### The sentence as the RFC writes it

> However, to optimize output, indirect labels may be used to point to names elsewhere in the
> DNS answer.

It sits in a whole section that is a quotation of STD13 (RFC 13); the raw text shows the
quotation set at the same three-column indent as ordinary body prose, so indentation carries
no signal here.

### The block

| field | value |
| --- | --- |
| block | `blk_7385d25da50cac4bd4234afe`, ordinal 0 of `sec_bdfa3c9da780f1caa793b6eb` |
| `blocks.kind` | **`reference_entry`** |
| section | `4.1` "DNS Output Case Preservation", `sections.kind = body` |
| extent | chars 9920–10933, lines 241–255 |
| text starts | `   [STD13] views the DNS namespace as a node tree.  ASCII output is as if a name were marshaled …` |

### What the extractor did

* **Strict: never saw it.** `reference_entry` is not in `PROSE_BLOCK_KINDS`
  (`normative.ts:167` = `paragraph`, `list_item`, `unknown`), so the block fails the gate at
  `normative.ts:723` and `splitSentences` is never called on it. 0 requirements and 0 mentions
  in RFC 4343 contain any part of the probe.
* **Candidates: never saw it.** `analyzeNormativeCandidates` skips the kind explicitly
  (`normative.ts:979`), and the response says so: warning
  `candidates:reference_entry_blocks_skipped:1`.
* **Visible in `coverage`, but not as a loss of normative text.**
  `blocks_skipped_by_kind: {"preformatted":4,"reference_entry":1,"section:references":25,"section:authors":2}`
  — the `1` is this block — while `keyword_bearing_blocks_skipped: 1` does **not** count it,
  because that counter tests `TERM_PROBE` (`normative.ts:72`), which is case-sensitive, and
  this block's only modals are lower case. A caller reading only
  `keyword_bearing_blocks_skipped` cannot see that a body paragraph holding a permission was
  dropped.

### Mechanism

`classifyBlock` (`src/parse/text.ts:823`) tests the first line against
`/^\s*\[\s*[A-Za-z0-9][A-Za-z0-9._-]*(?:\s*,\s*(?:Section|Appendix)[^\]]*)?\s*\]\s+/`
(`:825`) and returns `reference_entry` for any block that opens with a bracketed tag. Body
prose that opens by citing another document — `[STD13] views the DNS namespace …` — is
therefore typed as a bibliography entry and dropped by both the strict gate
(`normative.ts:723`) and the candidate skip (`normative.ts:979`).

### Fix location

Block classifier (`classifyBlock`, `src/parse/text.ts:825`): `reference_entry` has to be
bounded by the enclosing section being a bibliography, or by the block having citation shape
(tag, author, title, RFC number, date), because a tag at the start of a line is not evidence
of a bibliography. Corpus-wide size, measured on the current DB: **184** blocks are typed
`reference_entry` outside a `references`/`index`/`authors` section, across 45 documents
(2 863 of the 3 047 such blocks are genuine bibliography entries); **6** of the 184 carry an
upper-case RFC 2119 keyword and **22** carry a modal token in any case — including both
`4343 §4.1` and `9117 §5`. Zero requirement rows are reachable from all 184.

Caveat for whoever fixes it: RFC 4343 §4.1 is a *quotation of another document*, and §4 is
where RFC 4343 states its own position ("the preservation of case on output is NOT required
when output is optimized by the use of indirect labels"). Restoring the block makes the quoted
"may" visible; whether quoted material should be presented as this document's obligation is a
reading decision, not a parse decision, and belongs in the fix's reporting rather than in a
silent promotion.

---

## Case 5 — RFC 9117 §5, G0229 (weak, lower-case "should") — MISS

### The sentence as the RFC writes it

> If the latter applies, a network should be designed so it has a congruent topology amongst
> unicast routes and Flow Specification routes.

### The block

| field | value |
| --- | --- |
| block | `blk_d33f3c8d355dfb9d96845365`, ordinal 0 of the §5 section |
| `blocks.kind` | **`reference_entry`** |
| section | `5` "Topology Considerations", `sections.kind = body` |
| extent | chars 20140–20972, lines 406–417 |
| text starts | `   [RFC8955] indicates that the originator may refer to the originator\n   path attribute (ORIGINATOR_ID) or (if the attribute is not present)\n   the transport address of the peer …` |

The second half of the block ("… the update.  If the latter applies, a network should be
designed …") is ordinary body prose at the same three-column indent as every other paragraph
of §5.

### What the extractor did

* **Strict: never saw it.** Same gate as case 4 (`normative.ts:723`): 0 requirements, 0
  mentions for RFC 9117 contain any part of the probe. (RFC 9117 reports 3 requirements in
  total, none of them from §5.)
* **Candidates: never saw it.** `normative.ts:979`; warning
  `candidates:reference_entry_blocks_skipped:1`.
* **Coverage.** `blocks_skipped_by_kind: {"preformatted":9,"reference_entry":2,"table":3,"section:references":9,"section:authors":10}`,
  `keyword_bearing_blocks_skipped: 4` — again not counting either body `reference_entry`
  block (§1 and §5), because their modals are lower case. The one candidate row that contains
  the probe's tail phrase "Flow Specification routes" is from §7 and is unrelated.
  (`reference_entry: 2` counts §1 and §5; the candidate warning says `1` because the candidate
  pass is handed only blocks whose text contains a modal word —
  `store.listBlocksWithKeywords`, `src/store/database.ts:1184` — and §1's block has none.)

### Mechanism

Identical to case 4: `classifyBlock` (`src/parse/text.ts:825`) reads the leading `[RFC8955]`
as a bibliography tag and the whole body paragraph — including the "should be designed"
obligation — is dropped before sentence splitting, by both passes.

### Fix location

Block classifier, same as case 4. The two cases are the same defect with the same fix; the
fix should be validated against both, and against the 22 corpus-wide instances listed in
case 4 (which include `[RFC2181] specifies …`, `[RFC5321] and its predecessors …`,
`[RFC6066] and [RFC6961] provide …`, `[RFC8955] indicates …`).

---

## Case 6 — RFC 2865 §5.22, G0040 + G0041 (strict, MUST NOT / SHOULD) — **NOT A MISS NOW**

### The sentences as the RFC writes them

> It is intended to be human readable and MUST NOT affect operation of the protocol.

> Whenever the gateway address is specified as "0.0.0.0" the IP address of the user SHOULD be
> used as the gateway address.

### The blocks

| probe | block | `blocks.kind` | section | extent |
| --- | --- | --- | --- | --- |
| G0040 | `blk_8ae2e521be7d2c84965f8c4d` (ordinal 9) | `paragraph` | `5.22` "Framed-Route", `body` | chars 88132–88404, lines 2425–2428 |
| G0041 | `blk_9bf0fd79ffccfc158cbbddc1` (ordinal 11) | `paragraph` | `5.22` "Framed-Route", `body` | chars 89033–89165, lines 2440–2441 |

### What the extractor did — both sentences are emitted, verbatim

```
$ node dist/cli.js requirements 2865 --scope 5.22 --json
req_bd53b91b5c5c7a2b | 5.22 | MUST NOT | "It is intended to be human readable and\n      MUST NOT affect operation of the protocol."
req_e936227f15d10948 | 5.22 | SHOULD    | "Whenever the gateway address is specified as \"0.0.0.0\" the IP\n      address of the user SHOULD be used as the gateway address."
```

`req_bd53b91b5c5c7a2b` span chars 88230–88318, `flags_json = []`, `parse_status = complete`,
`confidence = 0.9`; mention `men_e568654d329d9776`. `req_e936227f15d10948` span chars
89039–89165, `flags_json = []`; mention `men_a1f8b6549c650961`. Both normalise to the probe
exactly, so both rules match. `after.json`, `after2.json`, `after3.json` record G0040 and
G0041 as found; only `before.json` records them as misses.

One duplicate worth knowing about: the same "It is intended to be human readable and MUST NOT
affect operation of the protocol." sentence also occurs verbatim in §5.11 (Filter-Id,
`blk_f2ab076e121a1aeb2b68c27c` → `req_32c2f4aacce15a7d`) and, with a comma, in §5.18
(`req_351e1c0dd6f5f9e3`). That is four rows in the corpus for one sentence of wording; it is
why the pool search reports `tail=4`. It is faithful, not a defect.

### Mechanism

None in the current build. As in case 2, the pre-round state is not re-derivable — one
snapshot per RFC, re-derived after the `before` run (`before.json`: 54 requirements for
RFC 2865; current derivation: 165). The stale note in `before-miss-review.json` — G0040
"anaphoric", G0041 "Self-contained. Open." — should be closed as resolved. The anaphora
boundary is in any case not what applies here: both sentences are emitted whole, and
G0041's subject ("the gateway address") is inside its own sentence.

---

## Summary table

| # | Case | Golden id | Mechanism | Responsible file / function | General fix? |
| --- | --- | --- | --- | --- | --- |
| 1 | RFC 1812 §4.2.2.2 | G0017 | Page break ends the block mid-sentence; `splitSentences` runs per block, so the strict pass emits the first half as a complete requirement with no fragment flag | `src/parse/text.ts` `groupBlocks` (:729, furniture-as-separator at :704-708) + `src/analysis/normative.ts` `splitSentences` (:1146) called per block from `analyzeNormative` (:732) | **Yes.** Not a documented boundary. Strict pass needs the continuation-join / `continues_previous_block` equivalent the candidate pass already has (`normative.ts:995,1054,1109`). 274 corpus rows in 38 documents are page-break first halves, 220 of them unflagged |
| 2 | RFC 3501 §6.3.2 | G0058 | **Not a miss in the current build** — emitted verbatim as `req_ef57b5b5a4df0dd4`, `flags []` | n/a | n/a. Close the stale `before-miss-review.json` entry |
| 3 | RFC 5155 §7.2.8 | G0099 | Bulleted condition list inside one sentence becomes four blocks at the blank lines; per-block `splitSentences` keeps only the clause carrying the keyword, and `condition` is lost | same pair as #1: `src/parse/text.ts` `groupBlocks` (:729) + `src/analysis/normative.ts` `splitSentences` (:1146). Secondary: `classifyBlock` (:828) does not type the bare `o` marker as `list_item` — not sufficient on its own | **Yes.** Not a documented boundary. Same fix as #1; 19 corpus rows in 8 documents are blank-line first halves, and 97 rows in 31 documents are sentence tails |
| 4 | RFC 4343 §4.1 | G0085 | Body paragraph opening with a bracketed citation tag is typed `reference_entry`, so it is dropped by the strict gate and by the candidate skip before any sentence is split | `src/parse/text.ts` `classifyBlock` (:825) → consumed at `src/analysis/normative.ts` :723 (`PROSE_BLOCK_KINDS`, :167) and :979 | **Yes**, with a judgement call on quoted material. 184 `reference_entry` blocks sit outside bibliographies, in 45 documents; 22 carry a modal token |
| 5 | RFC 9117 §5 | G0229 | Same defect as #4 (`[RFC8955] indicates that …`) | same as #4 | **Yes.** Same fix as #4 |
| 6 | RFC 2865 §5.22 | G0040, G0041 | **Not a miss in the current build** — both emitted verbatim (`req_bd53b91b5c5c7a2b`, `req_e936227f15d10948`), `flags []` | n/a | n/a. Close the stale `before-miss-review.json` entries |

### Mechanism counts

| mechanism | cases | golden rules |
| --- | --- | --- |
| Sentence split at a block boundary, strict pass has no continuation-join and no fragment flag (page break: 1; blank-line list: 1) | 2 | 2 (G0017, G0099) |
| Body prose mis-typed `reference_entry` by `classifyBlock`, dropped by both passes | 2 | 2 (G0085, G0229) |
| Not a miss in the current build (found verbatim) | 2 | 3 (G0058, G0040, G0041) |
| Classified as discourse about the requirement language (`keyword_enumeration` / `definition_section` / `term_quoted`) | 0 | 0 |
| Block kind outside the strict set for some reason other than `reference_entry` | 0 | 0 |
| Section kind in `authors` / `index` / `references` | 0 | 0 |
| Golden-probe error | 0 | 0 |
| **Documented boundaries** (anaphora across a block boundary; deontic-versus-descriptive modality) | **0** | **0** |

The two documented boundaries are recorded in `CHANGELOG.md` "Not changed, and why"
(anaphora, with the RFC 2181 §5.5 example; and "whether a sentence is deontic or descriptive
is not decidable from surface syntax"). **None of these six is one of them.** The anaphora
note does not apply to case 6 (both sentences are self-contained and are emitted whole), and
the modality note does not apply to cases 4 and 5, because in those the sentence was never
read at all — the block was discarded before classification, so no deontic/descriptive
judgement was ever attempted. Every one of the four live misses is a mechanical loss with a
general fix.

### Caveats recorded for whoever fixes this

1. The strict pass is the channel that is silent about its own loss. `analyzeNormative` has
   no `continues_previous_block` equivalent and no "this row is a fragment" flag, so a
   truncated requirement is emitted with `parse_status: complete` and `confidence: 0.9`
   (cases 1 and 3). That is worse for a caller than a missing row, because the count
   `coverage.total_requirements` is trusted.
2. `coverage.keyword_bearing_blocks_skipped` tests `TERM_PROBE`, which is case-sensitive
   (`normative.ts:72`), so a body block dropped while holding only lower-case modals — cases 4
   and 5 — is not counted and raises no `normative_text_in_unscanned_blocks` warning. The weak
   tier's losses are invisible in the loss counter.
3. `non_strict_candidates.candidates` is *not* a safety net for a strict miss: `normative.ts:1048`
   removes every upper-case keyword in a prose block precisely because "the strict extractor
   already owns" it. When the strict pass emits a fragment, the candidate channel has
   deliberately been emptied, so cases 1 and 3 are absent from both pools.
4. `read`/`show` and `requirements` disagree in all four live cases.
   `show --section` puts the whole sentence in `data.text` — with page furniture blanked where
   the section had any (case 1; the `text_clean` / `text_verbatim` pair is only emitted then,
   `src/service/rfcService.ts:961`; the candidate list's own fragment split is at `:1452`) —
   while `requirements` returns a fragment of it, or nothing
   for it. Verified: `show 4343 --section 4.1` and `show 9117 --section 5` both return the probe
   in `data.text`; `show 5155 --section 7.2.8` returns both halves; `show 1812 --section 4.2.2.2`
   returns the joined sentence in `data.text_clean`. The bench probes are built from exactly
   this reading.

### Reproducing

```bash
# current state, the six cases, through the caller's own path
node /tmp/opencode/diag/verify.mjs     # 4 MISSED / 3 FOUND, see file header of this report
# block, section kind, requirement and mention rows, per case
node /tmp/opencode/diag/case.mjs <rfc> "<distinctive phrase>"
node /tmp/opencode/diag/sec.mjs  <rfc> <section>      # every block of a section with its rows
# raw bytes around a split
node /tmp/opencode/diag/raw.mjs  <rfc> <charStart> <charEnd>
# read-only DB queries used above
node /tmp/opencode/diag/q.mjs "select kind, text from blocks where snapshot_id=(select id from snapshots where rfc=1812 order by retrieved_at desc limit 1) and text like '%logical interface on which%'"
```

All of the above are read-only: the DB is opened with
`new DatabaseSync(path, { readOnly: true })`, and the only commands run against the build were
`dist/cli.js status|requirements|show`.
