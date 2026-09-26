/**
 * The bounded search grammar.
 *
 * Deliberately tiny and total: filters with a fixed vocabulary, free text, and
 * quoted phrases. No raw FTS5 syntax reaches the database unfiltered, no regex
 * is compiled from user input, and every token is length-limited.
 */

import { RfcMcpError } from "../core/errors.js";

export interface ParsedQuery {
  readonly text: string;
  readonly phrases: readonly string[];
  readonly rfcs: readonly number[];
  readonly sectionPrefix: string | null;
  readonly keywords: readonly string[];
  readonly statuses: readonly string[];
  readonly streams: readonly string[];
  readonly authors: readonly string[];
  readonly relation?: string;
  /** Non-fatal notes: a query that parsed but answers something other than what it looks like. */
  readonly notes: readonly string[];
  /**
   * Disjunction of the search terms, each with its FTS5 literal. `text` and
   * `phrases` remain the flat AND reading used for snippets and catalog matching;
   * this is what an explicit OR in the query string means.
   */
  readonly alternatives?: readonly (readonly string[])[];
  /** Terms the query excluded, as FTS5 literals. */
  readonly negated?: readonly string[];
}

const FIELD_TOKENS = new Set(["rfc", "section", "keyword", "status", "stream", "author", "relation", "term"]);
const MAX_TOKENS = 64;

/** Relation values a `relation:` filter may take, matching the reference analysis. */
const RELATIONS = new Set(["normative", "informative", "in_body"]);

export function parseQuery(input: string, limits: { maxChars: number }): ParsedQuery {
  if (input.length > limits.maxChars) {
    throw new RfcMcpError("LIMIT_EXCEEDED", `Query exceeds ${limits.maxChars} characters`, {
      details: { length: input.length, limit: limits.maxChars },
      retryable: false,
    });
  }
  const rfcs: number[] = [];
  const keywords: string[] = [];
  const statuses: string[] = [];
  const streams: string[] = [];
  const authors: string[] = [];
  const notes: string[] = [];
  /** Alternatives for an explicit OR, each an AND-group of raw (unexpanded) terms. */
  const groups: string[][] = [[]];
  /** Terms a leading NOT excludes from the whole expression. */
  const negated: string[] = [];
  /** Raw term values the caller quoted, which must keep phrase semantics. */
  const quotedTerms = new Set<string>();
  let pendingNot = false;
  let sectionPrefix: string | null = null;
  let relation: string | undefined;

  let tokens = 0;
  for (const token of tokenize(input)) {
    tokens += 1;
    if (tokens > MAX_TOKENS) {
      throw new RfcMcpError("LIMIT_EXCEEDED", "Query has too many tokens", { retryable: false });
    }
    if (token.quoted) {
      addTerm(groups, negated, pendingNot, token.value);
      if (!pendingNot) quotedTerms.add(token.value);
      pendingNot = false;
      continue;
    }
    // Boolean operators are recognised only as bare, upper-case words. A lower-case
    // "or" is an English word that occurs inside RFC prose, so treating it as an
    // operator would silently change the meaning of an ordinary text search.
    if (!token.quoted) {
      const operator = token.value.toUpperCase();
      if (operator === "OR" && /^(?:or|OR)$/u.test(token.value)) {
        groups.push([]);
        continue;
      }
      if (operator === "AND" && /^(?:and|AND)$/u.test(token.value)) {
        continue;
      }
      if (operator === "NOT" && /^(?:not|NOT)$/u.test(token.value)) {
        pendingNot = true;
        continue;
      }
    }
    const separator = token.value.indexOf(":");
    if (separator > 0) {
      const field = token.value.slice(0, separator).toLowerCase();
      const value = token.value.slice(separator + 1);
      if (FIELD_TOKENS.has(field) && value === "") {
        // `status:` with no value is a malformed filter, not the literal word. Falling
        // through to free text would answer a different question than the one asked.
        throw new RfcMcpError("INVALID_ARGUMENT", `${field}: filter needs a value`, { retryable: false });
      }
      if (FIELD_TOKENS.has(field)) {
        switch (field) {
          case "rfc": {
            for (const part of value.split(",")) {
              const match = /^\d{1,5}$/u.exec(part.trim());
              if (!match) {
                throw new RfcMcpError("INVALID_ARGUMENT", `rfc: filter expects a number, got ${JSON.stringify(part)}`, {
                  retryable: false,
                });
              }
              rfcs.push(Number.parseInt(match[0], 10));
            }
            break;
          }
          case "section": {
            if (!/^[A-Za-z0-9.]{1,20}$/u.test(value)) {
              throw new RfcMcpError("INVALID_ARGUMENT", `section: filter expects a section number`, {
                retryable: false,
              });
            }
            sectionPrefix = value;
            break;
          }
          case "keyword":
            keywords.push(value);
            break;
          case "status":
            statuses.push(value);
            break;
          case "stream":
            streams.push(value);
            break;
          case "author":
            authors.push(value);
            break;
          case "relation": {
            const normalized = value.toLowerCase();
            if (!RELATIONS.has(normalized)) {
              throw new RfcMcpError(
                "INVALID_ARGUMENT",
                `relation: filter expects one of ${[...RELATIONS].join(", ")}, got ${JSON.stringify(value)}`,
                { retryable: false },
              );
            }
            relation = normalized;
            break;
          }
          case "term":
            keywords.push(value);
            break;
        }
        continue;
      }
    }
    addTerm(groups, negated, pendingNot, token.value);
    pendingNot = false;
  }

  if (pendingNot) {
    throw new RfcMcpError("INVALID_ARGUMENT", "Query ends with NOT and no term to exclude", { retryable: false });
  }
  // A trailing OR leaves an empty alternative; dropping it is what the caller
  // meant, and reporting it as a match failure would not be.
  const alternatives = groups.filter((group) => group.length > 0);

  if (alternatives.length > 1) {
    notes.push("boolean_or_applied");
  }
  if (negated.length > 0) {
    notes.push("boolean_not_applied");
  }
  // An empty first group next to a later one means a leading OR. FTS5 has no
  // leading OR, so it is answered as the disjunction it was meant to be.
  if (groups[0]!.length === 0 && alternatives.length > 0) {
    notes.push("leading_or_treated_as_disjunction");
  }

  // A term the caller quoted is a phrase; an unquoted one is a bare word. The
  // distinction is preserved here so snippets highlight the phrase the caller asked
  // for rather than the first word of it.
  const flat = alternatives.flat();
  const flatPhrases = flat.filter((term) => quotedTerms.has(term));
  const flatText = flat.filter((term) => !quotedTerms.has(term));

  return {
    text: flatText.join(" "),
    phrases: flatPhrases,
    rfcs: [...new Set(rfcs)],
    sectionPrefix,
    keywords,
    statuses,
    streams,
    authors,
    notes,
    ...(alternatives.length > 1 ? { alternatives } : {}),
    ...(negated.length > 0 ? { negated } : {}),
    ...(relation ? { relation } : {}),
  };
}

/**
 * Route one search term into the current AND group, or into the exclusion list.
 *
 * Terms stay raw here: quoting and the tokenizer-driven expansion of a punctuated
 * phrase both belong to `buildFtsMatch`, so a phrase reaches the database through
 * exactly one code path whether it was quoted by the caller or split by the parser.
 */
function addTerm(groups: string[][], negated: string[], pendingNot: boolean, value: string): void {
  if (pendingNot) {
    negated.push(value);
    return;
  }
  groups[groups.length - 1]!.push(value);
}

interface Token {
  readonly value: string;
  readonly quoted: boolean;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const end = input.indexOf('"', index + 1);
      if (end === -1) {
        throw new RfcMcpError("INVALID_ARGUMENT", "Unterminated quoted phrase", { retryable: false });
      }
      tokens.push({ value: input.slice(index + 1, end), quoted: true });
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < input.length && !/\s/u.test(input[end]!)) end += 1;
    tokens.push({ value: input.slice(index, end), quoted: false });
    index = end;
  }
  return tokens;
}

/**
 * Build a safe FTS5 MATCH expression: every term is a quoted literal.
 *
 * The FTS tokenizer splits on `-`, `/` and `.`, so a quoted phrase such as
 * "Idempotent-Methods" could never match a literal. Such a phrase is therefore
 * expanded into its alphanumeric parts joined by AND, which is what the caller
 * meant. Phrases without punctuation keep exact-phrase semantics.
 *
 * An explicit `OR` becomes a parenthesised disjunction of AND-groups, and a
 * `NOT` term is applied with FTS5's binary `NOT` after the positive expression,
 * so `a OR b NOT c` means "(a OR b) except c" — the reading a caller means by
 * writing it that way. `keyword:` and `author:` are folded in as AND terms, which
 * is what "this term plus that filter" means.
 */
export function buildFtsMatch(query: ParsedQuery): string | null {
  const positive: string[] = [];

  if (query.alternatives && query.alternatives.length > 1) {
    const rendered = query.alternatives
      .map((group) => renderGroup(group, query))
      .filter((group): group is string => group !== null);
    if (rendered.length === 0) return null;
    positive.push(rendered.length === 1 ? rendered[0]! : `(${rendered.join(" OR ")})`);
  } else {
    for (const phrase of query.phrases) {
      const rendered = renderPhrase(phrase);
      if (rendered) positive.push(rendered);
    }
    if (query.text) {
      for (const term of query.text.split(/\s+/u).filter(Boolean)) {
        positive.push(quoteLiteral(term));
      }
    }
  }

  for (const keyword of query.keywords) {
    const rendered = renderPhrase(keyword);
    if (rendered) positive.push(rendered);
  }
  for (const author of query.authors) positive.push(quoteLiteral(author));

  // status: and stream: are catalog facets, matched against the slug or the display
  // name by the store. They are deliberately not folded into the MATCH expression:
  // the FTS columns hold display names ("internet standard"), so a slug such as
  // `std` would never match, and for a text search the facet has no block-level
  // meaning at all. A query of nothing but facets therefore has no MATCH expression
  // and is answered from the catalog instead.
  if (positive.length === 0) return null;
  const expression = positive.length === 1 ? positive[0]! : positive.join(" AND ");

  const exclusions = (query.negated ?? [])
    .map((term) => renderPhrase(term))
    .filter((term): term is string => term !== null);
  if (exclusions.length === 0) return expression;
  // FTS5 `NOT` is binary, so exclusions chain from the left. A bare `NOT` with no
  // positive term has no row to subtract from and is dropped by the parser.
  return exclusions.reduce((acc, term) => `${acc} NOT ${term}`, expression);
}

/** One OR alternative: its terms ANDed, with a punctuated phrase expanded in place. */
function renderGroup(group: readonly string[], query: ParsedQuery): string | null {
  const parts: string[] = [];
  for (const term of group) {
    if (query.phrases.includes(term)) {
      const rendered = renderPhrase(term);
      if (rendered) parts.push(rendered);
      continue;
    }
    parts.push(quoteLiteral(term));
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`;
}

function quoteLiteral(term: string): string {
  return `"${term.replace(/"/gu, '""')}"`;
}

function renderPhrase(phrase: string): string | null {
  if (/^[\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)*$/u.test(phrase)) return quoteLiteral(phrase);
  const tokens = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(quoteLiteral).join(" AND ");
}
