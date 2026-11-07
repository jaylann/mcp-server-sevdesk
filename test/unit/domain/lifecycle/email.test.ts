import { describe, expect, it } from "vitest";

import {
  buildEmail,
  emailAddressInput,
  type EmailRequest,
  isEmailAddress,
} from "../../../../src/domain/lifecycle/email.js";
import { SevdeskError } from "../../../../src/sevdesk/errors.js";

const base: EmailRequest = {
  to: "kunde@example.com",
  subject: "Ihre Rechnung RE-1001",
  text: "Guten Tag,\n\nanbei Ihre Rechnung.\n\nViele Grüße",
};

function refusal(check: () => unknown): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(SevdeskError);
    expect((error as SevdeskError).kind).toBe("validation");
    return (error as SevdeskError).message;
  }
}

describe("isEmailAddress", () => {
  it.each([
    "kunde@example.com",
    "max.mustermann+rechnung@sub.example.co.uk",
    "a@b.de",
    "info@xn--mller-kva.example.xn--p1ai",
    "o'brien@example.org",
  ])("accepts %s", (address) => {
    expect(isEmailAddress(address)).toBe(true);
  });

  it.each([
    ["no at sign", "kunde.example.com"],
    ["an empty local part", "@example.com"],
    ["a single-label domain", "kunde@localhost"],
    ["an IP literal", "kunde@[192.0.2.1]"],
    ["a numeric top-level domain", "kunde@example.123"],
    ["two addresses", "a@example.com,b@example.com"],
    ["a display name", "Max <max@example.com>"],
    ["spaces", "max mustermann@example.com"],
    ["a leading dot", ".max@example.com"],
    ["two dots", "max..m@example.com"],
    ["non-ASCII", "müller@example.com"],
    ["a hyphen at a label edge", "max@-example.com"],
    ["a local part over 64 characters", `${"a".repeat(65)}@example.com`],
    [
      "more than 254 characters",
      `max@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`,
    ],
  ])("refuses %s", (_label, address) => {
    expect(isEmailAddress(address)).toBe(false);
  });

  it("trims arguments before checking them", () => {
    expect(emailAddressInput.parse("  kunde@example.com ")).toBe("kunde@example.com");
    expect(emailAddressInput.safeParse("kunde").success).toBe(false);
  });
});

describe("buildEmail", () => {
  it("builds the minimal body with only the required fields", () => {
    expect(buildEmail("invoice", base)).toEqual({
      payload: { toEmail: "kunde@example.com", subject: base.subject, text: base.text },
      recipients: { to: "kunde@example.com", cc: [], bcc: [] },
    });
  });

  it("joins cc and bcc with commas and sends copy and sendXml only when true", () => {
    const { payload, recipients } = buildEmail("invoice", {
      ...base,
      cc: ["a@example.com", "b@example.com"],
      bcc: ["c@example.com"],
      sendCopyToMe: true,
      attachXml: true,
    });
    expect(payload).toEqual({
      toEmail: "kunde@example.com",
      subject: base.subject,
      text: base.text,
      copy: true,
      ccEmail: "a@example.com,b@example.com",
      bccEmail: "c@example.com",
      sendXml: true,
    });
    expect(recipients).toEqual({
      to: "kunde@example.com",
      cc: ["a@example.com", "b@example.com"],
      bcc: ["c@example.com"],
    });
    expect(
      buildEmail("order", { ...base, sendCopyToMe: false, attachXml: false }).payload,
    ).not.toHaveProperty("copy");
  });

  it("refuses an address listed twice, ignoring case", () => {
    expect(refusal(() => buildEmail("invoice", { ...base, bcc: ["KUNDE@example.com"] }))).toBe(
      "The same email address is listed twice (to, cc, bcc); list each recipient once.",
    );
  });

  it("refuses a subject with a line break, naming the code point", () => {
    expect(
      refusal(() => buildEmail("invoice", { ...base, subject: "a\nBcc: x@example.com" })),
    ).toBe(
      "The email subject contains characters a reader would not see as they are (U+000A); " +
        "the subject must be a single line. Remove them so the approved text is exactly what " +
        "the recipient reads.",
    );
  });

  // Built with String.fromCodePoint: the characters must not sit literally in the source.
  const hidden: [string, number][] = [
    ["a variation selector", 0xfe0f],
    ["a supplementary variation selector", 0xe0100],
    ["the combining grapheme joiner U+034F", 0x034f],
    ["the Hangul choseong filler", 0x115f],
    ["the Hangul filler", 0x3164],
    ["the halfwidth Hangul filler", 0xffa0],
    ["the line separator U+2028", 0x2028],
    ["a zero-width space", 0x200b],
    ["a bidi override", 0x202e],
    ["a control character", 0x07],
  ];

  it.each(hidden)("refuses %s in the subject", (_label, codePoint) => {
    const subject = `Rechnung${String.fromCodePoint(codePoint)} RE-1001`;
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    expect(refusal(() => buildEmail("invoice", { ...base, subject }))).toContain(
      `The email subject contains characters a reader would not see as they are (${label});`,
    );
  });

  it.each(hidden)("refuses %s in the text", (_label, codePoint) => {
    const text = `Guten Tag,\n\nanbei${String.fromCodePoint(codePoint)} Ihre Rechnung.`;
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    expect(refusal(() => buildEmail("invoice", { ...base, text }))).toBe(
      `The email text contains characters a reader would not see as they are (${label}); ` +
        "only plain line breaks (U+000A) are allowed. Remove them so the approved text is " +
        "exactly what the recipient reads.",
    );
  });

  it("allows plain line breaks in the text but not tabs or CR", () => {
    expect(buildEmail("invoice", { ...base, text: "a\nb\n\nc" }).payload.text).toBe("a\nb\n\nc");
    expect(refusal(() => buildEmail("invoice", { ...base, text: "a\tb\r\nc" }))).toContain(
      "(U+0009, U+000D)",
    );
  });

  it("lists at most ten code points and counts the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) => String.fromCodePoint(0xfe00 + i)).join("");
    expect(refusal(() => buildEmail("invoice", { ...base, text: `x${many}` }))).toContain(
      "U+FE09 and 2 more);",
    );
  });

  it("refuses XML attachments for credit notes and orders", () => {
    expect(refusal(() => buildEmail("creditNote", { ...base, attachXml: true }))).toBe(
      "Only invoices can attach the e-invoice XML.",
    );
  });
});
