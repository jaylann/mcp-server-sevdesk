import { describe, expect, it } from "vitest";

import {
  at,
  attribute,
  child,
  childrenNamed,
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
          '<rsm:Root xmlns:rsm="urn:example:root" xmlns:ram="urn:example:ram" rsm:kind="a&amp;b">' +
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
