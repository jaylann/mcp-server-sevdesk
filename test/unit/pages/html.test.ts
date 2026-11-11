import { describe, expect, it } from "vitest";

import { escapeHtml, Html, type HtmlValue, markup, trusted } from "../../../src/pages/html.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
    expect(escapeHtml("Müller & Söhne")).toBe("Müller &amp; Söhne");
  });
});

describe("markup", () => {
  it("escapes every interpolated string, in text and in attributes", () => {
    const hostile = `"><script>alert('x')</script>`;
    const page = markup`<a href="${hostile}">${hostile}</a>`.toString();
    expect(page).toBe(
      '<a href="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;">' +
        "&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</a>",
    );
    expect(page).not.toContain("<script");
  });

  it("keeps markup built by markup or trusted, and its own static parts, as written", () => {
    const inner = markup`<strong>${"a & b"}</strong>`;
    const icon = trusted('<svg viewBox="0 0 1 1"/>');
    expect(markup`<p>${inner} ${icon}</p>`.toString()).toBe(
      '<p><strong>a &amp; b</strong> <svg viewBox="0 0 1 1"/></p>',
    );
    // Whitespace of the template reaches the page untouched: values keep their line breaks.
    expect(markup`<dd>${"one\n  two"}</dd>`.toString()).toBe("<dd>one\n  two</dd>");
  });

  it("renders numbers, lists and nothing for absent values", () => {
    const rows = ["a<", "b"].map((cell) => markup`<li>${cell}</li>`);
    expect(markup`<ul>${rows}</ul>`.toString()).toBe("<ul><li>a&lt;</li><li>b</li></ul>");
    expect(markup`${["<", markup`<b>`, 2]}`.toString()).toBe("&lt;<b>2");
    const shown = (value: HtmlValue): string => markup`[${value}]`.toString();
    const values: HtmlValue[] = [undefined, null, false, 0, ""];
    expect(values.map(shown)).toEqual(["[]", "[]", "[]", "[0]", "[]"]);
    expect(markup`${1.5}`.toString()).toBe("1.5");
    expect(markup``.toString()).toBe("");
  });

  it("does not take a string for markup because it looks like markup", () => {
    expect(markup`${"<b>bold</b>"}`.toString()).toBe("&lt;b&gt;bold&lt;/b&gt;");
    // Only the class marks safe markup; its text is read through toString.
    const safe = trusted("<b>bold</b>");
    expect(safe).toBeInstanceOf(Html);
    expect(String(safe)).toBe("<b>bold</b>");
    expect(Object.keys(safe)).toEqual([]);
  });
});
