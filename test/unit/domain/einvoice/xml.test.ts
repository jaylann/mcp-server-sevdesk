import { describe, expect, it } from "vitest";

import {
  at,
  attribute,
  child,
  childrenNamed,
  elementsOf,
  hasWideByteOrderMark,
  MAX_XML_DEPTH,
  parseXmlDocument,
  textAt,
} from "../../../../src/domain/einvoice/xml.js";
import { utf8, validationMessage } from "./helpers.js";

async function refused(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? utf8(text) : text;
  return validationMessage(Promise.resolve().then(() => parseXmlDocument(bytes)));
}

describe("parseXmlDocument", () => {
  it("removes prefixes, keeps the root namespace and decodes entities and CDATA", () => {
    const document = parseXmlDocument(
      utf8(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<rsm:Root xmlns:rsm="urn:example:root" xmlns:ram="urn:example:ram" kind="a&amp;b">' +
          "<!-- a comment --><?pi data?>" +
          "<ram:Name>Station&amp;Service &lt;AG&gt; &#228;&#xFC; &quot;x&quot; &apos;y&apos; &unknown;</ram:Name>" +
          "<ram:Raw><![CDATA[&amp; <kept>]]></ram:Raw>" +
          '<ram:Item n="1">first</ram:Item><ram:Item n="2">second</ram:Item>' +
          "<ram:Empty/><ram:Control>&#1;&#xD800;ok</ram:Control>" +
          "</rsm:Root>",
      ),
    );
    expect(document.namespace).toBe("urn:example:root");
    expect(document.root).toMatchObject({
      name: "Root",
      prefix: "rsm",
      attributes: { kind: "a&b" },
    });
    expect(textAt(document.root, "Name")).toBe("Station&Service <AG> äü \"x\" 'y' &unknown;");
    expect(textAt(document.root, "Raw")).toBe("&amp; <kept>");
    expect(childrenNamed(document.root, "Item").map((item) => attribute(item, "n"))).toEqual([
      "1",
      "2",
    ]);
    expect(textAt(document.root, "Empty")).toBeUndefined();
    expect(textAt(document.root, "Control")).toBe("ok");
    expect(textAt(document.root, "Missing", "Deeper")).toBeUndefined();
    expect(at(undefined, "x")).toBeUndefined();
    expect(child(undefined, "x")).toBeUndefined();
    expect(childrenNamed(undefined, "x")).toEqual([]);
    expect(attribute(child(document.root, "Item"), "missing")).toBeUndefined();
  });

  it("reads the default namespace and accepts a UTF-8 byte order mark", () => {
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...utf8('<Invoice xmlns="urn:x"><ID>1</ID></Invoice>'),
    ]);
    const document = parseXmlDocument(bytes);
    expect(document.namespace).toBe("urn:x");
    expect(document.root.prefix).toBeUndefined();
    expect(parseXmlDocument(utf8("<a/>")).namespace).toBeUndefined();
  });

  it("resolves the namespace of every element from the declarations in scope", () => {
    const { root } = parseXmlDocument(
      utf8(
        '<Root xmlns="urn:default" xmlns:a="urn:a">' +
          "<Plain/><a:Prefixed/>" +
          // A declaration counts for its own element and everything below, not for siblings.
          '<a:Rebound xmlns:a="urn:other"><a:Inner/><Plain/></a:Rebound><a:After/>' +
          // `xmlns=""` takes the default namespace away; an undeclared prefix has none.
          '<None xmlns=""><Below/></None><b:Undeclared/>' +
          '<c:Late xmlns:c=" urn:c "/>' +
          "</Root>",
      ),
    );
    const namespaces = (element: typeof root): unknown[] =>
      element.children.map((entry) => [entry.name, entry.namespace]);
    expect(root.namespace).toBe("urn:default");
    expect(namespaces(root)).toEqual([
      ["Plain", "urn:default"],
      ["Prefixed", "urn:a"],
      ["Rebound", "urn:other"],
      ["After", "urn:a"],
      ["None", undefined],
      ["Undeclared", undefined],
      ["Late", "urn:c"],
    ]);
    expect(namespaces(child(root, "Rebound") ?? root)).toEqual([
      ["Inner", "urn:other"],
      ["Plain", "urn:default"],
    ]);
    expect(namespaces(child(root, "None") ?? root)).toEqual([["Below", undefined]]);
  });

  it("drops attributes with a prefix, so none can stand in for a plain one", () => {
    const { root } = parseXmlDocument(
      utf8(
        '<Amount xmlns:x="urn:x" xmlns:xsi="urn:xsi" x:currencyID="EUR" currencyID="USD" ' +
          'xsi:type="t" xml:lang="de">1</Amount>',
      ),
    );
    expect(root.attributes).toEqual({ currencyID: "USD" });
    const { root: only } = parseXmlDocument(
      utf8('<Amount xmlns:x="urn:x" x:currencyID="EUR">1</Amount>'),
    );
    expect(attribute(only, "currencyID")).toBeUndefined();
  });

  it("keeps only the elements of a syntax (elementsOf)", () => {
    const { root } = parseXmlDocument(
      utf8(
        '<r:Root xmlns:r="urn:root" xmlns:f="urn:fields" xmlns:x="urn:foreign">' +
          "<x:Code>foreign first</x:Code><f:Code>real</f:Code>" +
          "<x:Group><f:Code>inside a foreign group</f:Code></x:Group>" +
          "<f:Group><x:Code>foreign inside</x:Code><f:Code>inner</f:Code></f:Group>" +
          "</r:Root>",
      ),
    );
    // Without the filter the first element of that local name wins, whatever its namespace.
    expect(textAt(root, "Code")).toBe("foreign first");
    const fields = elementsOf(root, (_name, namespace) => namespace === "urn:fields");
    expect(textAt(fields, "Code")).toBe("real");
    expect(childrenNamed(fields, "Group")).toHaveLength(1);
    expect(textAt(fields, "Group", "Code")).toBe("inner");
    expect(fields.children.map((entry) => entry.name)).toEqual(["Code", "Group"]);
    // The copy is new; the parsed tree is unchanged.
    expect(root.children).toHaveLength(4);
  });

  it("resolves many declarations without copying them for every element", () => {
    // 20,000 declarations on the root and 20,000 children that each declare one more: a merged
    // map per element would be 400 million entries.
    const declarations = Array.from(
      { length: 20_000 },
      (_unused, index) => ` xmlns:p${String(index)}="urn:${String(index)}"`,
    ).join("");
    const children = '<p7:C xmlns:q="urn:q"/>'.repeat(20_000);
    const started = performance.now();
    const { root } = parseXmlDocument(utf8(`<Root${declarations}>${children}</Root>`));
    expect(root.children).toHaveLength(20_000);
    expect(root.children.at(-1)?.namespace).toBe("urn:7");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it.each([
    ['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', "DOCTYPE or ENTITY"],
    ["<!doctype a><a/>", "DOCTYPE or ENTITY"],
    ["<a><!-- <! ENTITY hidden --></a>", "DOCTYPE or ENTITY"],
    ['<?xml version="1.0" encoding="ISO-8859-1"?><a/>', "other than UTF-8"],
    ["<a><b></a>", "not well-formed"],
    ["", "not well-formed"],
  ])("refuses %j", async (text, expected) => {
    expect(await refused(text)).toContain(expected);
  });

  it("refuses UTF-16/32 byte order marks and invalid UTF-8", async () => {
    expect(await refused(Uint8Array.from([0xfe, 0xff, 0, 0x3c]))).toContain("UTF-16");
    expect(await refused(Uint8Array.from([0xff, 0xfe, 0x3c, 0]))).toContain("UTF-16");
    expect(await refused(Uint8Array.from([0, 0, 0xfe, 0xff]))).toContain("UTF-32");
    expect(await refused(Uint8Array.from([0x3c, 0x61, 0xff, 0x3e]))).toContain("not valid UTF-8");
    expect(hasWideByteOrderMark(utf8("<a/>"))).toBe(false);
  });

  it(`refuses nesting deeper than ${MAX_XML_DEPTH} levels and accepts it up to the limit`, async () => {
    const nested = (depth: number): string => `${"<a>".repeat(depth)}${"</a>".repeat(depth)}`;
    expect(() => parseXmlDocument(utf8(nested(MAX_XML_DEPTH)))).not.toThrow();
    expect(await refused(nested(MAX_XML_DEPTH + 1))).toContain("deeper than");
  });

  it("names the document in messages", async () => {
    const message = await validationMessage(
      Promise.resolve().then(() => parseXmlDocument(utf8("<a>"), "The PDF's attachment")),
    );
    expect(message).toBe(
      "The PDF's attachment is not well-formed XML. Nothing was sent to sevDesk.",
    );
  });
});
