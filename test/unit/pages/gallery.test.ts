/**
 * What holds for every page of the server, in every state and language: the rules the pages'
 * Content-Security-Policy enforces (a page that broke one would lose its styles or its fonts in
 * the browser, silently), and the basics of a well-formed, accessible form page.
 */
import { describe, expect, it } from "vitest";

import { pageContext } from "../../../src/pages/context.js";
import { LOCALES } from "../../../src/pages/locale.js";
import { GALLERY } from "../../helpers/page-gallery.js";

const ORIGIN = "https://mcp.example.com";
const NONCE = "test-nonce";

const CASES = GALLERY.flatMap((page) =>
  LOCALES.map((locale) => [page.name, locale, page] as const),
);

/** The values of attribute `name` in `html`. */
function attributes(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((match) => match[1] ?? "");
}

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

/** Labels of buttons and links that belong to one language only. */
const ONLY_ENGLISH = [
  ">Approve<",
  ">Reject<",
  ">Sign in<",
  ">Sign out<",
  "Refresh<",
  ">Check token<",
  ">Cancel<",
  ">Connect<",
  "Back to the inbox",
  // The preview of a request, which the tool writes in both languages.
  "Finalize invoice",
  "through sevDesk to",
  "legally binding",
  "Book a payout",
  "Unofficial community project",
];
const ONLY_GERMAN = [
  ">Freigeben<",
  ">Ablehnen<",
  ">Anmelden<",
  ">Abmelden<",
  "Aktualisieren<",
  ">Token prüfen<",
  ">Abbrechen<",
  ">Verbinden<",
  "Zurück zum Freigabe-Postfach",
  "fertigstellen:",
  "über sevDesk per E-Mail senden",
  "rechtlich bindend",
  "Auszahlung von",
  "Inoffizielles Community-Projekt",
];

describe.each(CASES)("page %s (%s)", (_name, locale, page) => {
  const html = page.render({ ...pageContext(locale, ORIGIN), nonce: NONCE });
  const body = html.slice(html.indexOf("<body"));

  it("is a complete document in its language, with one nonce'd style block", () => {
    expect(html.startsWith(`<!doctype html>\n<html lang="${locale}">\n<head>`)).toBe(true);
    expect(html.endsWith("</body>\n</html>\n")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    // Under `no-referrer` browsers would send `Origin: null` with the page's form POSTs.
    expect(html).toContain('<meta name="referrer" content="same-origin">');
    expect(/<title>[^<]+<\/title>/.test(html)).toBe(true);
    expect(count(html, /<style\b/g)).toBe(1);
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(count(body, /<h1\b/g)).toBe(1);
    expect(count(body, /<main>/g)).toBe(1);
  });

  it("has nothing its Content-Security-Policy would block", () => {
    // No script, no inline style attributes, no event handlers, no embedded documents or images.
    for (const banned of [
      /<script/i,
      /\sstyle="/i,
      /\son[a-z]+="/i,
      /<img\b/i,
      /<iframe/i,
      /<object/i,
      /<embed/i,
      /<base\b/i,
      /http-equiv/i,
      /javascript:/i,
      /rel="stylesheet"/i,
    ]) {
      expect(html, String(banned)).not.toMatch(banned);
    }
    // Everything a page links to, loads or posts to is a path on its own origin.
    for (const name of ["href", "src", "action", "formaction"]) {
      for (const value of attributes(html, name)) {
        expect(value, `${name}="${value}"`).toMatch(/^\/(?!\/)/);
      }
    }
    expect(html).not.toMatch(/https?:\/\//);
    // Fonts and the icon come from /assets/; the stamp's filter is in the page itself.
    const loaded = [...html.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1] ?? "");
    for (const url of loaded) expect(url).toMatch(/^(?:\/assets\/[\w.-]+|#[\w-]+)$/);
    expect(attributes(html.slice(0, html.indexOf("<style")), "href")).toEqual([
      expect.stringMatching(/^\/assets\/icon\.[0-9a-f]{12}\.svg$/) as string,
      expect.stringMatching(/^\/assets\/archivo-latin\.[0-9a-f]{12}\.woff2$/) as string,
    ]);
  });

  it("closes what it opens", () => {
    for (const tag of [
      "section",
      "div",
      "form",
      "fieldset",
      "ul",
      "ol",
      "li",
      "dl",
      "dt",
      "dd",
      "p",
      "span",
      "h1",
      "h2",
      "label",
      "a",
      "button",
      "strong",
      "code",
      "svg",
      "time",
    ]) {
      const opened = count(body, new RegExp(`<${tag}(?=[\\s>])`, "g"));
      const closed = count(body, new RegExp(`</${tag}>`, "g"));
      expect(closed, `<${tag}>`).toBe(opened);
    }
  });

  it("labels its fields, protects its forms and hides its decoration", () => {
    const ids = attributes(body, "id");
    expect(new Set(ids).size).toBe(ids.length);
    for (const target of attributes(body, "for")) expect(ids).toContain(target);
    const fields = [...body.matchAll(/<input\b[^>]*type="(?:password|file)"[^>]*>/g)];
    for (const [field] of fields) {
      const id = /\sid="([^"]+)"/.exec(field)?.[1];
      expect(attributes(body, "for"), field).toContain(id);
    }
    for (const [form] of body.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
      expect(form).toMatch(/^<form method="post" action="\/[^"]*"/);
      // Signing in proves the account; every other form acts for a session or a consent.
      if (!form.includes('action="/approvals/login"')) {
        expect(form).toMatch(/<input type="hidden" name="csrf" value="[^"]+">/);
      }
      expect(count(form, /<button\b/g)).toBeGreaterThan(0);
    }
    for (const [button] of body.matchAll(/<button\b[^>]*>/g)) {
      expect(button).toContain('type="submit"');
    }
    // Icons repeat what the text next to them says.
    const withoutStamp = body.replace(/<div class="stamp[\s\S]*?<\/svg><\/div>/, "");
    for (const [svg] of withoutStamp.matchAll(/<svg\b[^>]*>/g)) {
      expect(svg).toContain('aria-hidden="true"');
    }
  });

  it("speaks one language", () => {
    const foreign = locale === "de" ? ONLY_ENGLISH : ONLY_GERMAN;
    for (const label of foreign) expect(body, label).not.toContain(label);
    const own = locale === "de" ? ONLY_GERMAN : ONLY_ENGLISH;
    expect(body).toContain(own.at(-1));
  });
});

describe("page gallery", () => {
  it("covers every kind of page, under unique names", () => {
    const names = GALLERY.map((page) => page.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "approval",
        "approval-email",
        "approved",
        "rejected",
        "inbox",
        "inbox-empty",
        "login",
        "consent",
        "consent-confirm",
        "upload",
        "upload-received",
      ]),
    );
    for (const name of names) expect(name).toMatch(/^[a-z][a-z-]*$/);
  });

  it("renders differently in German and in English", () => {
    for (const page of GALLERY) {
      const english = page.render({ ...pageContext("en", ORIGIN), nonce: NONCE });
      const german = page.render({ ...pageContext("de", ORIGIN), nonce: NONCE });
      expect(german, page.name).not.toBe(english);
    }
  });
});
