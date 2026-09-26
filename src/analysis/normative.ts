/**
 * RFC 2119 / RFC 8174 normative language extraction.
 *
 * Contract, in order of precedence:
 *  1. only the eleven RFC 2119 keywords are recognized, in upper case, as
 *     required by RFC 8174 §3 ("MUST" only has an effect when it is
 *     capitalized);
 *  2. the longest phrase wins, so "MUST NOT" is never split into "MUST" + "NOT";
 *  3. a keyword inside a quoted definition or inside a non-prose block is
 *     recorded as a mention but never promoted to a requirement;
 *  4. every requirement keeps the exact sentence, the section and block it came
 *     from, a citation id, and an explicit parse status. Nothing is inferred
 *     silently: a missing actor yields `partial`, not a fabricated one.
 */

import type {
  Block,
  DeclarativeBasis,
  DeclarativeSpecification,
  NormativeCandidate,
  NormativeCandidateAnalysis,
  NormativeMention,
  Requirement,
  RequirementShape,
  Section,
  Span,
} from "../core/types.js";
import { NORMATIVE_TERMS, type NormativePolarity, type NormativeStrength, type NormativeTerm } from "../core/types.js";
import { citationId, quoteHash } from "./citation.js";

export interface NormativeAnalysis {
  readonly mentions: readonly NormativeMention[];
  readonly requirements: readonly Requirement[];
  readonly coverage: {
    readonly blocks_scanned: number;
    readonly blocks_skipped: number;
    /** Why each skipped block was skipped, as `kind` or `section:<kind>`. */
    readonly blocks_skipped_by_kind: Readonly<Record<string, number>>;
    /**
     * How many of the skipped blocks carry an RFC 2119 keyword.
     *
     * This is the loss made visible. Tables, figures and preformatted text are out of
     * scope by design, and a specification that states its rules in a field table will
     * report a low count; that is a known gap and not an absence, and a caller can only
     * act on the difference if the number is on the response. Corpus-wide it is 278
     * blocks.
     */
    readonly keyword_bearing_blocks_skipped: number;
    readonly sentences_scanned: number;
    readonly mentions_found: number;
    readonly requirements_emitted: number;
  };
  readonly warnings: readonly string[];
}

/**
 * The phrase alternation, longest first so `MUST NOT` is never split into `MUST` + `NOT`,
 * and with the space between the words allowed to be a line break - RFC text is
 * hard-wrapped, so `MUST NOT` is often printed as `MUST` at the end of one line and `NOT`
 * at the start of the next.
 */
const TERM_PATTERN = new RegExp(
  `\\b(${Object.keys(NORMATIVE_TERMS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/ /gu, "\\s+"))
    .join("|")})\\b`,
  "gu",
);

/**
 * A `not` that negates a normative keyword without being part of the printed phrase.
 *
 * Measured: 16 requirement rows stated the OPPOSITE of their own sentence, at
 * `confidence: 0.9` and with no flag. `req_76dcffb7c47de7e6` reads "A registrar MUST not
 * generate 6xx responses." and was reported as MUST / **positive**, which instructs a
 * contract to require the registrar to generate them. The cause is a fallthrough: the
 * phrase alternation is case-sensitive and needs the words in the printed order, so a bare
 * `MUST` followed by a lower-case `not` matched the positive term and the polarity test
 * never ran. RFC 1812 §3.3.2 has the same shape.
 *
 * RFC 2119 §3 is explicit that the negation is part of the construct and must be in the
 * same case, so this sentence is not strictly well-formed. The choice here is between two
 * wrong answers, and only one of them is dangerous: reporting it `positive` asserts the
 * opposite of what the author wrote, while reporting it `negative` with
 * `negation_case_not_upper` records the author's mistake and still refuses to invert the
 * requirement. A caller who wants strict case conformance filters on the flag and sees the
 * deviation; a caller who wants the meaning sees the prohibition. The span keeps covering
 * the keyword alone, so the citation is of the word that was actually upper case.
 *
 * The window is one word, across any whitespace including a line break, and stops at any
 * punctuation that would end the clause - so "MUST, not because it is optional" and
 * "MUST be set" are both left alone. `NOT REQUIRED` and `NOT RECOMMENDED` are two-part
 * phrases already in the vocabulary and are unaffected.
 */
const NEGATION_FOLLOWING = /^[ \t\r\n\f]*(not|no)\b/iu;
const CLAUSE_BREAK_BEFORE_NOT = /^[,;:.)\]}"']/u;

function isFollowedByNegation(text: string, index: number, term: string): boolean {
  const after = text.slice(index + term.length);
  // A comma or a full stop between the keyword and the `not` means the `not` opens the next
  // clause and negates something else. "MUST, not because…" is not a prohibition.
  if (CLAUSE_BREAK_BEFORE_NOT.test(after)) return false;
  return NEGATION_FOLLOWING.test(after);
}

/**
 * The same vocabulary, without the global flag, for a yes/no question.
 *
 * `TERM_PATTERN` carries `g`, and a global regex is stateful: `test()` advances
 * `lastIndex`, and `String.prototype.matchAll` copies `lastIndex` into the clone it
 * walks. So one `TERM_PATTERN.test(...)` anywhere - the loss counter below did exactly
 * that - silently moved the starting point of every later sentence scan in the same
 * process and requirements stopped being found. Two tests in this file passed alone and
 * failed together, which is the only shape this bug has.
 */
const TERM_PROBE = new RegExp(TERM_PATTERN.source, "u");

/** `matchAll` over the global pattern, immune to a `lastIndex` left by an earlier `test()`. */
function matchTerms(text: string): RegExpExecArray[] {
  TERM_PATTERN.lastIndex = 0;
  return [...text.matchAll(TERM_PATTERN)];
}

const QUOTED_TERM = new RegExp(`(["'\`]\\s*\\b(?:${Object.keys(NORMATIVE_TERMS).join("|")})\\s*["'\`])`, "iu");
const META_DISCUSSION =
  /\b(?:not implementing|does not implement|implementing a|keywords? (?:for|in)|the specification says|the effects? on)\b/iu;
/**
 * Sentence boundary: terminal punctuation, then layout whitespace, then something
 * that can open a sentence.
 *
 * The separator class must include newlines. RFC text is hard-wrapped at column 72,
 * so a period at the end of a line very often ends a sentence, and a class of spaces
 * and tabs only never reached it: twenty separate statements on twenty consecutive
 * lines came back as one "sentence". That is not cosmetic. `exact_text` is what a
 * caller reads and judges, and the action-verb test scans the clause it is given — a
 * whole paragraph almost always contains a verb, so the paragraph was classified
 * `demand` whatever it actually said. Excluding newlines inflated that bucket with
 * exactly the entries that should not be in it.
 *
 * A line that does *not* end with terminal punctuation still continues into the next
 * one, which is the ordinary case for a wrapped sentence, so the boundary lands in the
 * right place without a parser.
 *
 * Terminal punctuation is not always the last thing on the line. A sentence can end
 * inside a bracket or a quotation, and then the separator class sits behind the
 * closing character, so the boundary never fired: RFC 7719 section 2 writes
 *
 *   (Note that this example might change in the future.) Note that the term "public
 *   suffix" is controversial in the DNS community for many reasons, and may be
 *   significantly changed in the future.
 *
 * and it came back as ONE candidate row. The cost is not cosmetic. The action-verb
 * test reads the clause that follows the keyword, so a row that merges two statements
 * cannot be classified at all - the clause it is handed contains the verb of the
 * second statement - and the merged row is quoted and cited as though the RFC had
 * said it. One closing bracket was enough to do it, so the closers belong to the
 * boundary and the abbreviation veto below is what has to hold the line now.
 */
const SENTENCE_CLOSERS = "()\\]}'\"”’»";
const SENTENCE_BOUNDARY = new RegExp(
  `([.!?])(?:[${SENTENCE_CLOSERS}])*(?:[ \\t]*\\n)+[ \\t]*(?=[A-Z0-9"'(\\[])|([.!?])(?:[${SENTENCE_CLOSERS}])*([ \\t]+)(?=[A-Z0-9"'(\\[])`,
  "gu",
);
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "cf",
  "vs",
  "no",
  "sec",
  "fig",
  "ref",
  "app",
  "vol",
  "al",
  "resp",
  "ca",
  "approx",
  "dr",
  "st",
  "inc",
  "ltd",
]);

/**
 * Trailing closers, stripped before the tail of a fragment is judged.
 *
 * A sentence that ends inside a bracket or a quotation carries them after its full
 * stop, and the abbreviation veto has to see through them or the two halves of the
 * rule disagree: the boundary would split "(e.g. A, B)." from the statement after
 * it while the veto, reading a tail that ends in a bracket, never saw an
 * abbreviation at all.
 */
const TRAILING_CLOSERS = new RegExp(`[${SENTENCE_CLOSERS}]+$`, "u");

/**
 * Two or more full stops at the end of a fragment, however they are spaced.
 *
 * An ellipsis is a deliberate trailing mark and never ends a sentence, so it is
 * protected for the same reason "e.g." is: the period after it belongs to the mark
 * and not to a statement. RFC prose uses both "..." and ". . .", and a list that
 * trails off into one is common enough that a veto that only knew the first spelling
 * would merge the ellipsis with the statement after it.
 */
const TRAILING_ELLIPSIS = /(?:\.\s*){2,}$/u;

const DEFINITION_SECTIONS = /^(?:normative|informative references|keywords? for use|.*requirement levels?)$/iu;

/** Block kinds the extractor reads. Mirrors `PROSE_BLOCK_KINDS` for the store. */
export const PROSE_BLOCK_KINDS: ReadonlySet<string> = new Set(["paragraph", "list_item", "unknown"]);
/** Section kinds the extractor skips outright. */
export const SKIPPED_SECTION_KINDS: ReadonlySet<string> = new Set(["authors", "index", "references"]);

/**
 * RFC 2119 keywords in any capitalisation, longest phrase first.
 *
 * Used only to find what the strict upper-case extractor did *not* promote. A hit
 * here is reported as a candidate with the reason it was skipped, never as a
 * requirement: RFC 8174 §3 makes "must" a plain English word.
 */
const CANDIDATE_KEYWORD = new RegExp(
  `\\b(${Object.keys(NORMATIVE_TERMS)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/ /gu, "\\s+"))
    .join("|")})\\b`,
  "giu",
);
const MAX_CANDIDATES = 500;

/**
 * Constructions in which an RFC 2119 word is an ordinary English word, not a modal.
 *
 * A candidate list is a lead list, not a contract, and the difference matters: a
 * caller who treats "194 candidates" as "194 obligations" will implement the wrong
 * thing. Two of the eleven keywords are also everyday vocabulary in exactly the
 * shape RFC prose uses, and the shapes below are the reliable cases:
 *
 *   "the recommended method for mail routing"   recommended as a participle
 *   "an optional part of the DNS"               optional as an adjective
 *   "many may ask"                               may as a plural noun
 *
 * The patterns are anchored to a determiner, a possessive or a quantifier
 * immediately before the keyword, which is what separates these from a real modal
 * ("a server may omit", "servers must retry"). They are deliberately one-sided: a
 * candidate that is not matched here is still reported, marked `role: "unknown"`.
 * Guessing "this must is a noun" without a parser would trade one silent error for
 * another, which is the failure mode this whole pass exists to remove.
 */
const NON_MODAL: readonly { readonly keyword: string; readonly pattern: RegExp }[] = [
  // Participles and adjectives: a determiner or possessive governs the keyword.
  { keyword: "recommended", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|most|best|widely)\s+$/iu },
  { keyword: "optional", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|as\s+an?)\s+$/iu },
  { keyword: "required", pattern: /\b(?:the|a|an|this|that|these|those|its|their|our|your|as\s+an?)\s+$/iu },
  // Plural noun: "many may ask", "few may object", "some may prefer".
  { keyword: "may", pattern: /\b(?:many|few|some|most|all|one|two|three)\s+$/iu },
];

/**
 * The action-verb test, and the grammatical evidence that goes with it.
 *
 * Only a clause that can state an obligation may be filed `demand`, so the question
 * is not "is this modal strong" but "is anyone being told to do something". Two
 * thirds of that is lexical and lives in the verb lexicon below; the rest is
 * positional, and it is here.
 *
 * The rules this implements are commonly quoted as coming from RFC 2119 section 3.
 * They are not in it. A text search of RFC 2119 and of RFC 8174 for "action verb"
 * returns nothing in either document: RFC 2119 section 3 is the list of keyword
 * definitions, and RFC 8174 section 3 is IANA Considerations. What RFC 2119 does say,
 * in section 6, is that imperatives "must not be used to try to impose a particular
 * method on implementors" and are only for interoperation or for limiting behaviour
 * that can cause harm - which is the reading the predicates below are built on: a
 * modal that reports an observation, sits inside a noun phrase, or addresses the
 * document rather than an implementor is not stating a rule, whatever its mood.
 *
 * `demand` is the only shape that can state an obligation, so a false `demand` is a
 * row in a compliance contract that was never normative. In a hand-checked sample of
 * 190 rows from `analyzeNormativeCandidates`, 35 of the 120 false positives were
 * sentences where the modal is descriptive, and every one of them scanned as a
 * `demand` on the lexicon alone. Each predicate below exists because of a measured
 * row, and each is one-sided: a row it does not catch keeps its old shape and is
 * still in the list, so the cost of a miss is a lead that has to be read and the cost
 * of a wrong hit is a rule that was never there.
 */

/**
 * Any RFC 2119 keyword word, for the two-argument form that is handed a whole
 * statement and has to find the pivot itself.
 *
 * The three adjectives are in the list because "the recommended method for mail
 * routing" is placed by the same evidence as a modal - a governor to the left, a noun
 * to the right - and leaving them out made the two-argument form answer a different
 * question from the three-argument one. `classifyCandidateRole` is what reports them
 * as non-modal; `shape` only has to say that they cannot state an obligation.
 */
const FIRST_KEYWORD_WORD = /\b(?:must|shall|should|may|might|would|can|could|ought|required|recommended|optional)\b/iu;

/**
 * Words that govern a noun phrase, and so can put a modal inside one.
 *
 * "the recommended method for mail routing" and "an optional part of the DNS" are the
 * shapes the RFC Editor's own vocabulary produces: the keyword is a modifier, and the
 * sentence is about the method, not about an implementor. The test needs a word on
 * both sides of the keyword — a governor to the left, something that is not a verb to
 * the right — because a determiner to the left of a real modal ("the server may
 * omit") is the ordinary shape of a rule, and one signal alone would take half the
 * list with it.
 */
const NOMINAL_GOVERNORS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "its",
  "their",
  "our",
  "your",
  "his",
  "her",
  "any",
  "each",
  "every",
  "no",
  "some",
  "all",
  "both",
  "either",
  "neither",
  "another",
  "other",
  "such",
  "one",
  "two",
  "three",
  "several",
  "many",
  "most",
  "few",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "with",
  "by",
  "from",
  "about",
  "as",
  "per",
  "via",
  "and",
  "or",
]);

/**
 * Adverbs that can stand between a modal and its verb.
 *
 * English puts them there ("a server must also retry"), so a noun-phrase reading of
 * "the keyword is followed by a noun" has to see through them first. The class is
 * open - a writer can coin an adverb - and a coined one reads as a noun and loses the
 * row. That is the safer direction: the row stays `demand` and the caller reads it.
 */
const ADVERBS_BEFORE_A_VERB: ReadonlySet<string> = new Set([
  "not",
  "never",
  "always",
  "also",
  "only",
  "just",
  "then",
  "thus",
  "so",
  "still",
  "even",
  "well",
  "again",
  "further",
  "instead",
  "otherwise",
  "therefore",
  "hence",
  "generally",
  "typically",
  "usually",
  "normally",
  "optionally",
  "preferably",
  "immediately",
  "directly",
  "simply",
  "merely",
  "solely",
  "at",
  "in",
  "least",
  "most",
  "more",
  "less",
  "either",
  "neither",
  "both",
  "to",
  "as",
  "and",
  "or",
]);

/**
 * A copula whose complement is an evaluation rather than a specification.
 *
 * "In general this should not be a problem" is a courtesy and "The server should be
 * configured" is a rule, and the only difference is what follows the copula: a
 * judgement about how bad something is, or a value. That is the brief's "nominalised
 * noun instead of an action verb", and it is a closed class of English words - no
 * protocol vocabulary is involved. Adding "valid", "correct" or "present" to it would
 * be the mistake, because "MUST be valid" is a rule in most specifications.
 */
const EVALUATIVE_PREDICATE =
  /\b(?:be|is|are|was|were|become|becomes|seem|seems|prove|proves|turn|turns)\s+(?:not\s+|never\s+|always\s+|not\s+be\s+)?(?:an?\s+|the\s+)?(?:problems?|issues?|concerns?|difficult(?:y|ies)|hard|easy|harmful|dangerous|surprising|awkward|painful|problematic|unusual|unnecessary|objectionable|fine|ok|okay)\b/iu;

/**
 * The English nouns for a written document, singular and plural.
 *
 * "Future specifications and related documentation should use the general term "URI""
 * was one of the 35 measured rows: a recommendation addressed to the authors of
 * specifications, about which term to use, and binding on nobody who implements
 * anything. No list of implementation nouns is needed to see it, because the
 * interesting direction is the closed one - the words that can only name a document -
 * and the scan stops at the subject's own boundary so "a server that reads Section 4
 * SHOULD ..." is not caught by the word "Section".
 */
const DOCUMENT_NOUNS: ReadonlySet<string> = new Set([
  "specification",
  "specifications",
  "document",
  "documents",
  "draft",
  "drafts",
  "memo",
  "memos",
  "rfc",
  "rfcs",
  "wording",
  "terminology",
  "prose",
  "bibliography",
  "glossary",
]);

/**
 * Words that end in -ing and are nouns, not gerunds.
 *
 * "String handling should be left alone" is about a noun; "Deploying DNSSEC in such an
 * environment may present some challenges" is about an activity, and the second is
 * the one that cannot oblige anybody. English has a dozen -ing nouns that would
 * otherwise read as activities, and the two that appear in specifications are on
 * this list.
 */
const ING_NOUNS: ReadonlySet<string> = new Set([
  "anything",
  "everything",
  "nothing",
  "something",
  "string",
  "thing",
  "things",
  "meaning",
  "meanings",
  "setting",
  "settings",
  "heading",
  "headings",
  "morning",
  "evening",
  "wording",
  "building",
  "clothing",
  "ceiling",
  "sibling",
]);

/**
 * Relative pronouns and subordinators: the words that open a clause of their own.
 *
 * "These shortcomings arise from lack of clarity about which DH group parameters TLS
 * servers should offer" reports a cause; the modal is the predicate of the relative
 * clause, and the sentence's own predicate is "arise", so nobody is told to do
 * anything. The same shape with a real modal is "A server that receives a 100
 * (Continue) response MUST ultimately send a final status code" - and there the
 * relative clause spends its own verb on "receives", which is the test below: a
 * clause opener with no finite verb after it has handed its predicate to the modal.
 *
 * Subordinators only, and no "as": "in cases such as this" is not a clause, and a
 * rule that read it as one would lose "the value must be 0 in such cases".
 */
const CLAUSE_OPENERS: ReadonlySet<string> = new Set([
  "that",
  "which",
  "whether",
  "when",
  "where",
  "because",
  "if",
  "unless",
  "why",
  "how",
]);

/**
 * A citation set off by commas: the shape of a claim reported from elsewhere.
 *
 * "edge LSRs may transmit packets along that LSP which are, according to [4], too
 * big" is one of the 35: the sentence reports what another document found, and a
 * report is not a licence. The commas are what make it safe. "The TTL MUST be set
 * according to [RFC 2181]" is a rule, and the difference is that nothing is being
 * attributed to the citation - it is the authority for the rule, not the source of a
 * report - so it carries no commas around it.
 */
const PARENTHETICAL_ATTRIBUTION = /(?:^|,[ \t]*)according[ \t]+to[ \t]+[\[(][^.;!?]{0,40}[\])][ \t]*,/iu;

const FINITE_VERBS: ReadonlySet<string> = new Set([
  // Auxiliaries and copulas: these are the ones that make a clause finite.
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "has",
  "have",
  "had",
  "does",
  "did",
  "do",
  "will",
  "would",
  "can",
  "could",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "ought",
  // Protocol and infrastructure vocabulary.
  "accept",
  "add",
  "allow",
  "announce",
  "appear",
  "apply",
  "append",
  "assign",
  "assume",
  "attach",
  "authenticate",
  "base",
  "behave",
  "bind",
  "break",
  "cache",
  "calculate",
  "carry",
  "check",
  "choose",
  "cite",
  "clear",
  "close",
  "compare",
  "compile",
  "compose",
  "compute",
  "conclude",
  "conform",
  "connect",
  "consider",
  "consist",
  "construct",
  "contain",
  "control",
  "convert",
  "create",
  "decode",
  "decrypt",
  "defer",
  "define",
  "delay",
  "delete",
  "deny",
  "derive",
  "describe",
  "designate",
  "detect",
  "differ",
  "discard",
  "discuss",
  "display",
  "do",
  "drop",
  "duplicate",
  "emit",
  "enable",
  "encode",
  "encrypt",
  "enforce",
  "ensure",
  "enter",
  "establish",
  "evaluate",
  "exceed",
  "exchange",
  "exclude",
  "execute",
  "exhibit",
  "exist",
  "expect",
  "expire",
  "extend",
  "fail",
  "fetch",
  "filter",
  "find",
  "follow",
  "forward",
  "gather",
  "generate",
  "give",
  "handle",
  "hold",
  "identify",
  "ignore",
  "implement",
  "imply",
  "include",
  "increase",
  "indicate",
  "infer",
  "inform",
  "inherit",
  "initiate",
  "insert",
  "interpret",
  "introduce",
  "invoke",
  "issue",
  "keep",
  "know",
  "learn",
  "leave",
  "limit",
  "list",
  "listen",
  "load",
  "locate",
  "look",
  "maintain",
  "make",
  "manage",
  "map",
  "mark",
  "match",
  "mean",
  "mention",
  "merge",
  "modify",
  "monitor",
  "move",
  "must",
  "name",
  "need",
  "negotiate",
  "note",
  "notice",
  "observe",
  "obtain",
  "occur",
  "offer",
  "open",
  "operate",
  "order",
  "override",
  "pack",
  "parse",
  "pass",
  "perform",
  "permit",
  "persist",
  "place",
  "point",
  "populate",
  "post",
  "prefer",
  "prepare",
  "present",
  "preserve",
  "prevent",
  "process",
  "produce",
  "promise",
  "propagate",
  "protect",
  "provide",
  "publish",
  "query",
  "queue",
  "read",
  "receive",
  "record",
  "reduce",
  "refer",
  "reflect",
  "refresh",
  "register",
  "reject",
  "relay",
  "release",
  "remain",
  "remember",
  "remove",
  "render",
  "repeat",
  "replace",
  "report",
  "represent",
  "request",
  "require",
  "reset",
  "resolve",
  "respond",
  "restart",
  "restore",
  "restrict",
  "result",
  "retry",
  "return",
  "reuse",
  "reverse",
  "revoke",
  "route",
  "run",
  "sample",
  "schedule",
  "search",
  "see",
  "select",
  "send",
  "separate",
  "serialize",
  "serve",
  "set",
  "show",
  "signal",
  "sign",
  "specify",
  "split",
  "start",
  "state",
  "store",
  "stream",
  "submit",
  "subscribe",
  "substitute",
  "support",
  "suppress",
  "suspend",
  "switch",
  "take",
  "terminate",
  "test",
  "think",
  "throw",
  "trace",
  "track",
  "transfer",
  "transform",
  "translate",
  "treat",
  "trigger",
  "trust",
  "unregister",
  "update",
  "upgrade",
  "use",
  "validate",
  "value",
  "verify",
  "wait",
  "walk",
  "want",
  "warn",
  "write",
  "yield",
]);

/** Regular verb forms derived from a base form in the lexicon. */
const VERB_FORMS: ReadonlySet<string> = (() => {
  const forms = new Set<string>();
  for (const base of FINITE_VERBS) {
    forms.add(base);
    forms.add(`${base}s`);
    if (/(?:s|sh|ch|x|z|o)$/u.test(base)) forms.add(`${base}es`);
    if (/e$/u.test(base)) {
      forms.add(`${base}d`);
      forms.add(`${base.slice(0, -1)}ing`);
    } else if (/[^aeiou]y$/u.test(base)) {
      forms.add(`${base.slice(0, -1)}ied`);
      forms.add(`${base}ing`);
    } else {
      forms.add(`${base}ed`);
      forms.add(`${base}ing`);
    }
  }
  return forms;
})();

/**
 * Where the modal sits in the statement, which is the only evidence available about
 * it: its subject and any predicate already in use are both behind it, so a caller
 * that hands over only the clause after the keyword has thrown the answer away.
 */
export interface ModalPlacement {
  /** The whole statement, not the clause after the keyword. */
  readonly sentence: string;
  /** Offset of the keyword in `sentence`; the modal is its first word. */
  readonly keywordIndex: number;
}

interface ModalContext {
  readonly left: string;
  readonly right: string;
}

export function classifyRequirementShape(clause: string, keyword = "", placement?: ModalPlacement): RequirementShape {
  const trimmed = clause.trim();
  if (trimmed === "") return "indeterminate";
  if (/:\s*$/u.test(trimmed)) return "list_introducer";
  const modal = placeModal(clause, keyword, placement);
  // A row whose tail still contains a sentence end is a row about more than one
  // statement - the splitter did not take a boundary it should have - and the test
  // cannot answer for either half. "A future specification should name the author.
  // Unfortunately, he became ill and eventually passed away in May 2022 without
  // being able to complete the document." was one of the 35 measured rows, in exactly
  // that merged shape, and the verb that answered it belonged to the second sentence.
  if (modal !== null && SPANS_ANOTHER_SENTENCE.test(modal.right)) return "indeterminate";
  if (modal !== null && !canStateAnObligation(modal)) return "description";
  const words = trimmed.toLowerCase().match(/[A-Za-z']+/gu);
  if (!words || words.length === 0) return "indeterminate";
  // The keyword itself is not the action: "must MUST be set" has no verb, and
  // "a server must send" has one. Everything else in the clause counts, including
  // the first word, because the commonest shape is the verb right after the keyword.
  const skip = new Set(keyword.toLowerCase().split(/\s+/u).filter(Boolean));
  for (const word of words) {
    if (skip.has(word)) continue;
    if (VERB_FORMS.has(word)) return "demand";
  }
  return "description";
}

/** A sentence end the splitter left inside the text after the keyword. */
const SPANS_ANOTHER_SENTENCE = new RegExp(`[.!?](?:[${SENTENCE_CLOSERS}])*[ \\t]+(?=[A-Z0-9"'(\\[])`, "u");

/**
 * The keyword's own left and right context, or `null` when there is no keyword to place.
 *
 * The three-argument form is what the candidate pass uses: it knows the offset of
 * the keyword in the statement, and without it a repeated keyword is placed at its
 * first occurrence. The two-argument form is kept for a caller that holds the whole
 * statement as its clause, and places the first modal in it. An adjectival keyword -
 * REQUIRED, RECOMMENDED, OPTIONAL - is placed as readily as a modal, because "the
 * recommended method for mail routing" is decided by the same evidence: a governor to
 * its left and a noun to its right.
 */
function placeModal(clause: string, keyword: string, placement?: ModalPlacement): ModalContext | null {
  const first = keyword.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (placement !== undefined) {
    if (first === "") return null;
    const at = Math.max(0, Math.min(placement.sentence.length, placement.keywordIndex));
    return {
      left: placement.sentence.slice(0, at),
      right: placement.sentence.slice(at + first.length),
    };
  }
  const match = FIRST_KEYWORD_WORD.exec(clause);
  if (match === null) return null;
  return { left: clause.slice(0, match.index), right: clause.slice(match.index + match[0].length) };
}

/** Every one of these is a sentence that reports, rather than one that binds. */
function canStateAnObligation(modal: ModalContext): boolean {
  return !(
    modalSitsInsideANounPhrase(modal) ||
    modalIsInsideAComplementClause(modal) ||
    modalGovernsAGerundSubject(modal) ||
    subjectIsTheDocumentItself(modal) ||
    evaluatesRatherThanSpecifies(modal) ||
    reportsAClaimFromAnotherSource(modal)
  );
}

function modalSitsInsideANounPhrase(modal: ModalContext): boolean {
  const governor = lastWord(modal.left);
  if (governor === null || !NOMINAL_GOVERNORS.has(governor)) return false;
  const governed = firstContentWord(modal.right);
  if (governed === null) return false;
  return !VERB_FORMS.has(governed) && !ADVERBS_BEFORE_A_VERB.has(governed);
}

function modalIsInsideAComplementClause(modal: ModalContext): boolean {
  const words = (modal.left.match(/[A-Za-z']+/gu) ?? []).map((word) => word.toLowerCase());
  const open = words.findLastIndex((word) => CLAUSE_OPENERS.has(word));
  if (open === -1) return false;
  // A relative clause that spends a verb of its own is not the clause the modal is in:
  // "A server that receives a 100 (Continue) response MUST ultimately send a final
  // status code" has "receives" between the opener and the modal, and the modal is the
  // predicate of the statement itself.
  return !words.slice(open + 1).some((word) => VERB_FORMS.has(word));
}

function modalGovernsAGerundSubject(modal: ModalContext): boolean {
  const head = firstContentWord(subjectRegion(modal.left));
  if (head === null) return false;
  if (!/^[A-Z]?[a-z]+ing$/u.test(head)) return false;
  return !ING_NOUNS.has(head);
}

function subjectIsTheDocumentItself(modal: ModalContext): boolean {
  return subjectRegion(modal.left)
    .split(/[^A-Za-z]+/u)
    .some((word) => DOCUMENT_NOUNS.has(word.toLowerCase()));
}

function evaluatesRatherThanSpecifies(modal: ModalContext): boolean {
  return EVALUATIVE_PREDICATE.test(modal.right);
}

function reportsAClaimFromAnotherSource(modal: ModalContext): boolean {
  return PARENTHETICAL_ATTRIBUTION.test(modal.left) || PARENTHETICAL_ATTRIBUTION.test(modal.right);
}

/**
 * The subject of the modal's own clause: everything up to its first boundary.
 *
 * A comma ends a subject, and so does a finite verb, which is what keeps "A server
 * that reads Section 4 SHOULD ..." out of `subjectIsTheDocumentItself` - the word
 * "Section" belongs to the relative clause inside the subject, not to the subject.
 */
function subjectRegion(left: string): string {
  const stop = left.search(
    /[;:,]|\b(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|may|might|shall|should)\b/u,
  );
  return stop === -1 ? left : left.slice(0, stop);
}

function firstContentWord(text: string): string | null {
  const words = text.match(/[A-Za-z']+/gu);
  return words?.[0]?.toLowerCase() ?? null;
}

/**
 * Sentences that say whether the document uses the requirement language at all.
 *
 * A requirement count of 0 has two very different causes, and a document often
 * states which one applies in its own text. RFC 2181 §1 opens with "This memo does
 * not use the oft used expressions MUST, SHOULD, MAY, or their negative forms", so
 * its zero is a disclaimer rather than a gap. RFC 2119 and its successors instead
 * write "The key words MUST and MUST NOT ... are to be interpreted as described in
 * RFC 2119", which means a low count is the surprising outcome and worth flagging.
 *
 * Both are reported as evidence with a citation, not as a verdict: the pattern
 * decides only that the document discusses its own keyword usage, and the reader
 * still decides what that means for the rules they are looking for.
 */
const KEYWORD_DISCLAIMER =
  /\b(?:does not use|do not use|does not employ|avoids? the use of|without (?:using|employing))\b[^.]{0,120}\b(?:MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/iu;
const KEYWORD_ADOPTION =
  /\bkey\s?words?\b[^.]{0,160}\b(?:are|is)\s+to\s+be\s+interpreted\b[^.]{0,80}\b(?:RFC\s*2119|RFC\s*8174|BCP\s*14)\b/iu;

export interface KeywordUsageNote {
  readonly stance: "disclaims" | "adopts";
  readonly exact_text: string;
  readonly citation_id: string;
  readonly block_id: string;
  readonly span: Pick<Span, "byte_start" | "byte_end" | "char_start" | "char_end" | "line_start" | "line_end">;
}

/**
 * Find the sentences in which a document states its own stance on RFC 2119.
 *
 * Runs over the same blocks as the candidate pass, so it costs nothing extra and
 * needs no re-ingest beyond the version that introduced it.
 */
export function detectKeywordUsage(input: {
  readonly snapshotId: string;
  readonly blocks: readonly Block[];
  readonly limit?: number;
}): KeywordUsageNote[] {
  const notes: KeywordUsageNote[] = [];
  const limit = input.limit ?? 5;
  for (const block of input.blocks) {
    if (notes.length >= limit) break;
    for (const sentence of splitSentences(block.text)) {
      if (notes.length >= limit) break;
      const stance = KEYWORD_DISCLAIMER.test(sentence.text)
        ? "disclaims"
        : KEYWORD_ADOPTION.test(sentence.text)
          ? "adopts"
          : null;
      if (stance === null) continue;
      const charStart = block.char_start + sentence.start;
      notes.push({
        stance,
        exact_text: sentence.text,
        block_id: block.id,
        span: {
          byte_start: byteOffsetFromChar(block, charStart),
          byte_end: byteOffsetFromChar(block, charStart + sentence.text.length),
          char_start: charStart,
          char_end: charStart + sentence.text.length,
          line_start: block.line_start,
          line_end: block.line_end,
        },
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }),
      });
    }
  }
  return notes;
}

/**
 * Classify a candidate keyword occurrence as modal or not, without a parser.
 *
 * Returns `null` when the shape is not one this heuristic claims to know. A `null`
 * is reported as `unknown`, never folded into either bucket, so the caller can see
 * how much of the list was actually decided and discount the rest accordingly.
 */
export function classifyCandidateRole(
  sentence: string,
  index: number,
  keyword: string,
): "modal" | "non_modal" | "unknown" {
  const before = sentence.slice(Math.max(0, index - 40), index);
  for (const rule of NON_MODAL) {
    if (keyword !== rule.keyword) continue;
    // Positive evidence only. Not matching the noise pattern is not proof of
    // modality, so the decision falls through to the structural test below rather
    // than being forced into this rule's verdict.
    if (rule.pattern.test(before)) return "non_modal";
  }
  // A modal verb stands in a finite clause: something precedes it and something
  // follows it. A keyword with no clause after it inside the sentence is a noun
  // reading, not a rule. Leading punctuation is dropped first, so a sentence-final
  // "may." is not mistaken for a verb phrase.
  const after = sentence
    .slice(index + keyword.length)
    .replace(/^[\s,;:.]+/u, "")
    .trim();
  if (after === "") return "non_modal";
  if (before.trim() === "") return "unknown";
  return "modal";
}

/**
 * Fixed texts the RFC Editor prints around every document, matched in full.
 *
 * Two of them are on the end of nearly every modern RFC and neither says anything
 * about the protocol:
 *
 *   - the status notice, whose only verb is a pointer: "Information about the current
 *     status of this document, any errata, and how to provide feedback on it may be
 *     obtained at http://www.rfc-editor.org/info/rfcNNNN.";
 *   - the BCP-13 legal notice, which requires the *redistributor* to reproduce a
 *     licence: "Code Components extracted from this document must include ... License
 *     text ...".
 *
 * In a 190-item hand-checked sample of the candidate list these two sentences were 55
 * rows - 29% of the list a pre-2119 reader depends on. A candidate list where a third
 * of the rows are the same two sentences is not a compliance list, and no amount of
 * reading the rest of the document compensates for it.
 *
 * The match is on the whole sentence, and both texts are fixed strings the RFC Editor
 * inserts, so this is not a topic filter. It is also counted and reported
 * (`boilerplate_statements_excluded:N`) rather than applied quietly, because a filter
 * nobody can see is indistinguishable from a filter that hides a miss.
 */
const FIXED_BOILERPLATE: readonly RegExp[] = [
  /^Information about the current status of this document, any errata, and how to provide feedback on it may be obtained at\b/u,
  /^Code Components extracted from this document must include (?:Revised|Simplified) BSD License text\b/u,
  /^This document is part of a family of documents defining\b/u,
  /^Code Components extracted from this document must include\b.*Trust Legal Provisions/u,
  // The two other shapes the same legal notice is printed in. Found by measurement
  // rather than by reading RFC 13: a 185-item hand-checked sample of the candidate list
  // still carried 11 rows of them after the patterns above were in place, and they are
  // the same notice with the same lack of anything to do with the protocol.
  /^This document may contain material from IETF Documents or IETF Contributions\b/u,
  /^The person\(s\) controlling the copyright in some of this material may not have granted the IETF Trust\b/u,
];

export function isFixedBoilerplate(sentence: string): boolean {
  const text = sentence.replace(/\s+/gu, " ").trim();
  return FIXED_BOILERPLATE.some((pattern) => pattern.test(text));
}

export function analyzeNormative(input: {
  readonly snapshotId: string;
  readonly rfc: number;
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
}): NormativeAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const mentions: NormativeMention[] = [];
  const requirements: Requirement[] = [];
  const warnings: string[] = [];
  let blocksScanned = 0;
  let blocksSkipped = 0;
  let sentencesScanned = 0;
  const blocksSkippedByKind: Record<string, number> = {};
  // The loss counter. Tables and preformatted text are out of scope BY DESIGN, and a
  // design decision that costs statements has to be visible: `blocks_skipped` says how
  // much text was not read, and this says how much of that text carried an RFC 2119
  // keyword. Corpus-wide, 278 non-prose blocks hold an upper-case keyword and none of
  // them is scanned, so a zero count on a specification that states its rules in a field
  // table is a known gap rather than an absence - which is the difference between a
  // caller reading `read` and a caller being misled.
  let keywordBearingBlocksSkipped = 0;

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionKind = section?.kind ?? "unknown";
    const sectionTitle = section?.title ?? "";
    if (!PROSE_BLOCK_KINDS.has(block.kind) || SKIPPED_SECTION_KINDS.has(sectionKind)) {
      blocksSkipped += 1;
      const bucket = SKIPPED_SECTION_KINDS.has(sectionKind) ? `section:${sectionKind}` : block.kind;
      blocksSkippedByKind[bucket] = (blocksSkippedByKind[bucket] ?? 0) + 1;
      if (TERM_PROBE.test(block.text)) keywordBearingBlocksSkipped += 1;
      continue;
    }
    blocksScanned += 1;

    for (const sentence of splitSentences(block.text)) {
      sentencesScanned += 1;
      const matches = matchTerms(sentence.text);
      if (matches.length === 0) continue;

      const distinctTerms = new Set(
        matches.map((match) => normalizeTerm(match[0])).filter((term): term is NormativeTerm => term !== null),
      );
      // A sentence that enumerates several keywords is discourse *about* the
      // requirement language ("the effects of not implementing a MUST or
      // SHOULD..."), not a requirement. It is kept as a mention and flagged.
      const enumerates = distinctTerms.size >= 3 || META_DISCUSSION.test(sentence.text);
      const inDefinition =
        enumerates || QUOTED_TERM.test(sentence.text) || DEFINITION_SECTIONS.test(sectionTitle.trim());
      // Mentions are per keyword occurrence, because that is what a mention is: this
      // many normative terms appear here, at these offsets. Requirements are per
      // statement, and the two passes used to disagree about that.
      const sentenceMentions: NormativeMention[] = [];
      for (const match of matches) {
        let term = normalizeTerm(match[0]);
        if (!term) continue;
        // A keyword negated by a following `not` is the negated phrase whatever case the
        // `not` is printed in. Without this the row says the opposite of its own sentence,
        // which is the single worst output this extractor can produce: a contract built
        // from it requires the behaviour the RFC forbids. See NEGATION_FOLLOWING.
        let keywordLength = match[0].length;
        const negatedByLowerCase = isFollowedByNegation(sentence.text, match.index ?? 0, term);
        if (NORMATIVE_TERMS[term].polarity === "positive" && negatedByLowerCase) {
          // Guarded, not asserted. An unguarded `${term} NOT` lookup threw a TypeError on
          // RFC 1812 and RFC 2068, because `MAY NOT` was not a key in the vocabulary - a
          // `requirements` call that throws on a real document, found by the parser audit
          // rather than by any test of mine. The vocabulary is the thing that was wrong; the
          // guard is here so a future vocabulary gap degrades to the positive reading
          // instead of taking the call down.
          const negated = `${term} NOT` as NormativeTerm;
          if (NORMATIVE_TERMS[negated] !== undefined) term = negated;
        }
        const meta = NORMATIVE_TERMS[term];
        const quoted = isQuoted(sentence.text, match.index ?? 0, term);
        const disposition: NormativeMention["disposition"] =
          quoted || inDefinition ? "definition" : PROSE_BLOCK_KINDS.has(block.kind) ? "requirement" : "context";

        const charStart = block.char_start + sentence.start + (match.index ?? 0);
        const charEnd = charStart + keywordLength;
        const quote = sentence.text;
        const flags: string[] = [];
        // Only flag the fold that actually happened. Firing on every sentence with a `not`
        // after the keyword marked 112 rows, and most of them were the correctly matched
        // upper-case `MUST NOT` - which is a deviation by nothing and the RFC in question
        // was written correctly.
        if (negatedByLowerCase && meta.polarity === "negative" && !/ NOT$/u.test(match[0])) {
          flags.push("negation_case_not_upper");
        }
        if (quoted) flags.push("term_quoted");
        if (enumerates) flags.push("keyword_enumeration");
        if (inDefinition && !quoted && !enumerates) flags.push("definition_section");
        if (matches.length > 1) flags.push("multiple_terms_in_sentence");
        if (sectionKind === "appendix") flags.push("in_appendix");
        if (sectionKind === "front_matter" || sectionKind === "status") flags.push("in_front_matter");
        if (sectionTitle.toLowerCase().includes("requirements notation")) flags.push("requirements_notation_section");
        if (!section) flags.push("section_unresolved");

        const mention: NormativeMention = {
          id: `men_${citationId({
            snapshotId: input.snapshotId,
            blockId: block.id,
            byteStart: charStart,
            quote: match[0],
          }).slice(4, 20)}`,
          snapshot_id: input.snapshotId,
          rfc: input.rfc,
          section_id: block.section_id,
          block_id: block.id,
          term,
          strength: meta.strength,
          polarity: meta.polarity,
          exact_text: quote,
          span: {
            byte_start: byteOffsetFromChar(block, charStart),
            byte_end: byteOffsetFromChar(block, charEnd),
            char_start: charStart,
            char_end: charEnd,
            codepoint_start:
              block.codepoint_start + codePointCount(block.text.slice(0, sentence.start + (match.index ?? 0))),
            codepoint_end:
              block.codepoint_start +
              codePointCount(block.text.slice(0, sentence.start + (match.index ?? 0) + match[0].length)),
            line_start: block.line_start,
            line_end: block.line_end,
          },
          context: contextAround(sentence.text, match.index ?? 0, match[0].length, 160),
          disposition,
          flags,
          citation_id: citationId({
            snapshotId: input.snapshotId,
            blockId: block.id,
            byteStart: charStart,
            quote,
          }),
        };
        mentions.push(mention);
        sentenceMentions.push(mention);
      }

      // One requirement per STATEMENT. The candidate extractor was fixed to that in an
      // earlier round and this one was not, so "EMTU_R MUST be greater than or equal to
      // 576, SHOULD be either configurable or indefinite, and SHOULD be greater than or
      // equal to the MTU of the connection" came back three times and
      // `coverage.total_requirements` - a number callers trust - counted one sentence as
      // three requirements. 1 411 of 11 640 strict rows corpus-wide, in 96 of 119
      // documents, were a repeat of a sentence already in the same list.
      //
      // A sentence that is discourse ABOUT the requirement language stays a mention. That
      // decision was already made above, in `inDefinition`, and it is not the collapse
      // that gets to override it: "the effects of not implementing a MUST or SHOULD may
      // be subtle" carries two keywords and is still not an obligation.
      if (inDefinition) continue;
      const primary = sentenceMentions.find((m) => !m.flags.includes("term_quoted"));
      if (!primary) continue;
      const primaryIndex = matches.find((m) => m[0] === primary.term)?.index ?? 0;
      const primaryTerm = primary.term;
      const primaryMeta = NORMATIVE_TERMS[primaryTerm];
      const requirementFlagsPending: string[] = [];
      const beforeKeyword = sentence.text.slice(0, primaryIndex);
      const clause = parseClause(sentence.text, primaryIndex, primary.term.length);
      // A list marker is an artefact of the publication format, not part of the
      // requirement. It is stripped from the clause and reported here, so the cleanup is
      // visible instead of silently changing what the actor says.
      if (LIST_MARKER.test(beforeKeyword)) {
        requirementFlagsPending.push("list_marker_stripped_from_clause");
      }
      if (/\bexcept that\b/iu.test(sentence.text.slice(0, primaryIndex + 200))) {
        requirementFlagsPending.push("exception_before_keyword");
      }
      const hasActor = clause.actor !== null;
      const hasAction = clause.action !== null;
      const parseStatus: Requirement["parse_status"] = hasActor && hasAction ? "complete" : "partial";
      const requirementFlags = [...primary.flags, ...requirementFlagsPending];
      if (matches.length > 1) requirementFlags.push("keywords_collapsed_to_one_row");
      if (!hasActor) requirementFlags.push("actor_not_explicit");
      if (!hasAction) requirementFlags.push("action_not_explicit");
      if (sectionTitle.toLowerCase().includes("requirements notation")) {
        requirementFlags.push("requirements_notation_section");
      }
      const sentenceCharStart = block.char_start + sentence.start;
      const sentenceCharEnd = sentenceCharStart + sentence.text.length;
      requirements.push({
        ...primary,
        id: `req_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: sentenceCharStart,
          quote: sentence.text,
        }).slice(4, 20)}`,
        term: primaryTerm,
        strength: primaryMeta.strength,
        polarity: primaryMeta.polarity,
        keywords: sentenceMentions.map((m) => ({
          term: m.term,
          strength: m.strength,
          polarity: m.polarity,
          char_start: m.span.char_start,
          char_end: m.span.char_end,
        })),
        // The span is the STATEMENT, not one keyword inside it. A caller anchoring a
        // contract line to this row quotes the sentence, so the citation has to verify
        // the sentence; a span that covered four letters of it verified nothing about
        // what the contract would say.
        span: {
          byte_start: byteOffsetFromChar(block, sentenceCharStart),
          byte_end: byteOffsetFromChar(block, sentenceCharEnd),
          char_start: sentenceCharStart,
          char_end: sentenceCharEnd,
          codepoint_start: block.codepoint_start + codePointCount(block.text.slice(0, sentence.start)),
          codepoint_end:
            block.codepoint_start + codePointCount(block.text.slice(0, sentence.start + sentence.text.length)),
          line_start: block.line_start,
          line_end: block.line_end,
        },
        context: contextAround(sentence.text, primaryIndex, primary.term.length, 160),
        disposition: "requirement",
        clause,
        parse_status: parseStatus,
        confidence: parseStatus === "complete" ? 0.9 : 0.7,
        flags: requirementFlags,
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: sentenceCharStart,
          quote: sentence.text,
        }),
      });
    }
  }

  if (blocksScanned === 0) warnings.push("no_prose_blocks_scanned");
  if (keywordBearingBlocksSkipped > 0) {
    warnings.push(
      `normative_text_in_unscanned_blocks:${keywordBearingBlocksSkipped}:these_blocks_carry_an_rfc2119_keyword_and_are_out_of_scope_by_design:read_the_section`,
    );
  }

  return {
    mentions,
    requirements,
    coverage: {
      blocks_scanned: blocksScanned,
      blocks_skipped: blocksSkipped,
      blocks_skipped_by_kind: blocksSkippedByKind,
      keyword_bearing_blocks_skipped: keywordBearingBlocksSkipped,
      sentences_scanned: sentencesScanned,
      mentions_found: mentions.length,
      requirements_emitted: requirements.length,
    },
    warnings,
  };
}

/**
 * Requirement-shaped statements the strict extractor left out.
 *
 * The strict reading is correct and stays authoritative: RFC 8174 §3 gives an
 * uncapitalised keyword no normative force, so promoting these would be wrong.
 * The problem this solves is the opposite one. A count of 0 requirements cannot
 * distinguish "this RFC states no requirements" from "this RFC states its
 * requirements in a form the extractor does not recognise" — RFC 1035 writes
 * "Z  Reserved for future use.  Must be zero in all queries and responses." in a
 * field-definition block, and RFC 4033 uses a lower-case "must" throughout. Both
 * are binding on an implementer. Reporting them as candidates, with the reason
 * each was skipped, is what makes a zero count interpretable.
 */
export function analyzeNormativeCandidates(input: {
  snapshotId: string;
  rfc: number;
  sections: readonly Section[];
  blocks: readonly Block[];
  limit?: number;
  /** Cap on the keyword-free list. Separate from `limit`, which caps the candidates. */
  declarativeLimit?: number;
}): NormativeCandidateAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const candidates: NormativeCandidate[] = [];
  const byKeyword: Record<string, number> = {};
  const byCase: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const byShape: Record<string, number> = {};
  const warnings: string[] = [];
  const limit = input.limit ?? MAX_CANDIDATES;
  let scanned = 0;
  let unreadable = 0;
  let truncated = false;
  let skippedSections = 0;
  let skippedReferenceBlocks = 0;
  let boilerplateExcluded = 0;
  let fragments = 0;
  let previousEndedOpen = false;

  for (const block of input.blocks) {
    const section = sectionsById.get(block.section_id);
    const sectionKind = section?.kind ?? "unknown";
    // The candidate pass is a wider net than the strict one — it deliberately adds
    // tables and preformatted text — but it must not be reading a different document.
    // A bibliography entry ("[RFC-1010] J. Reynolds, and J. Postel, ...") contains
    // the word "should" inside a citation and is not a requirement-shaped statement
    // at all, and the authors' address section is not normative prose. Both are
    // excluded here for the reason the strict extractor excludes them, and the count
    // is reported rather than assumed.
    if (SKIPPED_SECTION_KINDS.has(sectionKind)) {
      skippedSections += 1;
      continue;
    }
    if (block.kind === "reference_entry") {
      skippedReferenceBlocks += 1;
      continue;
    }
    const sectionTitle = section?.title ?? "";
    const inDefinitionSection = DEFINITION_SECTIONS.test(sectionTitle.trim());
    const isProse = PROSE_BLOCK_KINDS.has(block.kind);
    scanned += 1;
    if (block.text.includes("\uFFFD")) unreadable += 1;

    // A page break splits a sentence across two blocks, and the second half opens
    // mid-clause. The text is verbatim and correct; it is simply not a whole
    // statement, and saying so beats handing a caller "in this memo, and may be
    // datagrams." as though the RFC had said that. The offset of the block's first
    // non-space character is where an opening sentence starts, indentation aside.
    const firstContent = block.text.length - block.text.trimStart().length;
    const continuesPrevious = previousEndedOpen && /^\s*[a-z]/u.test(block.text);

    for (const sentence of splitSentences(block.text)) {
      if (candidates.length >= limit) {
        truncated = true;
        break;
      }
      if (isFixedBoilerplate(sentence.text)) {
        boilerplateExcluded += 1;
        continue;
      }
      const keywordMatches = [...sentence.text.matchAll(CANDIDATE_KEYWORD)];
      if (keywordMatches.length === 0) continue;
      const reason: NormativeCandidate["reason"] = !isProse
        ? "non_prose_block"
        : inDefinitionSection
          ? "definition_section"
          : null;

      // One row per statement, not per keyword occurrence. The action-verb test reads
      // the clause that follows the keyword, so a sentence holding two keywords used
      // to be emitted twice and could be filed under two different shapes at once.
      const classified = keywordMatches
        .map((match) => {
          const raw = match[0];
          const keyword = raw.replace(/\s+/gu, " ").toLowerCase();
          const keywordCase: NormativeCandidate["keyword_case"] =
            raw === raw.toLowerCase()
              ? "lower"
              : raw === raw.toUpperCase()
                ? "upper"
                : raw === raw[0]!.toUpperCase() + raw.slice(1).toLowerCase()
                  ? "title"
                  : "upper";
          // The clause the keyword governs: from just after the keyword to the end of
          // the sentence, or to a semicolon, which is where RFC prose starts a new
          // independent clause.
          const governed = sentence.text
            .slice((match.index ?? 0) + raw.length)
            .split(/;/u)[0]!
            .trim();
          return {
            keyword: raw,
            normalised: keyword,
            keyword_case: keywordCase,
            role: classifyCandidateRole(sentence.text, match.index ?? 0, keyword),
            // The whole statement goes with the clause: whether a modal can state an
            // obligation is decided by what is in front of it - its subject, and any
            // predicate the sentence has already spent - and the clause after the
            // keyword is exactly the part that does not have them.
            shape: classifyRequirementShape(governed, keyword, {
              sentence: sentence.text,
              keywordIndex: match.index ?? 0,
            }),
            char_start: block.char_start + sentence.start + (match.index ?? 0),
            length: raw.length,
          };
        })
        // The strict extractor already owns every upper-case keyword in a prose block
        // outside a definition section; re-reporting it would be noise.
        .filter((entry) => entry.keyword_case !== "upper" || reason !== null);
      if (classified.length === 0) continue;

      const lead = classified[0]!;
      // The span covers the SENTENCE, not the keyword. Measured across the corpus: with
      // the keyword's offset in the span field, 0 of 2211 candidate rows had a span that
      // addressed their own exact_text - the span was the 4-character "MUST" and the text
      // began 5 characters earlier, so every candidate citation pointed at a keyword
      // inside a block instead of at the sentence it names. The requirement path already
      // carries the correction and its comment; this path did not, and the two now agree.
      // The keyword's position is not lost: `context` is built around it.
      const sentenceCharStart = block.char_start + sentence.start;
      const sentenceCharEnd = sentenceCharStart + sentence.text.length;
      const charStart = sentenceCharStart;
      const charEnd = sentenceCharEnd;
      const isFragment = continuesPrevious && sentence.start === firstContent;
      candidates.push({
        id: `cnd_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }).slice(4, 20)}`,
        snapshot_id: input.snapshotId,
        rfc: input.rfc,
        section_id: block.section_id,
        block_id: block.id,
        keywords: classified.map(({ keyword, keyword_case, role, shape, char_start, length }) => ({
          keyword,
          keyword_case,
          role,
          shape,
          char_start,
          length,
        })),
        keyword: lead.keyword,
        keyword_case: lead.keyword_case,
        role: lead.role,
        shape: lead.shape,
        reason,
        continues_previous_block: isFragment,
        char_start: charStart,
        exact_text: sentence.text,
        context: contextAround(sentence.text, keywordMatches[0]?.index ?? 0, lead.length, 160),
        span: {
          byte_start: byteOffsetFromChar(block, charStart),
          byte_end: byteOffsetFromChar(block, charEnd),
          char_start: charStart,
          char_end: charEnd,
          line_start: block.line_start,
          line_end: block.line_end,
        },
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }),
      });
      if (isFragment) fragments += 1;
      // The per-statement buckets count statements, which is what a caller filters on.
      // The per-keyword buckets keep counting occurrences, under separate names.
      byShape[lead.shape] = (byShape[lead.shape] ?? 0) + 1;
      byRole[lead.role] = (byRole[lead.role] ?? 0) + 1;
      byCase[lead.keyword_case] = (byCase[lead.keyword_case] ?? 0) + 1;
      for (const entry of classified) {
        byKeyword[entry.normalised] = (byKeyword[entry.normalised] ?? 0) + 1;
      }
      if (reason !== null) byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    previousEndedOpen = !/[.!?][")'\]”’]*\s*$/u.test(block.text.trimEnd());
    if (truncated) break;
  }

  if (truncated) warnings.push(`candidates_truncated_at_${limit}`);
  if (unreadable > 0) warnings.push(`blocks_with_replacement_characters:${unreadable}`);
  if (scanned === 0) warnings.push("no_blocks_scanned_for_candidates");
  if (skippedSections > 0) warnings.push(`candidate_sections_skipped:${skippedSections}`);
  if (skippedReferenceBlocks > 0) warnings.push(`reference_entry_blocks_skipped:${skippedReferenceBlocks}`);
  if (boilerplateExcluded > 0) warnings.push(`boilerplate_statements_excluded:${boilerplateExcluded}`);
  if (fragments > 0) {
    warnings.push(
      `sentences_split_across_a_page_break:${fragments}:flagged_continues_previous_block_not_whole_statements`,
    );
  }

  // The keyword-free channel, run over the same blocks and under the same cap and
  // reporting rules as the candidate list. It is deliberately a SEPARATE loop: the
  // candidate loop stops at `max_candidates`, and a specification with no keyword in
  // it must not disappear because a document ran out of candidate budget.
  const declarative = analyzeDeclarativeSpecifications({
    snapshotId: input.snapshotId,
    rfc: input.rfc,
    sections: input.sections,
    blocks: input.blocks,
    ...(input.declarativeLimit !== undefined ? { limit: input.declarativeLimit } : {}),
  });

  return {
    candidates,
    by_keyword: byKeyword,
    by_case: byCase,
    by_reason: byReason,
    by_role: byRole,
    by_shape: byShape,
    declarative_specifications: declarative.declarative_specifications,
    declarative_specifications_truncated: declarative.declarative_specifications_truncated,
    declarative_by_basis: declarative.declarative_by_basis,
    unreadable_blocks: unreadable,
    scanned_blocks: scanned,
    warnings: [...warnings, ...declarative.warnings],
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The keyword-free channel: prose that states a specification with no modal in it.
 *
 * RFC 8174 section 2, which is RFC 2119 as corrected, says of the eleven words:
 * "normative text does not require the use of these key words. They are used for
 * clarity and consistency when that's what's wanted, but a lot of normative text does
 * not use them and is still normative." That is the whole reason this pass exists, and
 * it is why the rows below are not requirements: they have no keyword, and RFC 8174
 * section 3 gives an unkeyworded statement no force to be counted by. On a
 * 100-protocol golden set, 13 statements that bind an implementor without a modal were
 * found by hand and NONE of them was reachable: `analyzeNormative` reads only
 * sentences that carry a keyword, and `analyzeNormativeCandidates` looks at blocks that
 * do. Three of them, verbatim:
 *
 *   RFC 5321  "The maximum total length of a command line including the command word
 *             and the <CRLF> is 512 octets."
 *   RFC 8484  "This media type restricts the maximum size of the DNS message to 65535
 *             bytes."
 *   RFC 5322  "The 998 character limit is due to limitations in many implementations
 *             that send, receive, or store IMF messages which simply cannot handle more
 *             than 998 characters on a line."
 *
 * A count of 0 requirements on such a document is a fact about the extractor's
 * vocabulary, not about the document, and the only thing that fixes it is a second
 * channel. The rows must never enter `requirements` or `coverage.total_requirements`:
 * a number a caller builds a contract on cannot absorb rows the specification never
 * gave a keyword to.
 *
 * WHAT THE SERVICE HAS TO DO, since the extractor cannot do it from here:
 *   1. expose the rows under their own key, e.g. `non_strict_candidates
 *      .declarative_specifications`, with a note that they are not requirements and
 *      are excluded from `total_requirements`;
 *   2. report `declarative_specifications.length` in `coverage` as its own number,
 *      never folded into `total_requirements`;
 *   3. pass the FULL prose block set, not `store.listBlocksWithKeywords(...)`. That
 *      query filters on `lower(text) LIKE '%must%'` and five more stems, so a
 *      paragraph whose only specification is "the maximum is 512 octets" never
 *      reaches the analysis at all - a second, independent reason the 13 were
 *      unreachable, and one this function cannot fix from the inside. Call
 *      `analyzeDeclarativeSpecifications` directly with the snapshot's blocks.
 *
 * THE SELECTION RULE, in full, so a reader can predict every row and every exclusion:
 *
 *   (a) the sentence is in a prose block, in a section that is not an author list, an
 *       index or a reference list, and carries no RFC 2119 keyword in ANY
 *       capitalisation - the same pattern the candidate pass uses, so the two lists
 *       can never both own a sentence;
 *   (b) the sentence states a quantity or a value, by one of three published tests:
 *         `numeric-bound`     a number followed by a unit (octets, bytes, bits,
 *                             characters, seconds, minutes, hours, days,
 *                             milliseconds, percent), or a number the sentence names as
 *                             a width, a length, a limit, a count, a size, a total or
 *                             a timeout;
 *         `copula-definition` a definitional copula: "is defined as", "is specified
 *                             as", "is limited to", "is capped at", "is the maximum",
 *                             "is the minimum", "is the default", "is the limit";
 *         `field-default`     "defaults to", "is reserved", "is initialised to";
 *   (c) the sentence is not a publication artefact: not a caption or figure label
 *       ("Figure 1:", "Table 3."), not a cross-reference ("See Section 3.", "in
 *       accordance with RFC 5321"), not a bibliography entry ("[RFC2119] J.
 *       Reynolds, ...") and not a list item, whose text arrives with its marker still
 *       attached and is a label rather than a statement;
 *   (d) the sentence is not one of the fixed texts the RFC Editor prints around every
 *       document, for the reason the candidate list excludes them;
 *   (e) the sentence is not the second half of a statement a page break split, for the
 *       same reason: it is not a whole statement.
 *
 * The rule is a shape test, not a topic test. It knows the English of measurement and
 * the English of definition, and nothing at all about DNS, HTTP or email, so it does
 * not become a filter for one document's subject. What it cannot do is decide whether
 * a bound is a limit or an observation, and it does not try: `basis` says which test
 * passed and the row says the sentence, which is what a caller has to read.
 */
const MAX_DECLARATIVE_SPECIFICATIONS = 200;

const DECLARATIVE_BASES: readonly { readonly basis: DeclarativeBasis; readonly test: RegExp }[] = [
  {
    basis: "numeric-bound",
    // A number with a unit, or a number the sentence itself names as a width or a
    // limit. The two are one test because a caller asks the same question of both -
    // "what is the bound?" - and RFC 5322's "The 998 character limit" needs the unit
    // while RFC 1034's "The maximum number of labels is 127" needs the name.
    test: /\b\d[\d.,_]*[ \t]*(?:octets?|bytes?|bits?|characters?|seconds?|minutes?|hours?|days?|milliseconds?|percent)\b|\b\d[\d.,_]*[ \t]*(?:widths?|lengths?|limits?|maximum|minimum|max|min|sizes?|counts?|totals?|digits?|thresholds?|timeouts?|intervals?)\b|\b(?:widths?|lengths?|limits?|maximum|minimum|max|min|sizes?|counts?|totals?|digits?|thresholds?|timeouts?|intervals?)\b[ \t]*(?:of[ \t]+)?(?:is[ \t]+|=[ \t]*)?\d/iu,
  },
  {
    basis: "copula-definition",
    test: /\b(?:is|are)[ \t]+(?:defined|specified)[ \t]+as\b|\b(?:is|are)[ \t]+(?:limited|capped|bounded)[ \t]+(?:to|at|by)\b|\b(?:is|are)[ \t]+the[ \t]+(?:maximum|minimum|default|limit|upper[ \t]+bound|lower[ \t]+bound)\b/iu,
  },
  {
    basis: "field-default",
    // "defaults to" and "is reserved" name a value the field takes when nothing says
    // otherwise. "the default is 0" is the same statement with the words the other way
    // round, and RFC prose uses both, so both are here.
    test: /\bdefaults?[ \t]+to\b|\b(?:is|are)[ \t]+reserved\b|\b(?:is|are)[ \t]+initiali[sz]ed[ \t]+to\b|\bdefault[ \t]+(?:value[ \t]+)?(?:is|=)\b/iu,
  },
];

/**
 * An RFC 2119 keyword in any capitalisation, asked as a yes/no question.
 *
 * A non-global clone on purpose. `CANDIDATE_KEYWORD` carries `g`, and a `test()` on a
 * global pattern advances `lastIndex` into every later `matchAll` in the same process
 * - the defect documented beside `TERM_PROBE`, and repeating it here would cost this
 * pass exactly what it cost the strict one.
 */
const CANDIDATE_TERM_PROBE = new RegExp(CANDIDATE_KEYWORD.source, "iu");

/** Captions and figure labels: a label, not a statement. */
const CAPTION_OR_FIGURE_LABEL =
  /^[ \t]*(?:figure|fig|table|listing|example|algorithm|chart|diagram)[ \t]*(?:\d+\b|[ \t]*[:.]\s)/iu;
/** A sentence that is a pointer to somewhere else. */
const CROSS_REFERENCE_ONLY =
  /^[ \t]*(?:see|cf\.?|refer(?:ring|s)?[ \t]+to|as[ \t]+(?:described|defined|specified)[ \t]+(?:in|by|under)|in[ \t]+accordance[ \t]+with|per|according[ \t]+to)\b/iu;
/** A bibliography entry that survived the reference-section filter. */
const BIBLIOGRAPHY_ENTRY = /^[ \t]*[[(][A-Za-z][A-Za-z0-9.-]*\d*[\])]/u;

/**
 * A block that cannot hold a declarative row, decided without splitting it.
 *
 * The three published tests all need a digit or one of a dozen fixed words, so a block
 * with neither cannot contain a row and does not need its sentences cut. This is what
 * keeps the keyword-free channel off the clock: the second pass over the blocks cost
 * 116 ms on a 2000-block document without it, against 37 ms for the candidate pass it
 * sits beside, and that is the same shape as the coverage counter that once cost 29
 * seconds a call. The test is an over-approximation - it can only skip a block that
 * would have produced nothing - so it costs no recall and reports nothing.
 */
const CANNOT_HOLD_A_DECLARATIVE_ROW =
  /\d|defined|specified|limited|capped|bounded|maximum|minimum|default|reserved|initiali[sz]ed|limit/iu;

export interface DeclarativeSpecificationAnalysis {
  readonly declarative_specifications: readonly DeclarativeSpecification[];
  /** True when the list stopped at its cap; the cap is in the warning. */
  readonly declarative_specifications_truncated: boolean;
  readonly declarative_by_basis: Readonly<Record<string, number>>;
  /** Sentences dropped by each published exclusion, by name. A filter nobody can see. */
  readonly declarative_excluded: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export function analyzeDeclarativeSpecifications(input: {
  readonly snapshotId: string;
  readonly rfc: number;
  readonly sections: readonly Section[];
  readonly blocks: readonly Block[];
  readonly limit?: number;
}): DeclarativeSpecificationAnalysis {
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const limit = input.limit ?? MAX_DECLARATIVE_SPECIFICATIONS;
  const declarative: DeclarativeSpecification[] = [];
  const byBasis: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  const warnings: string[] = [];
  let truncated = false;
  let previousEndedOpen = false;

  const drop = (reason: string): void => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };

  for (const block of input.blocks) {
    if (declarative.length >= limit) {
      truncated = true;
      break;
    }
    const section = sectionsById.get(block.section_id);
    // Prose only, the same net the strict extractor reads. Tables, figures and
    // preformatted blocks are out of scope BY DESIGN here as everywhere else, and the
    // count of what was not read is reported rather than left to be assumed.
    if (!PROSE_BLOCK_KINDS.has(block.kind)) {
      drop("blocks_out_of_scope");
      continue;
    }
    if (SKIPPED_SECTION_KINDS.has(section?.kind ?? "unknown")) {
      drop("blocks_out_of_scope");
      continue;
    }
    if (DEFINITION_SECTIONS.test((section?.title ?? "").trim())) {
      drop("definition_section");
      continue;
    }
    // Rule (c): a list item's text arrives with its marker still attached, and what
    // follows the marker is a label rather than a statement. RFC 2822 puts real
    // obligations in its list items, so this costs rows - it is counted, not hidden.
    if (LIST_MARKER.test(block.text)) {
      drop("list_item");
      continue;
    }
    if (!CANNOT_HOLD_A_DECLARATIVE_ROW.test(block.text)) {
      drop("no_quantity_or_definition");
      continue;
    }
    const firstContent = block.text.length - block.text.trimStart().length;
    for (const sentence of splitSentences(block.text)) {
      if (declarative.length >= limit) {
        truncated = true;
        break;
      }
      if (isFixedBoilerplate(sentence.text)) {
        drop("fixed_boilerplate");
        continue;
      }
      // Rule (e): the second half of a statement a page break split. The text is
      // correct and it is not a whole specification.
      if (previousEndedOpen && sentence.start === firstContent && /^[ \t]*[a-z]/u.test(block.text)) {
        drop("page_break_fragment");
        continue;
      }
      // Rule (a): a keyword in any capitalisation. Both channels ask with the same
      // pattern, so a sentence cannot end up in both lists.
      if (CANDIDATE_TERM_PROBE.test(sentence.text)) {
        drop("has_keyword");
        continue;
      }
      if (CAPTION_OR_FIGURE_LABEL.test(sentence.text)) {
        drop("caption_or_figure_label");
        continue;
      }
      if (CROSS_REFERENCE_ONLY.test(sentence.text)) {
        drop("cross_reference");
        continue;
      }
      if (BIBLIOGRAPHY_ENTRY.test(sentence.text)) {
        drop("bibliography_entry");
        continue;
      }
      // Rule (b).
      const entry = DECLARATIVE_BASES.find((candidate) => candidate.test.test(sentence.text));
      if (entry === undefined) continue;

      const charStart = block.char_start + sentence.start;
      declarative.push({
        id: `dec_${citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }).slice(4, 20)}`,
        snapshot_id: input.snapshotId,
        rfc: input.rfc,
        section_id: block.section_id,
        block_id: block.id,
        exact_text: sentence.text,
        basis: entry.basis,
        span: {
          // The span covers the sentence, and the two ends have to agree about it: this
          // one read byte_start from the keyword's offset and byte_end from the keyword
          // plus the sentence's length, which is a range that addresses nothing.
          byte_start: byteOffsetFromChar(block, charStart),
          byte_end: byteOffsetFromChar(block, charStart + sentence.text.length),
          char_start: charStart,
          char_end: charStart + sentence.text.length,
          line_start: block.line_start,
          line_end: block.line_end,
        },
        char_start: charStart,
        citation_id: citationId({
          snapshotId: input.snapshotId,
          blockId: block.id,
          byteStart: charStart,
          quote: sentence.text,
        }),
      });
      byBasis[entry.basis] = (byBasis[entry.basis] ?? 0) + 1;
    }
    previousEndedOpen = !/[.!?][")'\]”’]*\s*$/u.test(block.text.trimEnd());
  }

  if (truncated) warnings.push(`declarative_specifications_truncated_at_${limit}`);
  for (const [reason, count] of Object.entries(excluded)) {
    // `has_keyword` is the ordinary case - those sentences belong to the two keyword
    // channels - and `no_quantity_or_definition` is the gate above, not a judgement.
    // Neither is worth a warning; everything else is a row a reader might have expected.
    if (reason === "has_keyword" || reason === "no_quantity_or_definition") continue;
    warnings.push(`declarative_${reason}_excluded:${count}`);
  }
  return {
    declarative_specifications: declarative,
    declarative_specifications_truncated: truncated,
    declarative_by_basis: byBasis,
    declarative_excluded: excluded,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */

interface Sentence {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  SENTENCE_BOUNDARY.lastIndex = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_BOUNDARY.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    const candidate = text.slice(start, boundary);
    if (!endsWithAbbreviation(candidate)) {
      pushSentence(out, text, start, boundary);
      start = boundary;
    }
  }
  pushSentence(out, text, start, text.length);
  return out;
}

/**
 * A sentence that ends a hard-wrapped line but continues in the next one.
 *
 * A wrapped sentence is one sentence and must quote as one, so the newline is kept
 * inside it; a caller reading `exact_text` wants the whole statement, not the first
 * 72 columns of it. This is the case the strict extractor also relies on: RFC prose
 * states a requirement across several lines, and splitting there would quote half of
 * it.
 */
export function continuesAcrossLineBreak(text: string): boolean {
  return /[.!?]["')\]”’]?[ \t]*\n[ \t]*[a-z]/u.test(text);
}

function pushSentence(out: Sentence[], text: string, start: number, end: number): void {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(text[from]!)) from += 1;
  while (to > from && /\s/u.test(text[to - 1]!)) to -= 1;
  if (to > from) out.push({ text: text.slice(from, to), start: from, end: to });
}

function endsWithAbbreviation(fragment: string): boolean {
  // The closers are transparent to the veto, or the boundary above would be a
  // one-sided rule: "e.g. MUST." would be protected and "(see Fig. 3.)" would not.
  const tail = fragment.trimEnd().replace(TRAILING_CLOSERS, "");
  if (TRAILING_ELLIPSIS.test(tail)) return true;
  const match = /([A-Za-z.]+)\.$/u.exec(tail);
  if (!match) return false;
  const token = match[1]!.toLowerCase().replace(/\.$/u, "");
  if (ABBREVIATIONS.has(token)) return true;
  return token.length === 1 && isAnInitial(fragment, match[1]!);
}

/**
 * A single capital letter standing for a name, rather than the last item of a list.
 *
 * "Every single letter is an initial" was true enough while a period could only be
 * followed by a space: it cost a merged row now and then and protected every name.
 * With a closing bracket in play it costs more than that. "(See Fig. 3 for the
 * values, e.g. A, B). The next sentence follows." put "B" in front of the period,
 * the veto fired, and the two statements came back as one row - the same defect the
 * boundary above exists to remove, reached from the other side.
 *
 * An initial is a letter that starts the statement, starts a parenthesised or quoted
 * one, follows another initial somewhere in the same fragment, or follows the
 * function word that introduces a citation - so "R. Fielding", "(A. B. Smith)" and
 * "See J. Reynolds, and K. Postel" all hold, while "A, B." and "(e.g. A, B)." do
 * not. The residual gap is a name that a bare noun introduces: "Author A. K. Dewada
 * wrote it" splits, because "Author" is neither an introducer nor an initial and the
 * only evidence left would be the capital letter itself, which is the thing this rule
 * stopped trusting.
 */
function isAnInitial(fragment: string, letter: string): boolean {
  const before = fragment
    .trimEnd()
    .slice(0, -(letter.length + 1))
    .trimEnd();
  if (before === "") return true;
  if (/\b[A-Z]\./u.test(before)) return true;
  if (/[[\]("'“‘]$/u.test(before)) return true;
  return NAME_INTRODUCERS.has(lastWord(before) ?? "");
}

/** The prepositions and citation words that can stand immediately before a name. */
const NAME_INTRODUCERS: ReadonlySet<string> = new Set([
  "see",
  "cf",
  "per",
  "eg",
  "ie",
  "also",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "as",
  "by",
  "from",
  "of",
  "versus",
  "vs",
]);

function lastWord(text: string): string | null {
  const match = /([A-Za-z][A-Za-z.']*)[^A-Za-z.]*$/u.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

function normalizeTerm(raw: string): NormativeTerm | null {
  const key = raw.replace(/\s+/gu, " ");
  if (key in NORMATIVE_TERMS) return key as NormativeTerm;
  return null;
}

/**
 * Is the KEYWORD ITSELF inside quotation marks?
 *
 * This was a two-character window in each direction, so any quote mark near the keyword
 * made the sentence a *definition* - and the candidate pass then deletes a definition
 * because the strict pass already owns the keyword. Measured: RFC 1123 §5.2.16,
 * `"domain" MUST NOT interpret…`, puts a `"` two characters before the keyword, so the
 * sentence became a definition mention and appeared in **neither** channel. RFC 3261
 * §19.1.1, `"phone" SHOULD be present`, is the same window compounded by the 500-row
 * mention cap, so it is invisible and no counter moves.
 *
 * The quoted thing in both examples is a field name, not the keyword. A keyword is quoted
 * when the quotes enclose IT: `"MUST"`, or `'MUST NOT'` across a line wrap. That is the
 * only reading under which this function answers its own question, and the only one under
 * which a sentence about a field can stay a requirement.
 */
function isQuoted(text: string, index: number, term: string): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + term.length);
  const opens = /["'`](\s|\(\s*)$/u.test(before);
  const closes = /^(\s|\s*\))["'`]/u.test(after);
  return opens && closes;
}

function byteOffsetFromChar(block: Block, absoluteChar: number): number {
  const relative = Math.max(0, Math.min(block.text.length, absoluteChar - block.char_start));
  return block.byte_start + Buffer.byteLength(block.text.slice(0, relative), "utf8");
}

function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function contextAround(text: string, index: number, length: number, radius: number): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return text.slice(start, end).replace(/\s+/gu, " ");
}

const CONDITION_PATTERN =
  /^(?:if|when|whenever|where|while|unless|except(?:\s+for)?|after|before|in\s+case\s+of|for)\b/iu;
const PRE_KEYWORD_EXCEPTION = /\b(?:except that|except|unless other than|unless|other than)\b/giu;

/**
 * RFC 2822 list markers, and the indentation that follows one.
 *
 * A block's text is the verbatim publication line, so a list item arrives as
 * `o  The RRSIG RR ...` with the marker still attached. Left in place, the marker
 * becomes part of the actor ("o  The RRSIG RR and the RRset"), which is not a
 * sentence the RFC ever says and not a phrase an implementer can act on. The
 * marker is stripped from the parsed clause only; `exact_text` and the stored
 * offsets still point at the original bytes, so nothing becomes unverifiable.
 *
 * The leading `[ \t]*` is there for the keyword-free channel, which tests a whole
 * block rather than a sentence: a block arrives with its indentation still on it,
 * and without this the marker of a list item is not at position zero and the row
 * is emitted as though the item were prose. The clause path passes text that is
 * already trimmed, so it is unaffected.
 */
const LIST_MARKER = /^[ \t]*(?:[-*+•‣·o]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/u;

function parseClause(text: string, termIndex: number, termLength: number): Requirement["clause"] {
  const before = text.slice(0, termIndex);
  const after = text.slice(termIndex + termLength);

  let condition: string | null = null;
  let remainder = stripListMarker(before.trimEnd());
  const conditionMatch = CONDITION_PATTERN.exec(remainder);
  if (conditionMatch) {
    const rest = remainder.slice(conditionMatch[0].length);
    const comma = indexOfClauseSeparator(rest);
    if (comma !== -1) {
      condition = `${conditionMatch[0]}${rest.slice(0, comma)}`.trim();
      remainder = rest.slice(comma + 1);
    }
  }

  // A main clause can carry the real subject in its exception tail:
  //   "The HEAD method is identical to GET except that the server MUST NOT …"
  // The actor is the phrase after the last pre-keyword exception marker; the
  // leading part is kept as context instead of being mistaken for the actor.
  let actorSource = remainder;
  let preException: string | null = null;
  const markers = [...remainder.matchAll(PRE_KEYWORD_EXCEPTION)];
  const lastMarker = markers[markers.length - 1];
  if (lastMarker?.index !== undefined) {
    preException = remainder.slice(0, lastMarker.index).trim() || null;
    actorSource = remainder.slice(lastMarker.index + lastMarker[0].length);
  }

  const actorMatch = /(?:^|[.;:!?]\s+|,\s+|\s+)([A-Za-z0-9][\w .()'/-]{0,80}?)\s*$/u.exec(actorSource);
  const actor = cleanClauseText(actorMatch?.[1]) ?? null;
  if (preException && condition === null) condition = preException;

  let action = after.trim() || null;
  let exception: string | null = null;
  const exceptionMatch = /\s+((?:except|unless|other than|but not|aside from)\b.*)$/iu.exec(after);
  if (exceptionMatch && exceptionMatch.index !== undefined) {
    exception = cleanClauseText(exceptionMatch[1]!);
    action = after.slice(0, exceptionMatch.index).trim() || null;
  }
  if (action) {
    action = cleanClauseText(action.replace(/[;:,]$/u, ""));
  }
  return {
    actor,
    condition,
    action,
    exception,
  };
}

/** Remove a leading list marker, if the text still carries one. */
function stripListMarker(text: string): string {
  const stripped = text.replace(LIST_MARKER, "").trimStart();
  return stripped.length > 0 ? stripped : text.trimStart();
}

/**
 * Collapse the layout whitespace of a publication line into single spaces.
 *
 * RFC text is hard-wrapped at column 72 and list items are indented, so a clause
 * lifted verbatim out of a block arrives as "o  The RRSIG RR and the RRset" or
 * "A server\n  that sends a 100 (Continue) response". Neither is quotable as the
 * requirement it states.
 */
function cleanClauseText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = stripListMarker(value.replace(/\s+/gu, " ").trim());
  return cleaned.length > 0 ? cleaned : null;
}

function indexOfClauseSeparator(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if ((char === "," || char === ";") && depth === 0) return i;
  }
  return -1;
}

export function strengthOf(term: NormativeTerm): NormativeStrength {
  return NORMATIVE_TERMS[term].strength;
}

export function polarityOf(term: NormativeTerm): NormativePolarity {
  return NORMATIVE_TERMS[term].polarity;
}

export { quoteHash };
