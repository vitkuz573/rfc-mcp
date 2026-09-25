/**
 * Hardened XML reader for the small, well-defined XML shapes this server
 * consumes (RFCXML v2/v3, Atom feeds).
 *
 * Security properties, by construction:
 *  - no DTD and no entity declarations (a document containing one is rejected);
 *  - no XInclude resolution and no network or filesystem access;
 *  - only the five predefined entities plus numeric character references;
 *  - hard limits on depth, node count and nesting width;
 *  - every node keeps char offsets into the original source.
 */

import { RfcMcpError } from "../core/errors.js";

export interface XmlNode {
  readonly name: string;
  readonly local: string;
  readonly prefix: string | null;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  textParts: string[];
  startChar: number;
  endChar: number;
}

export interface XmlLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTextChars: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = Object.freeze({
  maxDepth: 128,
  maxNodes: 500_000,
  maxTextChars: 64 * 1024 * 1024,
});

const NAME_START = /[A-Za-z_:]/u;
const NAME_CHAR = /[-A-Za-z0-9._:]/u;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function parseXml(source: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlNode[] {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let index = 0;
  let nodes = 0;
  let textChars = 0;
  const length = source.length;

  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new RfcMcpError("PARSE_FAILED", message, {
      details: { offset: index, ...details },
    });
  };

  const current = (): XmlNode | undefined => stack[stack.length - 1];

  while (index < length) {
    const lt = source.indexOf("<", index);
    if (lt === -1) {
      appendText(source.slice(index));
      break;
    }
    if (lt > index) appendText(source.slice(index, lt));
    index = lt;

    if (source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (end === -1) fail("Unterminated processing instruction");
      index = end + 2;
      continue;
    }
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end === -1) fail("Unterminated comment");
      index = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      if (end === -1) fail("Unterminated CDATA section");
      const raw = source.slice(index + 9, end);
      textChars += raw.length;
      if (textChars > limits.maxTextChars) fail("XML text budget exceeded");
      current()?.textParts.push(raw);
      index = end + 3;
      continue;
    }
    if (source.startsWith("<!", index)) {
      const tag = source.slice(index, index + 9).toUpperCase();
      if (tag.startsWith("<!DOCTYPE") || tag.startsWith("<!ENTITY")) {
        fail("DTD and entity declarations are rejected by policy", { construct: tag });
      }
      fail("Unsupported XML declaration");
    }
    if (source.startsWith("</", index)) {
      const end = source.indexOf(">", index + 2);
      if (end === -1) fail("Unterminated closing tag");
      const rawName = source.slice(index + 2, end).trim();
      const open = stack.pop();
      if (!open) fail("Closing tag without a matching open tag", { tag: rawName });
      const closed = open as XmlNode;
      if (closed.name !== rawName) fail("Mismatched closing tag", { expected: closed.name, found: rawName });
      closed.endChar = end + 1;
      index = end + 1;
      continue;
    }

    // Opening tag.
    index += 1;
    const nameStart = index;
    if (index >= length || !NAME_START.test(source[index]!)) fail("Invalid element name");
    index += 1;
    while (index < length && NAME_CHAR.test(source[index]!)) index += 1;
    const qname = source.slice(nameStart, index);
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let selfClosing = false;

    for (;;) {
      while (index < length && /\s/u.test(source[index]!)) index += 1;
      if (index >= length) fail("Unterminated element");
      const char = source[index]!;
      if (char === ">") {
        index += 1;
        break;
      }
      if (char === "/") {
        if (source[index + 1] !== ">") fail("Malformed self-closing tag");
        selfClosing = true;
        index += 2;
        break;
      }
      const attrStart = index;
      if (!NAME_START.test(char)) fail("Invalid attribute name");
      index += 1;
      while (index < length && NAME_CHAR.test(source[index]!)) index += 1;
      const attrName = source.slice(attrStart, index);
      while (index < length && /\s/u.test(source[index]!)) index += 1;
      if (source[index] !== "=") fail(`Attribute ${attrName} has no value`);
      index += 1;
      while (index < length && /\s/u.test(source[index]!)) index += 1;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${attrName} value is not quoted`);
      index += 1;
      const valueStart = index;
      const close = source.indexOf(quote, index);
      if (close === -1) fail(`Unterminated value for attribute ${attrName}`);
      const value = decodeEntities(source.slice(valueStart, close));
      if (value.length > 8192) fail(`Attribute ${attrName} is too long`);
      attrs[attrName] = value;
      index = close + 1;
    }

    nodes += 1;
    if (nodes > limits.maxNodes) fail("XML node budget exceeded");
    const colon = qname.indexOf(":");
    const node: XmlNode = {
      name: qname,
      local: colon === -1 ? qname : qname.slice(colon + 1),
      prefix: colon === -1 ? null : qname.slice(0, colon),
      attrs,
      children: [],
      textParts: [],
      startChar: nameStart - 1,
      endChar: index,
    };
    const parent = current();
    if (parent) {
      parent.children.push(node);
      if (stack.length + 1 > limits.maxDepth) fail("XML nesting depth exceeded", { depth: stack.length + 1 });
    } else {
      roots.push(node);
    }
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 0) {
    throw new RfcMcpError("PARSE_FAILED", `Unclosed XML element <${stack[stack.length - 1]!.name}>`, {
      details: { open_elements: stack.length },
    });
  }
  return roots;

  function appendText(raw: string): void {
    if (raw.length === 0) return;
    const parent = current();
    if (!parent) return;
    textChars += raw.length;
    if (textChars > limits.maxTextChars) fail("XML text budget exceeded");
    parent.textParts.push(decodeEntities(raw));
  }
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/gu, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return isValidXmlCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return isValidXmlCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity];
    return named ?? match;
  });
}

function isValidXmlCodePoint(code: number): boolean {
  return (
    Number.isFinite(code) &&
    (code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000)
  );
}

export function textContent(node: XmlNode): string {
  let out = node.textParts.join("");
  for (const child of node.children) out += textContent(child);
  return out;
}

export function findChild(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((child) => child.local === local);
}

export function findChildren(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((child) => child.local === local);
}

export function findDescendants(node: XmlNode, predicate: (candidate: XmlNode) => boolean): XmlNode[] {
  const out: XmlNode[] = [];
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (predicate(child)) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

export function findRoot(roots: readonly XmlNode[], local: string): XmlNode | undefined {
  return roots.find((root) => root.local === local);
}
