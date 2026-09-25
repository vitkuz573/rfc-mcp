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
  const text: string[] = [];
  const phrases: string[] = [];
  const rfcs: number[] = [];
  const keywords: string[] = [];
  const statuses: string[] = [];
  const streams: string[] = [];
  const authors: string[] = [];
  let sectionPrefix: string | null = null;
  let relation: string | undefined;

  let tokens = 0;
  for (const token of tokenize(input)) {
    tokens += 1;
    if (tokens > MAX_TOKENS) {
      throw new RfcMcpError("LIMIT_EXCEEDED", "Query has too many tokens", { retryable: false });
    }
    if (token.quoted) {
      phrases.push(token.value);
      continue;
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
    text.push(token.value);
  }

  return {
    text: text.join(" "),
    phrases,
    rfcs: [...new Set(rfcs)],
    sectionPrefix,
    keywords,
    statuses,
    streams,
    authors,
    ...(relation ? { relation } : {}),
  };
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
 */
export function buildFtsMatch(query: ParsedQuery): string | null {
  const parts: string[] = [];
  for (const phrase of query.phrases) {
    if (/^[\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)*$/u.test(phrase)) {
      parts.push(`"${phrase.replace(/"/gu, '""')}"`);
      continue;
    }
    const tokens = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    for (const token of tokens) parts.push(`"${token.replace(/"/gu, '""')}"`);
  }
  if (query.text) {
    for (const term of query.text.split(/\s+/u).filter(Boolean)) {
      parts.push(`"${term.replace(/"/gu, '""')}"`);
    }
  }
  for (const keyword of query.keywords) parts.push(`"${keyword.replace(/"/gu, '""')}"`);
  for (const author of query.authors) parts.push(`"${author.replace(/"/gu, '""')}"`);
  // status: and stream: are catalog facets, matched against the slug or the display
  // name by the store. They are deliberately not folded into the MATCH expression:
  // the FTS columns hold display names ("internet standard"), so a slug such as
  // `std` would never match, and for a text search the facet has no block-level
  // meaning at all. A query of nothing but facets therefore has no MATCH expression
  // and is answered from the catalog instead.
  if (parts.length === 0) return null;
  return parts.join(" AND ");
}
