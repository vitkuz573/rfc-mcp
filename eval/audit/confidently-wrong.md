# Confidently-wrong rows — adversarial audit

**Objective.** Find rows the tool emits that _look_ correct and _are_ wrong. A missing row is a
countable loss; a wrong row that looks right is the failure that produces a confidently
non-compliant implementation.

**Method.** Read-only. Opened `~/.local/share/rfc-mcp/corpus.sqlite` with
`new DatabaseSync(path, {readOnly:true})` and inspected every `requirements` row, every
`sections` row and every `blocks` row, plus every `non_strict_candidates` row the caller
surface produces. Caller-view spot checks were taken through `node dist/cli.js requirements <rfc>
--json` (the same code path the MCP server runs). Nothing was written except this file.

**Measurement basis — read this before quoting any number.**

|                                              |                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `meta.index_generation`                      | **1980**                                                             |
| snapshots / sections / blocks / requirements | 182 / 9 955 / 65 756 / **12 209**                                    |
| parser / extractor stamped on every row      | `rfc-text-1.7.3` / `normative-2119-8174-1.6.3`                       |
| build that answers queries                   | `dist/`, built 12:31, `extractorVersion = normative-2119-8174-1.6.3` |
| candidate-row measurement                    | 166 pinned RFCs (the corpus was still growing), same `dist`          |

Two facts about the artifact, because they change who is at fault for §6:

- **The corpus grew under the audit** (159 → 166 → 181 → 182 snapshots; 10 618 → 12 209
  requirement rows) while a background `sync` ran. Every count below is from one generation
  (1980) so the numbers are mutually consistent, but they are not comparable to any number
  taken earlier today.
- **`dist/` is behind `src/`.** `src/core/config.ts` and `contract-versions.json` declare
  `extractor 1.7.0`; `dist/core/config.js` says `1.6.3`. `src/analysis/normative.ts` (mtime
  13:19) contains a three-argument `classifyRequirementShape(clause, keyword, placement)` with a
  `canStateAnObligation()` guard set (`subjectIsTheDocumentItself`, `modalSitsInsideANounPhrase`,
  `evaluatesRatherThanSpecifies`, …). `dist/analysis/normative.js:438` contains the **old
  two-argument** version: `if (VERB_FORMS.has(word)) return "demand"` over the words of the
  clause after the keyword, with no look at the left context at all. So the false `shape: demand`
  rows in §6 are what the tool emits _today_; the guard that would catch them is written but not
  built. Everything else below is in the DB and therefore independent of this.

---

## F1 — `parse_status: "complete"` on a sentence tail, with no flag at all

**765 rows are labelled `complete` and fail at least one completeness test. 486 of them carry
`flags: []`.** 271 of the 303 rows that begin with a lower-case letter are labelled `complete`.

The sharpest sub-case: the row's `exact_text` begins mid-sentence, `parse_status` says
`complete`, `confidence` is 0.9, and `flags` is `[]`. A caller reading `exact_text` sees a
sentence the RFC never wrote, and nothing on the row says so.

**Worst example.**

```
req_de54507f34aee5bf   RFC 1122 §3.3.5 "Source Route Forwarding"   MUST
parse_status=complete  confidence=0.9  flags=[]
exact_text = "containing a Timestamp Option MUST add the current timestamp to that option,
              according to the rules for this option."
clause     = { actor: "containing a Timestamp Option",
               condition: null,
               action: "add the current timestamp to that option, according to the rules for this option" }
```

The subject ("A host that receives …") is in the previous block. The row's `clause.actor` is a
verb phrase, not an actor, and the row is presented as a complete, citable statement.

```
req_460fd9b95bfcb7fb   RFC 1122 §3.2.1.2? -> §"Gateway Selection"   MUST
exact_text = "network), the IP layer MUST pick a gateway from its list of \"default\" gateways."
flags=[]  parse_status=complete
```

```
req_3fe0a4fb12e8fc9d   RFC 1122 §3.2.1.3   MUST NOT   parse_status=partial
exact_text = "MUST NOT be sent, except as a source address as part of an initialization
              procedure by which the host learns its own IP address."
```

This one _is_ flagged `partial` + `actor_not_explicit`, so it is honest. It is listed because it
shows the same split: the sentence splitter cuts at a block boundary and the subject stays
behind. The difference between this row and `req_de54507f34aee5bf` is not the extractor
knowing — it is luck.

**Query.**

```sql
SELECT r.id, r.rfc, s.number, r.parse_status, r.flags_json, substr(r.exact_text,1,90)
FROM requirements r JOIN sections s
  ON s.snapshot_id=r.snapshot_id AND s.id=r.section_id
WHERE r.parse_status='complete' AND r.flags_json='[]'
  AND ( substr(ltrim(r.exact_text),1,1) BETWEEN 'a' AND 'z'
        OR r.exact_text NOT LIKE '%[.!?"]%' )
LIMIT 20;
```

**Why it matters.** A contract line generated from `clause.action` reads
"containing a Timestamp Option MUST add the current timestamp to that option" — an obligation on
nobody, derived from a row that claims to be a complete sentence.

**Severity: critical.**

---

## F2 — First half of a sentence split by a page break, labelled `complete`

The brief's old figure was 274 unflagged page-break first halves. **Current measurement, stated
by definition:**

| definition                                                                                       | rows    | of which `flags: []` | labelled `complete` |
| ------------------------------------------------------------------------------------------------ | ------- | -------------------- | ------------------- |
| block ends without terminal punctuation **and** a form feed lies between this block and the next | **129** | **92**               | 111                 |
| any block-boundary split where the next block continues the sentence                             | 134     | 93                   | —                   |

The 92 unflagged page-break first halves are the number to carry forward; the 274 in the brief
is not reproducible under either definition at this generation, and the class has not been fixed,
only re-measured.

**Worst example — a Standards Track document from 2018.**

```
req_9181039dba52a121   RFC 8470 §6.1 "Gateways and Early Data"   SHOULD
parse_status=complete  confidence=0.9  flags=[]
exact_text = "A gateway that is uncertain about origin server support for a given request
              SHOULD either delay forwarding the"
clause     = { actor: "support for a given request", condition: null,
               action: "either delay forwarding the" }
```

The RFC continues on the next page:

```
445:    support for a given request SHOULD either delay forwarding the
450:  Thomson, et al.              Standards Track                    [Page 8]
451:  <FF>
455:    request until the TLS handshake with its client completes or send a
456:    425 (Too Early) status code in response.
```

The caller receives a requirement whose object is missing and whose actor is a prepositional
phrase, at `confidence: 0.9`, `parse_status: "complete"`, with no flag.

**Query.**

```sql
-- join each requirement to its block and to the next block in the same section,
-- then require a form feed in the text between the two blocks
```

```js
const termEnd = (s) => /[.!?]["”’»)\]]*\s*$/.test(s);
for (const r of rows) {
  const arr = blocksOf(r.snapshot_id, r.section_id); // ordered by ordinal
  const i = arr.findIndex((b) => b.id === r.block_id);
  const b = arr[i],
    next = arr[i + 1];
  if (r.char_end !== b.char_end) continue;
  if (termEnd(b.text)) continue;
  const gap = doc(r.snapshot_id).slice(b.char_end, next.char_start);
  if (gap.includes("\f")) {
    /* page-break first half */
  }
}
```

**Severity: critical.** (An unflagged truncated imperative at `complete`/0.9 is the row shape
most likely to be copied straight into an implementation checklist.)

---

## F3 — `clause.condition` invented from an unbalanced bracket

**7 rows.** The condition splitter cuts at the first `(`, producing a condition that is a
fragment ending in an open bracket — on sentences that are **unconditional**.

```
req_73abf469306444f8   RFC 1812 §5.2.7.2 "Redirect"   MUST NOT   complete   flags=[]
exact_text = "A router using a routing protocol (other than static routes) MUST NOT consider
              paths learned from ICMP Redirects when forwarding a packet."
clause     = { condition: "A router using a routing protocol (",
               actor:     "static routes)",
               action:    "consider paths learned from ICMP Redirects when forwarding a packet." }
```

The requirement is unconditional. The row says it is conditional on the fragment
`"A router using a routing protocol ("`, and assigns the obligation to the fragment
`"static routes)"`. A caller writing `if (<condition>) then <actor> must <action>` gets a
never-true guard and a nonsense actor.

```
req_4935d0d935926cb5  RFC 1122 §3.2.1.8  MUST   condition: "All IP options ("
req_a11bbfd0a2595661  RFC 1812 §7.2.1    MUST   condition: "A router that implements any routing protocol ("
req_24fbb273afef8a1d  RFC 7230 §2.6      MUST   condition: "Intermediaries that process HTTP messages (i.e., all intermediaries"
req_6a0520d6f71b8ac0  RFC 9112 §2.6      MUST   (same sentence, §2.6 of the successor)
req_b256fb1e4084b6d6  RFC 1812 §8.3      MUST   condition: "If the router supports X.25 over any of its interfaces then the X.25 MIBs [MGT:22"
```

**Query.**

```sql
SELECT id, rfc, condition_text, substr(exact_text,1,80) FROM requirements
WHERE condition_text IS NOT NULL
  AND ( length(condition_text) - length(replace(condition_text,'(',''))
      - length(condition_text) + length(replace(condition_text,')','')) ) <> 0;
```

**Severity: critical.** Wrong guard, wrong actor, `complete`, no flag.

---

## F4 — `clause.condition` holding a discourse marker

**45 rows.** `condition_text` is `"For example"`, `"For instance"`, `"Similarly, routers may
provide,"` — not a condition at all.

```
req_84b211d04918129a   RFC 1122 §3.2.2.1   MUST NOT   complete   flags=[]
exact_text    = "For example, it MUST NOT be used as proof of a dead gateway (see Section 3.3.1)."
clause.condition = "For example"
clause.actor     = "it"
clause.action    = "be used as proof of a dead gateway (see Section 3.3.1)."
```

The requirement is unconditional and its real content is a cross-reference. The row reports a
condition.

```
req_462de6c1ddf873f6   RFC 1812 §1.1.3 "Compliance"   MUST   complete
exact_text       = "Likewise, routers may provide, except where explicitly prohibited by this memo,
                     options which cause them to violate MUST or MUST NOT requirements."
clause.condition = "Likewise, routers may provide,"     <-- a truncated clause containing a modal
clause.actor     = "options which cause them to violate"
clause.action    = "or MUST NOT requirements."
```

The condition text ends in a comma, contains its own modal, and is not a subordinate clause.
This is the "condition that holds the main clause" case the brief asked for: the requirement is
conditional on nothing, and the row's `condition` is a fragment of the main clause.

**Query.**

```sql
SELECT id, rfc, term, condition_text, substr(exact_text,1,80) FROM requirements
WHERE condition_text IS NOT NULL
  AND condition_text IN ('For example','For instance','For example,','Note','See','Similarly,');
```

**Severity: high.**

---

## F5 — The real condition is in the previous sentence or block; `condition` is `null`

**203 rows** have `condition_text IS NULL` and open with an explicit back-reference connective
(`then`, `otherwise`, `in this case`, `therefore`, `thus`, `consequently`, `as a result`, …).
The row reads as unconditional. It is not.

**Worst example — same block, previous sentence.**

```
req_ecce0f28df050721   RFC 1812 §4.2.2.11   MUST   complete   confidence=0.9   flags=[]
exact_text = "Otherwise, the router MUST discard it."
clause     = { condition: null, actor: "the router", action: "discard it." }
```

Raw text, one block, lines 2647–2649:

```
2647:       Thus, if a router knows how to deal with a given datagram having a
2648:       { 0, 0 } source address, the router MUST accept it.  Otherwise,
2649:       the router MUST discard it.
```

The companion row `req_f7ffb46f9569e51f` carries the real condition ("if a router knows how to
deal with …"). The extractor emitted one good row and one row that silently drops the negation.
A caller gets **an unconditional "the router MUST discard it"** with an unresolvable object.

```
req_ce81c2a0d263aa10   RFC 1812 §4.2.2.11   MUST   complete   flags=[]
exact_text = "Otherwise, a router MUST silently discard any locally-delivered datagram whose
              source address is { 0, 0 }."
condition  = null
```

Condition is lines 2625–2628 of the _same block_.

```
req_824bf964996e52d7   RFC 5155 §7.2.8 "Responding to Queries for NSEC3 Owner Names"
MUST   complete   flags=[]   condition=null
exact_text = "then the response MUST be constructed as a Name Error response (Section 7.2.2)."
actor     = "then the response"
```

Raw, lines 1108–1114 — the condition is a two-item bullet list two blocks above:

```
1108:    If the following conditions are all true:
1110:    o  the QNAME equals the owner name of an existing NSEC3 RR, and
1112:    o  no RR types exist at the QNAME, nor at any descendant of QNAME,
1114:    then the response MUST be constructed as a Name Error response
```

This is the case the brief named, and the general shape is common: **the sentence splitter's
boundary and the condition's scope do not agree.**

```
req_5df84489c4e13fc7   RFC 1123 §3.3.1   MUST   condition=null
exact_text = "Thus, CR LF and CR NUL MUST have the same effect on an ASCII server host when
              received as input over a Telnet connection."
```

Condition ("on server hosts that use ASCII") is in the previous sentence of the same block.

**Query.**

```sql
SELECT id, rfc, term, substr(exact_text,1,90) FROM requirements
WHERE condition_text IS NULL
  AND (exact_text LIKE 'then %' OR exact_text LIKE 'Otherwise,%'
    OR exact_text LIKE 'In this case,%' OR exact_text LIKE 'Therefore,%'
    OR exact_text LIKE 'thus,%' OR exact_text LIKE 'consequently,%');
```

**Severity: critical.** A missing condition is not a missing row; it is a row that says the
opposite of the RFC.

---

## F6 — `clause.actor` is not a noun phrase

The actor field is the one a caller turns into "who is bound". It is populated with predicate
tails, prepositional phrases, connectives and expletives, and it is never flagged.

| pattern                                                       | rows    | example actor                                                                                            |
| ------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| ends in a preposition / conjunction / relativiser             | **248** | `"and"`, `"but"`, `"as"`, `"obsolete and"`, `"have no meaning for a host and"`                           |
| ends in a form of _to be_                                     | **235** | `"Route option is"`, `"It is"`, `"the server is"`, `"is"`                                                |
| starts with a preposition                                     | **150** | `"for link-layer encapsulation"`, `"at a high rate)"`, `"between conflicting static and dynamic routes"` |
| is exactly `"It is"` (cleft; real subject is after `that`)    | **104** | see below                                                                                                |
| is a bare pronoun / demonstrative                             | 752     | `"it"`, `"It"`, `"This"`, `"There"`                                                                      |
| is empty or punctuation only (**`action`**)                   | 52      | `action = "."`                                                                                           |
| `actor IS NULL` but **not** flagged `actor_not_explicit`      | **0**   | —                                                                                                        |
| `actor` is not a substring of its own `exact_text`            | **0**   | —                                                                                                        |
| `actor` does not appear in the first 20 chars of the sentence | 4 859   | —                                                                                                        |

**Flag discipline is clean where it exists** (0 unflagged nulls) — the defect is that a
_non-empty_ actor is never checked.

```
req_c1d490dcf2ec069d   RFC 1122 §4.2.2.3   RECOMMENDED   complete
exact_text = "It is RECOMMENDED that implementations reserve 32-bit fields for the send and
              receive window sizes in the connection record and do so only once."
clause     = { actor: "It is",
               action: "that implementations reserve 32-bit fields for the send and receive
                        window sizes in the connection record" }
```

`actor` is the expletive plus the copula. The entity the modal binds — `implementations` — is in
`action`. A contract line reads "It is must: that implementations reserve 32-bit fields".

```
req_38218ac2b695c993   RFC 1122 §2.3.2.1   MUST   complete
exact_text = "A mechanism to prevent ARP flooding (repeatedly sending an ARP Request for the
              same IP address, at a high rate) MUST be included."
clause.actor = "at a high rate)"      <-- includes a closing parenthesis
clause.action = "be included."
```

The actor is a fragment of a parenthetical inside the _subject_. The real subject is
"A mechanism to prevent ARP flooding (…)".

```
req_2a723a9bfb267d58   RFC 1812 §7.4   SHOULD   complete
exact_text = "Whether a router prefers a static route over a dynamic route (or vice versa) or
              whether the associated metrics are used to choose between conflicting static and
              dynamic routes SHOULD be configurable for each static route."
clause.actor = "between conflicting static and dynamic routes"
```

Actor taken from the middle of the sentence; the subject is an embedded interrogative `whether`-clause.

```
req_2f924638b89d53b8  RFC 1812 §"Name Active Passive Description"   SHOULD
actor = "which is"      <-- pure relativiser + copula, from "…except the IGMP protocol itself,
                            which is OPTIONAL"
req_e78a355eb7c71a3a  RFC 1939   actor = "and"
req_619344343c5ecd98  RFC 1123   actor = "as"
req_2045ab5ad1fb3b639a51 (RFC 2045) actor = "but"
```

**Query.**

```sql
SELECT id, rfc, actor, substr(exact_text,1,80) FROM requirements
WHERE actor IS NOT NULL
  AND ( actor REGEXP '(^| )(is|are|was|were|and|or|but|of|in|on|for|with|by|from|to|that|which|as|than|then|now)$'
     OR actor IN ('It is','it is','and','but','as','is','are') );
```

**Severity: critical** for the 524 rows where the actor is syntactically not an actor;
**medium** for the 752 bare-pronoun rows, which are grammatical subjects whose antecedent the
caller must resolve from the condition (honest, but useless as a contract key on their own).

---

## F7 — A descriptive statement emitted as a normative `OPTIONAL`

`OPTIONAL` and `REQUIRED` are genuine RFC 2119 keywords, so an uppercase occurrence is a keyword
by the letter of BCP 14. The problem is not the letter, it is the **absence of any signal on the
requirements path**: `shape` and `role` exist only on `non_strict_candidates`. A row emitted
under `requirements` is presented as a requirement, with `strength`, `polarity`,
`parse_status: "complete"`, `confidence: 0.9` and `flags: []`, and there is no field on it that
can say "this sentence reports a property of the protocol rather than binding an implementer".

**65 rows** have `term = "OPTIONAL"`; **59** have `term = "REQUIRED"`; **83 rows** in total
place the keyword in sentence-final position (a predicate adjective, not a modal).

**Worst examples.**

```
req_4cb7b965d5d269cd   RFC 9110 §9.1 "Overview"   OPTIONAL   complete   confidence=0.9   flags=[]
exact_text = "All other methods are OPTIONAL."
clause     = { actor: "All other methods are", condition: null, action: "." }
```

Describes the protocol. `strength: "optional"`, `action: "."`.

```
req_ed5c771c28b04ad3   RFC 9000 §17.4 "Latency Spin Bit"   OPTIONAL   complete   flags=[]
exact_text = "The spin bit is an OPTIONAL feature of this version of QUIC."
clause     = { actor: "The spin bit is an", action: "feature of this version of QUIC." }
```

The identical sentence is emitted three times across the corpus (RFC 7231 §4.1,
RFC 9110 §9.1, RFC 9000 §17.4) — HTTP/3 wrote it into the spec as a fact about HTTP/2.

```
req_bacfe739256265f2   RFC 7234 §2 "Overview of Cache Operation"   OPTIONAL   complete   flags=[]
exact_text = "Although caching is an entirely OPTIONAL feature of HTTP, it can be assumed that
              reusing a cached response is desirable and that such reuse is the default
              behavior when no requirement or local configuration prevents it."
clause     = { actor: "Although caching is an entirely",
               action: "feature of HTTP, it can be assumed that reusing a cached response is
                        desirable and that such reuse is the default behavior when no
                        requirement or local configuration prevents it." }
```

A subordinate clause is the actor; the entire remainder of the paragraph is the "action". The
same row exists for RFC 9111 §2 (`req_905a48669d59e34e`).

```
req_b902d1028ec4ea13   RFC 1122 §3.2.1.8   OPTIONAL   complete   flags=[]
exact_text = "Implementation of originating and processing the Record Route option is OPTIONAL."
clause     = { actor: "Route option is", action: "." }
req_c612278b1ad33d80   RFC 1122 §3.2.1.8   "…the Timestamp option is OPTIONAL."   actor "Timestamp option is"
req_6481d5839d14a763   RFC 1123 §5.2.15   "That is, the phrase preceding a route address is now OPTIONAL."  actor "…is now"
req_409bd1da3159d346   RFC 1812 §6.2      "…Passing a received PSH flag to the application layer is now OPTIONAL."
req_1da61e780344fb0a   RFC 4120 §5.2.5    "…HostAddresses is always used as an OPTIONAL field and -- should not be empty."
```

RFC 1812's row also carries the _section number_ `Name    Active  Passive Description` (see F10),
so a caller sees a bogus section, a predicate-adjective "actor", an `OPTIONAL` strength, and an
`action` of `"."`.

**Query.**

```sql
SELECT id, rfc, term, strength, actor, substr(action,1,60), substr(exact_text,1,90)
FROM requirements WHERE term IN ('OPTIONAL','REQUIRED') ORDER BY rfc;
```

**Severity: critical** for the ~15 rows whose subject is a protocol element rather than an
implementer; **medium** for the RFC 1122/1123/1812 rows, which are old-RFC idiom and arguably do
state a requirement.

---

## F8 — Code, ABNF and ASN.1 emitted as RFC 2119 requirements

The tool's own contract says _"Code, tables, figures, references and quoted definitions are
excluded by design and reported as mentions."_ They are not excluded: these blocks are typed
`kind: "paragraph"` by the parser, so the prose filter never sees them.

**16 rows minimum, all `parse_status` complete-or-partial, all with RFC 2119 `strength`.**

```
req_7498452cdd762788   RFC 5280 Appendix A "Pseudo-ASN.1 Structures and OIDs"
term=OPTIONAL  strength=optional  polarity=positive  parse_status=complete  confidence=0.9
flags=["multiple_terms_in_sentence","in_appendix","keywords_collapsed_to_one_row"]
exact_text = "ORAddress ::= SEQUENCE {
                 built-in-standard-attributes BuiltInStandardAttributes,
                 built-in-domain-defined-attributes
                     BuiltInDomainDefinedAttributes OPTIONAL,
                 -- see also teletex-domain-defined-attributes
                 extension-attributes ExtensionAttributes OPTIONAL }"
clause     = { actor: "BuiltInDomainDefinedAttributes",
               action: ", -- see also teletex-domain-defined-attributes extension-attributes
                        ExtensionAttributes OPTIONAL }"
```

`OPTIONAL` here is the **ASN.1** `OPTIONAL`, not RFC 2119. The tool reports it as an
`optional`-strength, positive-polarity requirement and counts it in `coverage.total_requirements`.

```
req_a8c9f3dd41de2e84   RFC 5280 App. A   OPTIONAL   complete   flags=["in_appendix"]
exact_text = "AlgorithmIdentifier ::= SEQUENCE { algorithm OBJECT IDENTIFIER,
                 parameters ANY DEFINED BY algorithm OPTIONAL } -- contains a value of the type
                 -- registered for use with the algorithm object identifier value"
actor = "parameters ANY DEFINED BY algorithm"
```

```
req_5ef1942b5422ab76   RFC 3501 §9 "Formal Syntax"   MUST NOT   complete   flags=[]
exact_text = "body-type-basic = media-basic SP body-fields
                    ; MESSAGE subtype MUST NOT be \"RFC822\""
clause     = { actor: "MESSAGE subtype", action: "be \"RFC822\"" }
```

The row's `exact_text` opens with an **ABNF production name**. The RFC's own words are in an
ABNF `;` comment. The row says the "MESSAGE subtype" is the actor of a `MUST NOT`.

```
req_32e1e22cfcc713d8   RFC 3501 §9   MUST   complete   flags=[]
exact_text = "capability = (\"AUTH=\" auth-type) / atom
                    ; New capabilities MUST begin with \"X\" or be
                    ; registered with IANA as standard or
                    ; standards-track"
action = "begin with \"X\" or be ; registered with IANA as standard or ; standards-track"
```

```
req_214e0f345b88bd25   RFC 3501 §9   MUST NOT   complete   flags=[]
exact_text = "Server
                    ; implementations MUST NOT generate
                    ; body-extension fields"
```

This one reads almost like a requirement, which is what makes it dangerous: the `clause` fields
are computed from a mangled ABNF comment. 11 rows in RFC 3501 §9 are of this shape.

```
req_1da61e780344fb0a   RFC 4120 §5.2.5   OPTIONAL   complete   flags=[]
exact_text = "-- NOTE: HostAddresses is always used as an OPTIONAL field and -- should not be empty."
```

An **ASN.1 comment** (`--`), emitted as a requirement. The identical text is emitted twice
(`req_825ef1ff858c1a5e`, RFC 4120 §11) because RFC 4120 really does print the module twice —
see F12, where that one turns out to be genuine.

```
req_56a77acd0b668b8b   RFC 5280   MUST   complete   flags=["in_appendix"]
exact_text = "-- Implementations that recognize additional policy qualifiers MUST
              -- augment the following definition for PolicyQualifierInfo"
```

**Query.**

```sql
SELECT r.id, r.rfc, r.term, r.strength, r.parse_status, b.kind, substr(r.exact_text,1,80)
FROM requirements r JOIN blocks b ON b.snapshot_id=r.snapshot_id AND b.id=r.block_id
WHERE r.exact_text LIKE '%::=%' OR r.exact_text LIKE '--%' OR r.exact_text LIKE '%; %'
   OR b.kind='preformatted';
```

**Severity: critical.** A caller generating an ASN.1-conformant implementation from these rows
writes `"OPTIONAL"` into a requirements register against an ASN.1 field marker.

---

## F9 — The wrong section

`requirements.section_id` always equals `blocks.section_id` (**0 mismatches** in 12 209 rows) and
always contains the row (**0 rows outside their section span**). The defect is one level up: the
**section table itself** contains fabricated sections, and 77 requirement rows inherit them.

**152 sections across 23 RFCs have a `number` that is not a section number at all** — a table
header, a page header/footer, an ASCII-art row, or a protocol data line.

| row id                             | rfc  | section reported                                                           | what that string is                                                      |
| ---------------------------------- | ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `req_497d353abc941e3e` and 39 more | 1812 | `Name    Active  Passive Description`                                      | an EGP state-table column header (raw L9259)                             |
| `req_eebb38cad72e37c1` and 36 more | 2828 | `Phase / Explanation`                                                      | a column header of a table whose rows are items 1–6 (raw L6294)          |
| —                                  | 3988 | `LSR  \|  Link  \|  Hop MTU  \|  Recvd MTU  \|  LSP MTU` … 14 variants     | Path-MTU table rows (raw L288–319)                                       |
| —                                  | 1350 | `RFC 1350                    TFTP Revision 2                    July 1992` | a page header (raw L175)                                                 |
| —                                  | 3261 | `* a=rtpmap:0 PCMU/8000                                *`                  | an SDP example line (raw L11529)                                         |
| —                                  | 876  | `115`, `121`, `162`, `283`, `285`, `483`                                   | host counts in survey prose; **RFC 876 has no numbered sections at all** |

RFC 2828 is the worst case: §3 "Definitions" runs L322–6292, and the parser starts a new
"section" at L6294 that runs to L11003 — 4 700 lines, to the end of the document. **37 of
RFC 2828's 104 requirement rows report `section: "Phase / Explanation"`.**

```
req_eebb38cad72e37c1   RFC 2828   section = "Phase / Explanation"   SHOULD NOT   complete   flags=[]
exact_text = "(D) ISDs SHOULD NOT use this term as a synonym for \"cryptographic hash\"."
```

**And the inverse failure: a real section that swallows its successors.**

```
RFC 1812  sec_5288de2ac587e823791036c0
  number "11"  title "REFERENCES"  line_start 7435  line_end 9257
```

Raw text: `11. REFERENCES` is at L7433, and the next real heading is
`APPENDIX A. REQUIREMENTS FOR SOURCE-ROUTING HOSTS` at L8071, then B (8139), C (8468), D (8578),
E (8648), F (9141). The parser detected **none** of them, so §11 spans 822 lines and contains
Appendices A–F. Because the section kind is `references`, the extractor skips it: **every
requirement in RFC 1812 Appendices A–F is silently absent** — a loss caused by a wrong section
row. (0 requirement rows are attributed to §11, so no _emitted_ row is mislabelled here; the
damage is to the outline and to recall.)

The same shape, smaller:

```
RFC 959  sec "8" "CONNECTION ESTABLISHMENT"  L3356-3880  swallows "APPENDIX I -  PAGE STRUCTURE" (L3370)
RFC 791  sec "3.3" "Interfaces"              L2046-2831  swallows "APPENDIX A:  Examples & Scenarios" (L2186)
```

**Query.**

```sql
SELECT s.rfc, s.number, s.title, s.line_start, s.line_end, count(r.id) AS rows
FROM sections s LEFT JOIN requirements r
  ON r.snapshot_id=s.snapshot_id AND r.section_id=s.id
WHERE s.number <> ''
  AND s.number NOT GLOB '[0-9]*'
  AND s.number NOT GLOB 'Appendix *'
  AND s.number NOT GLOB 'ABSTRACT' AND s.number NOT GLOB 'Copyright*'
GROUP BY s.id ORDER BY rows DESC, s.rfc;
```

**Severity: high** (a caller keys a requirement on `(rfc, section)`; 77 rows key on a string that
is not a section, and RFC 2828's outline is unusable past L6292).

---

## F10 — `shape: "demand"` where no obligation exists

**Measurement on 9 596 candidate rows across 166 pinned RFCs** (built from the running
`dist`, i.e. the two-argument classifier described in the header). Distribution:
`demand 8 397 / description 749 / list_introducer 198 / indeterminate 252`. The filter the tool
tells callers is the obligation set is `role=modal AND shape=demand`; **246 rows** match it with
an **upper-case** keyword.

The running classifier is `if (VERB_FORMS.has(word)) return "demand"` over the words of the
clause **after** the keyword. It never looks left. So any sentence containing a verb anywhere
after the keyword is `demand`. The adversarial cases:

**The corpus-level property nobody checked: what the tool does on BCP 14 itself.**

**110 candidate rows in 109 distinct RFCs are the BCP 14 boilerplate sentence, and every one of
them is `shape: "demand"`, `role: "modal"`, `keyword_case: "upper"`.**

```
cnd_793b479b06a4e7c2   RFC 2119   kw=MUST   role=modal  shape=demand  keyword_case=upper
exact_text = "The key words \"MUST\", \"MUST NOT\", \"REQUIRED\", \"SHALL\", \"SHALL NOT\",
              \"SHOULD\", \"SHOULD NOT\", \"RECOMMENDED\", \"MAY\", and \"OPTIONAL\" in this
              document are to be interpreted as described in RFC 2119."
keywords    = [MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, OPTIONAL]
              each with role=modal, shape=demand
```

The same for **RFC 8174** (`cnd_*`, all eleven keywords `modal/demand`), and for 107 other
documents (RFC 2308, 2487, 2821, 2865, 3110, 3207, 3225, 3261, 3335, 3403, 3501, 3597, 3987,
3988, 4034, 4035, 4045, 4120, 4271, 4330, 4343, 4511, 4636, 4649, 4764, 5155, 5246, 5280, 5282,
5689, 5780, 5936, 6066, 6265, 6302, 6455, 6648, 6672, 6698, 6761, 6762, 6891, 7230–7235, 7411,
7540, 7638, 7671, 7830, 7838, 7858, 7871, 7873, 7874, 7919, 7929, 8020, 8078, 8174, 8252, 8445,
8446, 8447, 8449, 8470, 8484, 8490, 8610, 8659, 8767, 8833, 8894, 8902, 8914, 8949, 8959, 9000,
9001, 9002, 9110–9114, 9117, 9118, 9197, 9205, 9221, 9293, 9407, 9422, 9439, 9458, 9460–9463,
9472, 9520, 9552, 9606, 9651, 9999).

The sentence is a _meta-statement about the document's own key words_, and every keyword in it is
inside quotation marks. It states no obligation on anyone. A caller applying the documented
filter gets it.

**Copyright boilerplate as a demand — 40 rows in 20 RFCs.**

```
cnd_610fd83027c7c144   RFC 2308   role=modal  shape=demand
exact_text = "However, this document itself may not be modified in any way, such as by removing
              the copyright notice or references to the Internet Society or other entities."
cnd_fba7d250e860aaaa   RFC 2308   role=modal  shape=demand
exact_text = "This document and translations of it may be copied and furnished to others, and
              derivative works that comment on or otherwise explain it or assist in its
              implementation may be prepared, copied, published and distributed …"
```

A legal term, offered to a caller as a protocol obligation, in RFCs 2300, 2308, 2328, 2487, 2606,
2615, 2821, 2845, 2865, 3110, 3129, 3207, 3225, 3226, 3229, 3261, 3335, 3403, 3501, 3597.

**RFC 2119's and RFC 2181's own definitions of the key words, as demands.**

```
cnd_a98c04917cfe992e   RFC 2119   must/modal/demand
  "Imperatives of the type defined in this memo must be used with care and sparingly."
cnd_ace625b4f30d701b   RFC 2119   may/modal/demand
  "The effects on security of not implementing a MUST or SHOULD, or doing something the
   specification says MUST NOT or SHOULD NOT be done may be very subtle."
cnd_44ffb111a54011a8   RFC 2181   should/modal/demand, must/modal/demand
  "Anywhere that this memo suggests that some action should be carried out, or must be carried
   out, or that some behaviour is acceptable, or not, that is, that some action is considered
   \"Recommended\", is …"
cnd_9c64719f828abd5a   RFC 2181   may/modal/demand
  "It is not believed that anything in this document adds to any security issues that may exist
   with the DNS …"
```

`cnd_9c64719f828abd5a` is a negated belief about the protocol. It is `demand`.

**Structural absence: the clause after the keyword is the only evidence used.**

```
cnd_5a91eea5ef4c3918   RFC 1122   should/modal/demand
  "This document should also be read in conjunction with \"Requirements for Internet
   Gateways\" [INTRO:2]."
cnd_6e4d6b03d6ec9472   RFC 1122   must/modal/demand
  "However, the specifications of this document must be followed to meet the general goal …"
cnd_cea53a99b384ef07   RFC 1122   must/modal/demand
  "This document does not define the order in which a receiver must process multiple options
   in the same IP header."
cnd_5df94460…           RFC 1122
  "Imperatives of the type defined in this memo …"      (above)
```

**117 rows whose grammatical subject is literally the document, memo, draft, section or RFC.**

**Reports a property of the protocol, modal used existentially — 25 rows.**

```
cnd_4c52f468c21c8692   RFC 1122   may/modal/demand
  "A packet may be a complete IP datagram or a fragment of an IP datagram."
cnd_3b754c7e24381de0   RFC 2328   may/modal/demand
  "The set of paths to use for a destination may vary based on the OSPF area to which the
   paths belong."
cnd_8490a3b…            RFC 8490   may/modal/demand
  "The port number may be omitted, and assumed to have some default value."
```

**212 rows open with a commentary/observation frame** (`Note that`, `In practice`, `It is not
believed…`, `Of course`, `That is`, `For example`) and are `demand`:

```
cnd_f3194772eeef9061   RFC 1034   may/modal ×2
  "Note that the \"cuts\" in the name space may be in different places for different classes,
   the name servers may be different, etc."
cnd_9eed4cec9eee9669   RFC 1122   required/modal/demand
  "Great care and clever coding are often required and advisable to make the checksumming
   code \"blazing fast\"."
```

**128 rows carry a BCP 14 keyword inside quotation marks; 122 of them are `demand`/`modal`.**
**1 291 rows carry more than one keyword; 1 216 are `demand`** — including
`cnd_21957f36804e4b35` (RFC 1034): `"Implementation of this service is optional in a name
server, but all name servers must at least be able to understand an inverse query message"`,
where `optional` is an English predicate adjective and is classified `role: modal, shape: demand`.

**Query** (the classifier is not in SQL; this is the shape of the evidence):

```js
// dist/analysis/normative.js:438
export function classifyRequirementShape(clause, keyword = "") {
  const trimmed = clause.trim();
  if (trimmed === "") return "indeterminate";
  if (/:\s*$/u.test(trimmed)) return "list_introducer";
  const words = trimmed.toLowerCase().match(/[A-Za-z']+/gu);
  if (!words || words.length === 0) return "indeterminate";
  const skip = new Set(keyword.toLowerCase().split(/\s+/u).filter(Boolean));
  for (const word of words) {
    if (skip.has(word)) continue;
    if (VERB_FORMS.has(word)) return "demand";
  }
  return "description";
}
```

```sql
-- corroborating count, from the caller surface
SELECT rfc, count(*) FROM mentions WHERE term='MUST' GROUP BY rfc;  -- then inspect non_strict_candidates
```

**Severity: critical.** The `shape` field is the only disambiguation the tool offers for
candidates, it is documented as "the specification's own criterion", and on the sentence the
criterion was written for it returns the wrong answer.

---

## F11 — `exact_text` is not a sentence

| shape                                                        | rows    | of which `parse_status: complete` |
| ------------------------------------------------------------ | ------- | --------------------------------- |
| opens with a list marker (`o `, `* `, `1) `, `a. `)          | **342** | **295**                           |
| opens with `NOTE:` / `Note:`                                 | 20      | —                                 |
| opens with a bare section label (`DISCUSSION`, `SUMMARY`, …) | 3       | 2                                 |
| is an ASN.1 module (`::=`)                                   | 10      | 6                                 |
| is a code comment (`--`, `;`)                                | 6       | 6                                 |

**The list-marker case is the volume problem, and the flag does not cover it.**
`list_marker_stripped_from_clause` means the marker was stripped from the **`clause` object**;
it is still in `exact_text`, which is the field the row cites and the field a caller quotes.

```
req_3197f65a49b5ad03   RFC 1122 §3.2.1.8   MUST   complete   confidence=0.9
flags = ["list_marker_stripped_from_clause"]
exact_text = "o The originating host MUST record a timestamp in a Timestamp option whose
              Internet address fields are not pre-specified or whose …"
clause.actor = "The originating host"     <-- marker stripped here
```

The row's `exact_text` is a list item, not a sentence, and the row is presented as a complete
statement. Worst concentrations: RFC 1812 (73), RFC 2616 (36), RFC 3261 (26), RFC 4271 (23),
RFC 8446 (23).

**Headings emitted as requirements.**

```
req_405b76be962eba10   RFC 1812 §8.5 "Saving Changes"   MAY   partial   confidence=0.7
exact_text = "DISCUSSION Reasons why this requirement is a MAY:"
clause     = { actor: "Reasons why this requirement is a", action: "" }
```

A _heading_ is the `exact_text` of a requirement row. The `term` is `MAY` and `strength` is
`optional`, taken from the heading's own text.

```
req_567105bfb1b28c6d   RFC 1812   SHOULD   complete   flags=[]
exact_text = "DISCUSSION Rule 3 is optional in that Section [5.3.2] says that a router only
              SHOULD consider TOS when making routing decisions."
```

Commentary _about_ another rule, emitted as that rule.

```
req_ed58c11c9fdba6ae   RFC 5689   MUST   complete   flags=[]
exact_text = "Purpose: (precondition) -- The server MUST support the specified resourcetype …"
```

**Query.**

```sql
SELECT id, rfc, term, parse_status, flags_json, substr(exact_text,1,90) FROM requirements
WHERE exact_text GLOB 'o *' OR exact_text GLOB '* *' OR exact_text GLOB '[0-9]) *'
   OR exact_text GLOB 'Note: *' OR exact_text GLOB 'NOTE: *'
   OR exact_text GLOB 'DISCUSSION*' OR exact_text GLOB '--*';
```

**Severity: high** for the 295 `complete` list items (a caller quoting `exact_text` reproduces
RFC typography that is not a sentence, and cannot tell item (c) from item (d)); **medium** for
the 3 headings.

---

## F12 — Duplicates: CLEAN

**Within-document duplicate `exact_text`: 160 groups, 423 rows, 3.5 % of all rows.**

Adjudication of **all 160 groups** (not a sample of 40): for each group, count literal
occurrences of the whitespace-normalised sentence in the whitespace-normalised document and
compare with the number of rows.

```
genuinely repeated by the RFC (occurrences in the text >= rows): 160
fewer occurrences than rows:                                   0
not present in the text at all:                                0
```

**This class comes back empty.** Every duplicate `exact_text` is backed by that many literal
occurrences in the source document. The RFC 2865 example in the brief generalises:

```
RFC 1122 §3.2.1.3   4 rows, all exact_text = "It MUST NOT be used as a source address."
                    raw L1750 (c) { -1,-1 }, L1759 (d), L1764 (e), L1779 (f) — genuine
RFC 1812 §4.2.2.11 2 rows, same text — genuine (address classes (c) and (d))
RFC 9000 §17.2     3 sentences x 2 rows — genuine: the text repeats verbatim for
                    "Destination Connection ID Length" and "Source Connection ID Length"
RFC 4120 §5.2.5 / §11   "-- NOTE: HostAddresses is always used as an OPTIONAL field …"
                    — genuine: RFC 4120 prints the ASN.1 module twice
RFC 2828 §"Phase / Explanation"   3 rows, same text — genuine (raw L5819, L6964, L9023),
                    but attributed to a fabricated section (F9)
```

**The residual defect is not fabrication but indistinguishability.** The four RFC 1122 rows have
identical `exact_text`, `section`, `term`, `strength`, `polarity`, `parse_status`, `confidence`,
`actor` and `action`, and differ only in `id`, `block_id` and `char_start`. Nothing on the row
identifies _which_ address class the obligation is about, so a caller that de-duplicates by
`exact_text` silently loses three of four distinct obligations, and a caller that does not has
four identical-looking contract lines with no way to order or label them.

```
req_bea1d42626a79f62  req_6063411266de6c40  req_27b423522c437d24  req_dc0bad8d7344fa28
```

**Severity: medium** (no wrong row; a caller-side loss that the row shape invites).

---

## Classes that came back empty, with the query that came back empty

### Class 1 — spans that do not contain their keyword: **0, six independent checks**

```sql
-- all 0 at generation 1980, over 12 209 rows
exact_text does not contain its own `term` (case-sensitive, \b-delimited)          0
raw.slice(char_start, char_end) != exact_text                                     0
raw.slice(char_start, char_end) does not contain `term`                           0
keywords_json[k].char span != k.term  (after whitespace normalisation)            0
requirements.section_id != blocks.section_id                                      0
row span not contained in its block's span                                        0
mentions: span slice != term (after whitespace normalisation)                     0
```

Offset integrity is exact. One cosmetic artefact worth naming so it is not re-found: **104 rows**
have a `keywords_json` span whose slice is `"MUST\n                 NOT"` — the span is correct,
it spans the line wrap inside a two-word keyword. Every one of the 104 is `parse_status: partial`.

### Class 6 — duplicates that are not duplicates: **0 of 160 groups** (see F12).

### RFC 8174 (BCP 14) as a document: **clean**

```
$ node dist/cli.js requirements 8174 --json
total_requirements: 0
mentions: 3, all disposition="definition", all flags carry term_quoted + keyword_enumeration
keyword_usage.stance = "adopts", with the cited sentence and a citation id
non_strict_candidates: total 10, by_reason { non_prose_block: 3 }
```

Every uppercase BCP 14 keyword in RFC 8174 is inside quotation marks (the boilerplate phrase at
raw L130–131 and the `"MUST", "SHOULD", "MAY"` mention at L89–90) — 24 occurrences, none
promoted. `total_requirements: 0` is correct and explicable. The ten candidates are the
boilerplate block, correctly held out as `non_prose_block` — but note that they still carry
`shape: "demand"` (F10), so the _count_ is right and the _classification_ is not.

### RFC 2119 as a document: **the count is defensible, 3 of 3 rows are meta-text**

`total_requirements: 3`. Two are illustrative examples quoted inside the Abstract
(`flags: ["in_front_matter"]`); one is RFC 2119 §6's own advice about its key words
(`flags: []`, `actor: "they"`). The `mentions` table classifies 14 of RFC 2119's 17 occurrences
as `disposition: "definition"`, and the flag vocabulary contains
`requirements_notation_section` — but that flag is applied to **mentions only**; it is not
applied to any of the 3 `requirements` rows. The two mechanisms disagree about the same three
sentences in the same document.

---

## Summary

Counts are corpus-wide at `index_generation = 1980` (182 snapshots, 12 209 requirement rows,
9 596 candidate rows over 166 pinned RFCs). "Rows" = rows a caller can receive.

| #   | class                                                                                                        | rows corpus-wide                                                                                                             | worst example                                                                                                                 | severity     |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------ |
| F1  | `parse_status: "complete"` on a sentence tail / incomplete span, `flags: []`                                 | **486** unflagged (765 complete-but-incomplete)                                                                              | `req_de54507f34aee5bf` RFC 1122 §3.3.5 — `"containing a Timestamp Option MUST add the current timestamp…"`                    | **critical** |
| F2  | First half of a page-break-split sentence, `complete`, `flags: []`                                           | **92** unflagged (129 total)                                                                                                 | `req_9181039dba52a121` RFC 8470 §6.1 — `"…SHOULD either delay forwarding the"`                                                | **critical** |
| F3  | `condition` invented from an unbalanced bracket, on an unconditional requirement                             | **7**                                                                                                                        | `req_73abf469306444f8` RFC 1812 §5.2.7.2 — `condition: "A router using a routing protocol ("`, `actor: "static routes)"`      | **critical** |
| F4  | `condition` = a discourse marker or a truncated main clause                                                  | **45**                                                                                                                       | `req_462de6c1ddf873f6` RFC 1812 §1.1.3 — `condition: "Likewise, routers may provide,"`, `action: "or MUST NOT requirements."` | high         |
| F5  | Real condition in the previous sentence/block; `condition: null`, row reads unconditional                    | **203**                                                                                                                      | `req_ecce0f28df050721` RFC 1812 §4.2.2.11 — `"Otherwise, the router MUST discard it."`                                        | **critical** |
| F6  | `clause.actor` is not a noun phrase (ends in a copula/preposition, starts with a preposition, is `"It is"`)  | **524** (248 + 235 + 104 subsets; 752 bare pronouns)                                                                         | `req_c1d490dcf2ec069d` RFC 1122 §4.2.2.3 — `actor: "It is"`, real subject `implementations` is in `action`                    | **critical** |
| F7  | Descriptive statement emitted as a normative `OPTIONAL`/`REQUIRED`, with no `shape` on the requirements path | 65 `OPTIONAL` + 59 `REQUIRED`; 83 keyword-final                                                                              | `req_4cb7b965d5d269cd` RFC 9110 §9.1 — `"All other methods are OPTIONAL."`, `action: "."`                                     | **critical** |
| F8  | Code / ABNF / ASN.1 emitted as requirements (`OPTIONAL` = ASN.1 marker)                                      | **16+**                                                                                                                      | `req_7498452cdd762788` RFC 5280 App. A — `ORAddress ::= SEQUENCE { … OPTIONAL }` as an `optional`-strength requirement        | **critical** |
| F9  | Row attached to a section number that is not a section (table header, page header, code line)                | **77 rows** in **152 fabricated sections** across 23 RFCs                                                                    | `req_eebb38cad72e37c1` RFC 2828 — `section: "Phase / Explanation"`, 37 rows; plus RFC 1812 §11 swallowing Appendices A–F      | high         |
| F10 | `shape: "demand"` where no obligation exists                                                                 | **110** BCP-14 boilerplate rows / 109 RFCs; 40 copyright; 117 document-as-subject; 25 element-subject; 212 commentary frames | `cnd_793b479b06a4e7c2` **RFC 2119 itself** — the `"MUST" … "OPTIONAL"` enumeration, all eleven keywords `modal/demand/upper`  | **critical** |
| F11 | `exact_text` is not a sentence (list item, heading, code comment, ASN.1 module)                              | **342** list items (**295** `complete`) + 3 headings + 6 comments + 10 ASN.1                                                 | `req_405b76be962eba10` RFC 1812 §8.5 — `exact_text = "DISCUSSION Reasons why this requirement is a MAY:"`                     | high         |
| F12 | Duplicates that are not duplicates                                                                           | **0** of 160 groups; 423 rows in genuine duplicate groups (3.5 %)                                                            | RFC 1122 §3.2.1.3 — 4 identical rows, no field distinguishes address classes (c)/(d)/(e)/(f)                                  | medium       |
| —   | Class 1: spans that do not contain their keyword                                                             | **0** (six checks)                                                                                                           | —                                                                                                                             | clean        |
| —   | RFC 8174 (BCP 14) as a document                                                                              | **0** requirements, 3 mentions all `definition`                                                                              | —                                                                                                                             | clean        |
