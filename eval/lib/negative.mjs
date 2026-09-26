// Negative probes: statements the extractor must NOT put in a compliance list.
//
// A benchmark where a 3-line grep scores 100% has no floor to measure against, and
// precision on the positive set cannot supply one either: the positive set asks only
// "did you find the statements", and a grep finds every statement. The number that
// separates a real extractor from a grep is the one that asks "what did you put in the
// list that should not be there", and the bench did not have it.
//
// THE POPULATION IS GENERATED, NEVER HAND-PICKED. Every rule below is a published
// mechanism test over text the extractor never sees at labelling time - the same rule
// `labelling.mjs` uses to cut positive probes, applied to a different property. A
// hand-picked negative is a negative the person chose while reading the tool's output,
// and it drifts toward sentences the tool already rejects. So: no hand-picking, and the
// label IS the mechanism. A sentence is in the set because a named regex fired on it,
// which means a reader can re-derive the set from the corpus without trusting anyone.
//
// WHAT IS DELIBERATELY NOT HERE, because labelling it would need the judgement this file
// refuses to make by hand:
//
//   * An upper-case descriptive modal. "The length MAY be zero in the encoding table" is
//     the single most common false positive in RFC 2119 and the most valuable negative.
//     Telling a deontic modal from a descriptive one is a grammatical judgement, and the
//     only mechanism available for it is the extractor's own `shape: demand` - which is
//     the claim under test. Labelling with it would make the check circular. UNMEASURED.
//   * Any sentence whose norm is a substring of a positive probe. A negative that also
//     appears in the positive set would be scored twice, in both directions, and the
//     guard that removes it is counted and reported rather than applied silently.
//
// The `pools` field says which list the sentence must not appear in, and why that list
// and not the other. A modal-free sentence is a legitimate obligation - the golden set's
// own `keyword-free-spec` class says so, and the tool scores 0/13 on it - so it is
// forbidden from the STRICT list only. Quoting a keyword is forbidden from both: it is
// never a requirement and never a candidate.

import { candidates, labelTier, norm, upperKeyword } from "./labelling.mjs";

/** Modal token, any case. A sentence with none of these cannot have been keyword-selected. */
const MODAL_CI = /\b(?:must|shall|should|may|required|recommended|optional|can|could|will|would)\b/iu;

/** An RFC 2119/8174 keyword, case-sensitive: only the upper case carries force. */
const KW_UPPER =
  /\b(?:MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)\b/u;

const PROSE_KINDS = new Set(["paragraph", "list_item"]);

/** A sentence too short to be a statement is furniture whatever it contains. */
const MIN_NEGATIVE_CHARS = 45;

const sentencesOf = (text) => candidates(text).map((c) => c.exact);

/**
 * The negative classes, in descending order of how well each separates a real extractor
 * from a grep. `meta_language` and `descriptive_modal` are the two a keyword grep cannot
 * survive; `no_modal` is nearly free for both and is reported for completeness.
 */
export const NEGATIVE_CLASSES = [
  {
    class: "meta_language",
    why: "The document discussing its own requirement language. RFC 2119 and RFC 8174 are made of these sentences, an implementation has nothing to do with any of them, and a grep for MUST/MAY emits every one of them.",
    pools: ["strict", "candidates"],
    generators: [
      {
        name: "quoted_keyword",
        why: 'A keyword inside quotation marks is being NAMED, not used: the words "MUST" and "MUST NOT" in the RFC 2119 boilerplate are the most modal-saturated sentences in the corpus.',
        test: (s) =>
          /["\u201c\u201d'](?:MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)["\u201c\u201d']/u.test(
            s,
          ),
      },
      {
        name: "about_the_language",
        why: "A definitional sentence about the requirement language, however it is phrased: a sentence that OPENS with 'the key words' / 'the terms', or one that says a word is 'to be interpreted'. It states nothing about an implementation, and a keyword scan selects it because it is saturated with keywords. Deliberately NOT keyed on mentioning RFC 2119: 'A conforming implementation MUST follow RFC 2119 section 3' is a real obligation that names the RFC, and a mechanism that caught it would be labelling a requirement as a non-requirement.",
        test: (s) =>
          /^(?:the\s+)?(?:key\s*words?|terms?|words?|phrases?)\b/iu.test(s) ||
          /\b(?:are|is|are to be)\s+to\s+be\s+interpreted\b/iu.test(s),
      },
    ],
  },
  {
    class: "descriptive_modal",
    why: "A modal reporting a property of the protocol, a possibility, or a courtesy. No actor is obliged. A grep emits every one of them and this build's own miss review says 51 of 131 reviewed false positives are exactly this.",
    pools: ["strict", "candidates"],
    // Only the lower-case forms are labelled. A sentence carrying an upper-case keyword is
    // deontic by RFC 8174's own definition and the bench has no mechanism to argue with
    // that, so it is left out of this class rather than guessed into it.
    gate: (s) => !KW_UPPER.test(s),
    gateWhy:
      "an upper-case keyword makes the sentence deontic by definition, and an upper-case descriptive modal is the population this set cannot label without a judgement",
    generators: [
      {
        name: "relative_clause_modal",
        why: 'A modal inside a relative clause modifies the noun, not an actor: "parameters which may be in place".',
        test: (s) =>
          /\b(?:which|that|whose)\b[^.;:]{0,100}\b(?:can|could|may|might|must|will|would|should)\b/iu.test(s),
      },
      {
        name: "possibility_or_courtesy",
        why: 'Possibility and courtesy reported as such: "it is possible that", "there is no need to", "it would be advisable to".',
        test: (s) =>
          /\b(?:it is (?:possible|likely|unlikely|conceivable)|there (?:is|are) no need to|it (?:is|would be) (?:advisable|desirable|beneficial|preferable|helpful|worthwhile) to|the reader may wish|it may be (?:useful|helpful|advantageous|helpful to)|please|kindly)\b/iu.test(
            s,
          ),
      },
      {
        name: "consequence_reporting",
        why: 'A finite clause reporting what the protocol does, with the subject being the protocol rather than an implementer: "this may cause a loop", "it will fail if the length is zero".',
        test: (s) =>
          /^(?:this|it|the|such)\b[^.;:]{0,60}\b(?:may|might|could|will)\s+(?:be|cause|result|lead|occur|fail|work|appear|take|apply|require|seem|tend)\b/iu.test(
            s,
          ),
      },
    ],
  },
  {
    class: "nonprose_block",
    why: "Normative-looking text inside a table, a figure or a bibliography entry. The project's own next-wave design states the rule this class checks: a caller who asks for requirements must never receive a field-table row by accident.",
    pools: ["strict", "candidates"],
    fromBlocks: true,
    kinds: ["table", "figure", "reference_entry"],
    generators: [
      {
        name: "keyword_in_non_prose_block",
        why: "The block carries an upper-case RFC 2119 keyword and is not prose, so a block-classifying extractor can leave it alone and this class is free for it. An extractor that scans raw text cannot.",
        test: (s) => KW_UPPER.test(s),
      },
    ],
  },
  {
    class: "preformatted_block",
    why: "Keyword-bearing text inside a preformatted block, reported SEPARATELY and not folded into the must-not headline, because the rule is genuinely contested here. The next-wave design counts 292 preformatted blocks carrying an upper-case keyword as a real, acknowledged loss and plans a separate notation channel for them - so a preformatted keyword sentence missing from the prose list is a gap, not a defect. But RFC 1122 indents its body text at column 12 and is therefore typed preformatted wholesale, and the tool emitting its obligations is right there. Both readings are defensible, so the number is reported and neither is asserted.",
    pools: ["strict", "candidates"],
    fromBlocks: true,
    kinds: ["preformatted"],
    contested: true,
    generators: [
      {
        name: "keyword_in_preformatted_block",
        why: "The preformatted half of the non-prose class, split out because the verdict differs. RFC 1122's indent is the worked example: a document whose every body paragraph is typed preformatted, whose sentences are real obligations, and which the tool emits - correctly, and which a strict 'never scan a non-prose block' rule would mark as a false positive.",
        test: (s) => KW_UPPER.test(s),
      },
    ],
  },
  {
    class: "no_modal",
    why: "A sentence with no modal at all. It must not appear in the strict list: RFC 8174 gives force to the upper-case keywords and to nothing else, and this build has no declarative channel, so a modal-free sentence in `requirements[]` is a keyword test that fired for another reason.",
    pools: ["strict"],
    // A modal-free bound IS an obligation the project wants recorded - that is what the
    // golden set's `keyword-free-spec` class is - so the sentence is not forbidden from
    // existing, only from the strict list. The tool scores 0/13 on that class, and this
    // is the other half of that number: it must not have solved it by inventing a
    // requirement instead.
    fromBlocks: true,
    kinds: ["paragraph", "list_item"],
    generators: [
      {
        name: "no_modal_token",
        why: "No modal token in any case, in a prose block, long enough to be a statement. The only mechanism that can have emitted it is a section-wide scan.",
        test: (s) => !MODAL_CI.test(s),
      },
    ],
  },
];

/** Classes whose verdict a keyword grep cannot survive, and the ones that nearly every extractor passes. */
export const DISCRIMINATING_CLASSES = ["meta_language", "descriptive_modal"];
/**
 * Build the negative set for one protocol's sections.
 *
 * `sections` is `[{ section, text, blocks }]`. Blocks are used for the structural classes
 * because "inside a table" is a property of the parser's view, not of the text: the same
 * characters are prose in one block and a table row in the next, and only the block kind
 * knows which.
 */
export function negativeProbes(sections, { strictProbes = new Set(), cap = 40 } = {}) {
  const out = [];
  const perClass = new Map();
  const collisions = [];
  for (const s of sections) {
    for (const cls of NEGATIVE_CLASSES) {
      const source = cls.fromBlocks
        ? (s.blocks ?? []).filter((b) => cls.kinds.includes(b.kind))
        : [{ kind: "paragraph", text: s.text }];
      for (const block of source) {
        for (const sentence of sentencesOf(block.text)) {
          if (sentence.length < MIN_NEGATIVE_CHARS) continue;
          if (cls.gate && !cls.gate(sentence)) continue;
          const name = cls.generators.find((g) => g.test(sentence))?.name;
          if (!name) continue;
          if (strictProbes.has(norm(sentence))) {
            collisions.push({ rfc: s.rfc, section: s.section, class: cls.class, text: sentence });
            continue;
          }
          const key = `${cls.class}|${name}`;
          const seen = perClass.get(key) ?? 0;
          if (seen >= cap) continue;
          perClass.set(key, seen + 1);
          out.push({
            rfc: s.rfc,
            section: s.section,
            class: cls.class,
            generator: name,
            pools: cls.pools,
            block_kind: block.kind,
            tier_if_kept: labelTier(sentence),
            keyword: upperKeyword(sentence),
            text: sentence,
          });
        }
      }
    }
  }
  return { probes: out, collisions };
}

/** Classes and generators, with what each produced. A class that produced nothing is a finding. */
export function negativeCensus(probes) {
  const out = {};
  for (const p of probes) {
    const key = `${p.class}/${p.generator}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
