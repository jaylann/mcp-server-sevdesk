/**
 * A hardened XML reader for e-invoices (XRechnung, ZUGFeRD/Factur-X), built on fast-xml-parser.
 * The input is a file from a third party, so the reader assumes it is hostile:
 *
 * - **No DTDs at all.** Any `<!DOCTYPE` or `<!ENTITY` (any letter case, anywhere, even inside a
 *   comment) is refused before parsing. EN 16931 syntaxes never use a DTD, and refusing them
 *   rules out external entities (XXE), parameter entities and entity expansion ("billion
 *   laughs") at the source. The parser additionally runs with `processEntities: false`; only the
 *   five predefined entities and numeric character references are decoded, by this module.
 * - **Size and depth caps.** At most {@link MAX_EINVOICE_XML_BYTES} bytes and
 *   {@link MAX_XML_DEPTH} levels of nesting (real invoices nest about 10 deep); deeper input is
 *   refused by the parser before any recursion here.
 * - **UTF-8 only.** A UTF-8 byte order mark is accepted; UTF-16/32 byte order marks, an XML
 *   declaration naming another encoding, and bytes that are not valid UTF-8 are refused.
 * - **Well-formedness.** fast-xml-parser's own parser is lenient, so the document is checked with
 *   its validator first; anything that is not well-formed XML is refused.
 * - **Namespaces.** Prefixes are removed from element names (CII and UBL use several prefixes,
 *   and producers choose their own), and every element carries the namespace URI its prefix (or
 *   the default namespace) resolves to. The root's URI tells the syntax apart
 *   (`urn:…:CrossIndustryInvoice:100` versus ZUGFeRD 1.0's `CrossIndustryDocument`, UBL's
 *   `Invoice-2`/`CreditNote-2`); the readers then work on {@link elementsOf}, the tree without
 *   the elements that are not in the namespace their syntax defines for that name. So
 *   `<x:InvoiceCurrencyCode xmlns:x="urn:other">` is never read as the invoice currency, whatever
 *   its position (review 2026-11, round 3). Attributes with a prefix (`xsi:…`, `xml:…`, or one
 *   made up to shadow `currencyID`) are dropped: the attributes of CII and UBL have none.
 * - Comments, processing instructions and the XML declaration are dropped; CDATA content is kept
 *   verbatim as text.
 *
 * Refusals are local `validation` {@link SevdeskError}s with trusted messages: they never quote
 * the file's content (parser messages can, so they are not passed on).
 */
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { SevdeskError } from "../../sevdesk/errors.js";
import { MAX_EINVOICE_XML_BYTES } from "./model.js";

/** Deepest element nesting accepted. XRechnung and ZUGFeRD documents nest about 10 levels. */
export const MAX_XML_DEPTH = 64;

/** One element of the parsed document, namespace prefixes removed. */
export interface XmlElement {
  /** Local name, e.g. `CrossIndustryInvoice`, `TypeCode`. */
  readonly name: string;
  /** The prefix the document used, e.g. `rsm`; `undefined` for an unprefixed name. */
  readonly prefix: string | undefined;
  /**
   * The namespace URI the prefix (or, without one, the default namespace) resolves to at this
   * element; `undefined` without a declaration in scope.
   */
  readonly namespace: string | undefined;
  /**
   * Attributes without a prefix, with decoded values; namespace declarations (`xmlns`,
   * `xmlns:*`) and prefixed attributes are not included.
   */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text (character data and CDATA, entities decoded), trimmed. */
  readonly text: string;
}

/** A parsed e-invoice document. */
export interface XmlDocument {
  readonly root: XmlElement;
  /** Namespace URI of the root element, from its `xmlns` / `xmlns:<prefix>` declaration. */
  readonly namespace: string | undefined;
}

const CDATA_KEY = "#cdata";
const TEXT_KEY = "#text";
const ATTRIBUTES_KEY = ":@";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
  cdataPropName: CDATA_KEY,
  // fast-xml-parser refuses once its stack exceeds the option while opening a tag, i.e. it
  // accepts one level more than the number given.
  maxNestedTags: MAX_XML_DEPTH - 1,
});

/** `<!DOCTYPE` or `<!ENTITY`, any case, optional whitespace after `<!`. */
const DTD_MARKUP = /<!\s*(?:doctype|entity)/i;
/** The encoding pseudo-attribute of an XML declaration at the very start. */
const DECLARED_ENCODING = /^<\?xml[^>]*?\bencoding\s*=\s*["']([^"']*)["']/;

/**
 * Parses XML bytes into an element tree under the rules in the module doc. `what` is a trusted
 * noun for messages, e.g. "The e-invoice XML". Throws a `validation` error for anything refused.
 */
export function parseXmlDocument(bytes: Uint8Array, what = "The file"): XmlDocument {
  if (bytes.byteLength > MAX_EINVOICE_XML_BYTES) {
    throw xmlRefusal(
      `${what} has ${String(bytes.byteLength)} bytes of XML; the limit is ` +
        `${String(MAX_EINVOICE_XML_BYTES)} bytes`,
    );
  }
  const text = decodeUtf8(bytes, what);
  if (DTD_MARKUP.test(text)) {
    throw xmlRefusal(
      `${what} contains a DOCTYPE or ENTITY declaration. E-invoices never need one, and such ` +
        "declarations can make an XML reader fetch files or expand text without limit, so the " +
        "file is not read",
    );
  }
  const declared = DECLARED_ENCODING.exec(text)?.[1]?.trim().toLowerCase();
  if (declared !== undefined && declared !== "utf-8" && declared !== "utf8") {
    throw xmlRefusal(
      `${what} declares a character encoding other than UTF-8. XRechnung and ZUGFeRD require ` +
        "UTF-8; ask the sender for a UTF-8 file",
    );
  }
  // fast-xml-parser's parser accepts unclosed and mismatched tags, so well-formedness is checked
  // with its validator. Deprecated in favor of the separate fast-xml-validator package, which is
  // not a dependency; the bundled validator is still shipped and maintained in v5.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (XMLValidator.validate(text) !== true) {
    throw xmlRefusal(`${what} is not well-formed XML`);
  }
  let nodes: unknown;
  try {
    nodes = parser.parse(text);
  } catch {
    throw xmlRefusal(
      `${what} nests elements deeper than ${String(MAX_XML_DEPTH)} levels or cannot be read as XML`,
    );
  }
  const root = toElements(nodes, undefined)[0];
  if (root === undefined) throw xmlRefusal(`${what} has no root element`);
  return { root, namespace: root.namespace };
}

/**
 * A copy of the tree with only the elements `belongs` accepts for their local name and namespace
 * URI; an element it does not accept is left out with everything below it. The root is kept as
 * it is (the caller has checked its name and namespace). A syntax reader runs on this copy, so
 * its lookups by local name are lookups by expanded name: an element with the right local name
 * in another namespace cannot stand in for a field.
 */
export function elementsOf(
  root: XmlElement,
  belongs: (name: string, namespace: string | undefined) => boolean,
): XmlElement {
  const keep = (element: XmlElement): XmlElement => ({
    ...element,
    children: element.children
      .filter((candidate) => belongs(candidate.name, candidate.namespace))
      .map(keep),
  });
  return keep(root);
}

/** The first child element with this local name. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((candidate) => candidate.name === name);
}

/** All child elements with this local name, in document order. */
export function childrenNamed(element: XmlElement | undefined, name: string): XmlElement[] {
  return element === undefined
    ? []
    : element.children.filter((candidate) => candidate.name === name);
}

/** The element at a path of local names (first match at each step). */
export function at(
  element: XmlElement | undefined,
  ...path: readonly string[]
): XmlElement | undefined {
  let current = element;
  for (const name of path) {
    current = child(current, name);
    if (current === undefined) return undefined;
  }
  return current;
}

/** The trimmed text at a path; `undefined` when the element is missing or empty. */
export function textAt(
  element: XmlElement | undefined,
  ...path: readonly string[]
): string | undefined {
  const text = at(element, ...path)?.text;
  return text === undefined || text === "" ? undefined : text;
}

/** An attribute (one without a prefix) by name; `undefined` when missing or empty. */
export function attribute(element: XmlElement | undefined, name: string): string | undefined {
  const value = element?.attributes[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

/**
 * Namespace declarations in scope, as a chain from the innermost declaring element outwards
 * (at most {@link MAX_XML_DEPTH} links). A chain, not a merged map per element: copying the
 * outer declarations for every element that declares one would be quadratic in a hostile file.
 */
interface Namespaces {
  /** Declarations of one element: prefix ("" for the default namespace) → URI. */
  readonly declared: ReadonlyMap<string, string>;
  readonly outer: Namespaces | undefined;
}

/** Whether the bytes start with a UTF-16 (BE/LE) or UTF-32 BE byte order mark. */
export function hasWideByteOrderMark(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
  );
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  if (hasWideByteOrderMark(bytes)) {
    throw xmlRefusal(
      `${what} is encoded as UTF-16 or UTF-32. XRechnung and ZUGFeRD require UTF-8; ask the ` +
        "sender for a UTF-8 file",
    );
  }
  try {
    // `ignoreBOM: false` (the default) strips a leading UTF-8 byte order mark.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw xmlRefusal(`${what} is not valid UTF-8 text`);
  }
}

/**
 * Converts fast-xml-parser's ordered output (`[{tag: [children], ":@": {attrs}}, {"#text": …}]`)
 * into elements. `scope` holds the namespace declarations of the ancestors. Recursion depth is
 * bounded by {@link MAX_XML_DEPTH} (enforced by the parser).
 */
function toElements(nodes: unknown, scope: Namespaces | undefined): XmlElement[] {
  if (!Array.isArray(nodes)) return [];
  const elements: XmlElement[] = [];
  for (const node of nodes as unknown[]) {
    if (typeof node !== "object" || node === null) continue;
    const entry = node as Record<string, unknown>;
    const tag = Object.keys(entry).find((key) => key !== ATTRIBUTES_KEY);
    if (tag === undefined || tag === TEXT_KEY || tag === CDATA_KEY) continue;
    elements.push(toElement(tag, entry[tag], entry[ATTRIBUTES_KEY], scope));
  }
  return elements;
}

function toElement(
  tag: string,
  content: unknown,
  rawAttributes: unknown,
  outer: Namespaces | undefined,
): XmlElement {
  const { prefix, local } = splitName(tag);
  const attributes: Record<string, string> = {};
  let declared: Map<string, string> | undefined;
  if (typeof rawAttributes === "object" && rawAttributes !== null) {
    for (const [key, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const decoded = decodeEntities(value);
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        declared ??= new Map();
        declared.set(key === "xmlns" ? "" : key.slice("xmlns:".length), decoded.trim());
      } else if (!key.includes(":")) {
        attributes[key] = decoded;
      }
    }
  }
  // An element's own declarations apply to itself and to everything below it.
  const scope = declared === undefined ? outer : { declared, outer };
  const namespace = resolveNamespace(scope, prefix ?? "");
  const texts: string[] = [];
  const children: XmlElement[] = [];
  if (Array.isArray(content)) {
    for (const node of content as unknown[]) {
      if (typeof node !== "object" || node === null) continue;
      const entry = node as Record<string, unknown>;
      const text = entry[TEXT_KEY];
      if (typeof text === "string" || typeof text === "number") {
        texts.push(decodeEntities(String(text)));
        continue;
      }
      if (CDATA_KEY in entry) {
        texts.push(cdataText(entry[CDATA_KEY]));
        continue;
      }
      children.push(...toElements([entry], scope));
    }
  }
  return { name: local, prefix, namespace, attributes, children, text: texts.join("").trim() };
}

/** CDATA content as fast-xml-parser delivers it: `[{"#text": "…"}]`; kept verbatim. */
function cdataText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as unknown[])
    .map((part) =>
      typeof part === "object" && part !== null && TEXT_KEY in part
        ? String((part as Record<string, unknown>)[TEXT_KEY])
        : "",
    )
    .join("");
}

function splitName(name: string): { prefix: string | undefined; local: string } {
  const colon = name.indexOf(":");
  return colon === -1
    ? { prefix: undefined, local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** The URI a prefix ("" for the default namespace) is bound to; the innermost declaration wins. */
function resolveNamespace(scope: Namespaces | undefined, prefix: string): string | undefined {
  for (let current = scope; current !== undefined; current = current.outer) {
    const uri = current.declared.get(prefix);
    // `xmlns=""` takes the default namespace away again.
    if (uri !== undefined) return uri === "" ? undefined : uri;
  }
  return undefined;
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};
const ENTITY_REFERENCE = /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g;

/**
 * Decodes the five predefined entities and numeric character references. Other `&name;` stays as
 * written (without a DTD no other entity can be defined). Code points that are not valid XML
 * characters are dropped.
 */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    ENTITY_REFERENCE,
    (_match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return PREDEFINED_ENTITIES[name] ?? "";
      const codePoint = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal);
      return isXmlCharacter(codePoint) ? String.fromCodePoint(codePoint) : "";
    },
  );
}

/** XML 1.0 `Char`: tab, LF, CR, U+0020–U+D7FF, U+E000–U+FFFD, U+10000–U+10FFFF. */
function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** A refusal of the XML itself (trusted text). */
export function xmlRefusal(reason: string): SevdeskError {
  return new SevdeskError({
    kind: "validation",
    message: `${reason}. Nothing was sent to sevDesk.`,
  });
}
