/**
 * Deterministic scrubber for data recorded from a real sevDesk account (fixture recordings and
 * probe evidence). It replaces personal and company data with obvious fakes while keeping every
 * key, every `null`, every number and boolean, and the scalar types sevDesk sends: strings stay
 * strings, numeric strings (ids, amounts, status codes, `"0"`/`"1"`) and dates stay as recorded.
 *
 * Rules, in order, for every string:
 * 1. Secrets (the API token) are replaced wherever they occur, also inside longer strings.
 * 2. Reference data (`mode: "reference"`, or an object whose `objectName` is a system list such as
 *    `TaxRule` or `Unity`) stays verbatim, except for the safety patterns below.
 * 3. Key rules: names, e-mails, phones, IBAN/BIC, VAT and tax ids, street addresses, free texts,
 *    bank purposes, file names, URLs, document and customer numbers, IPs, birthdays, passwords.
 * 4. Code-like keys (`status`, `currency`, `invoiceType`, …) and value shapes (numbers, dates)
 *    stay.
 * 5. Value patterns anywhere: e-mail, URL, IBAN, IPv4, VAT id, phone number, 32-hex tokens
 *    (upload file names, hashes), XML documents and base64 PDFs.
 * 6. Upper-case codes (`RE`, `VPR`, `P0Y1M0W`) stay; any other text becomes `Muster-Text N` and its
 *    key is reported in {@link ScrubStats.defaultedKeys} for review.
 *
 * Fakes come from per-category counters (`Musterfirma 1 GmbH`, `person2@example.com`), so the
 * same original value maps to the same fake across all files of one run, and no hash or fragment
 * of the original ends up in the output. The `id` of a `SevClient` reference (the account id) is
 * replaced too; other ids stay.
 */

/** `full` for business data; `reference` for system lists (only the safety patterns apply). */
export type ScrubMode = "full" | "reference";

export interface ScrubberOptions {
  /** Exact strings that must never appear in the output (the API token). Empty strings are ignored. */
  readonly secrets: readonly string[];
}

interface ScrubStats {
  /** Replacements per rule, e.g. `{ email: 3, "free-text": 12 }`. */
  readonly byRule: Readonly<Record<string, number>>;
  /** Keys whose text fell through to the default free-text rule (sorted): review these. */
  readonly defaultedKeys: readonly string[];
}

export interface Scrubber {
  /** Returns a scrubbed deep copy of `value` (JSON-like data). Never mutates the input. */
  scrub(value: unknown, mode?: ScrubMode): unknown;
  /** Scrubs one free-standing string (e.g. an upstream error message) with the safety patterns. */
  scrubText(text: string): string;
  stats(): ScrubStats;
}

/** What a secret is replaced with. */
export const REDACTED = "<redacted>";

/** A tiny, valid, obviously fake PDF ("%PDF-1.4 … scrubbed"), base64. */
export const FAKE_PDF_BASE64 =
  "JVBERi0xLjQKJSBzY3J1YmJlZCBieSBzY3JpcHRzL2xpYi9zY3J1Yi50cwoxIDAgb2JqIDw8IC9UeXBlIC9DYXRhbG9nID4+IGVuZG9iagp0cmFpbGVyIDw8IC9Sb290IDEgMCBSID4+CiUlRU9GCg==";

/**
 * System lists that carry no personal data and stay verbatim (README: "System reference data …
 * may stay verbatim").
 */
const REFERENCE_OBJECTS: ReadonlySet<string> = new Set([
  "TaxRule",
  "Unity",
  "Category",
  "CommunicationWayKey",
  "StaticCountry",
  "PaymentMethod",
  "AccountDatev",
  "TaxSet",
]);

/** Keys whose string values are codes, enums or labels from sevDesk itself: kept verbatim. */
const KEEP_KEYS: ReadonlySet<string> = new Set(
  [
    "objectName",
    "objectType",
    "status",
    "currency",
    "invoiceType",
    "creditNoteType",
    "orderType",
    "voucherType",
    "sendType",
    "taxType",
    "taxText",
    "type",
    "creditDebit",
    "gender",
    "addressGender",
    "role",
    "languageCode",
    "locale",
    "bookingCategory",
    "accountIntervall",
    "recurringInterval",
    "translationCode",
    "importType",
    "countryCode",
    "countryContactType",
    "code",
    "color",
    "version",
    "mimeType",
    "mimetype",
    "contentType",
    "base64encoded",
    "base64Encoded",
    "uneceTradeUnitCode",
    "unitySystem",
    "exceptionUUID",
    "propertyIsEInvoice",
  ].map((key) => key.toLowerCase()),
);

type KeyRule =
  | "org"
  | "person-first"
  | "person-last"
  | "person-full"
  | "initials"
  | "username"
  | "email"
  | "phone"
  | "iban"
  | "bic"
  | "vat"
  | "tax-number"
  | "buyer-reference"
  | "street"
  | "zip"
  | "city"
  | "address"
  | "free-text"
  | "file-name"
  | "url"
  | "host"
  | "doc-number"
  | "ip"
  | "birthday"
  | "password"
  | "contact-value";

const KEY_RULES: ReadonlyMap<string, KeyRule> = new Map(
  (
    [
      ["name2", "org"],
      ["companyName", "org"],
      ["supplierName", "org"],
      ["supplierNameAtSave", "org"],
      ["payeePayerName", "org"],
      ["recipientName", "org"],
      ["surename", "person-first"],
      ["firstName", "person-first"],
      ["familyname", "person-last"],
      ["lastName", "person-last"],
      ["fullname", "person-full"],
      ["smtpName", "person-full"],
      ["contactPersonName", "person-full"],
      ["memberCode", "initials"],
      ["username", "username"],
      ["smtpUser", "username"],
      ["email", "email"],
      ["smtpMail", "email"],
      ["emailAddress", "email"],
      ["phone", "phone"],
      ["mobile", "phone"],
      ["fax", "phone"],
      ["telephone", "phone"],
      ["phoneNumber", "phone"],
      ["iban", "iban"],
      ["bankAccount", "iban"],
      ["bankAccountNumber", "iban"],
      ["payeePayerAcctNo", "iban"],
      ["bic", "bic"],
      ["bankNumber", "bic"],
      ["bankCode", "bic"],
      ["payeePayerBankCode", "bic"],
      ["vatNumber", "vat"],
      ["vatId", "vat"],
      ["ustId", "vat"],
      ["taxNumber", "tax-number"],
      ["buyerReference", "buyer-reference"],
      ["street", "street"],
      ["zip", "zip"],
      ["postalCode", "zip"],
      ["city", "city"],
      ["address", "address"],
      ["description", "free-text"],
      ["header", "free-text"],
      ["headText", "free-text"],
      ["footText", "free-text"],
      ["text", "free-text"],
      ["customerInternalNote", "free-text"],
      ["internalComment", "free-text"],
      ["paymentPurpose", "free-text"],
      ["paymtPurpose", "free-text"],
      ["purpose", "free-text"],
      ["note", "free-text"],
      ["notes", "free-text"],
      ["comment", "free-text"],
      ["subject", "free-text"],
      ["bookingText", "free-text"],
      ["entryText", "free-text"],
      ["additionalInformation", "free-text"],
      ["deliveryTerms", "free-text"],
      ["paymentTerms", "free-text"],
      ["taxOffice", "free-text"],
      ["academicTitle", "free-text"],
      ["bankServer", "free-text"],
      ["signature", "free-text"],
      ["filename", "file-name"],
      ["fileName", "file-name"],
      ["originalFilename", "file-name"],
      ["url", "url"],
      ["link", "url"],
      ["website", "url"],
      ["homepage", "url"],
      ["downloadUrl", "url"],
      ["smtpHost", "host"],
      ["invoiceNumber", "doc-number"],
      ["creditNoteNumber", "doc-number"],
      ["orderNumber", "doc-number"],
      ["voucherNumber", "doc-number"],
      ["customerNumber", "doc-number"],
      ["supplierNumber", "doc-number"],
      ["partNumber", "doc-number"],
      ["ip", "ip"],
      ["lastLoginIp", "ip"],
      ["clientIp", "ip"],
      ["birthday", "birthday"],
      ["birthDate", "birthday"],
      ["pin", "password"],
      ["password", "password"],
      ["smtpPassword", "password"],
      ["token", "password"],
      ["apiToken", "password"],
      ["apiKey", "password"],
      ["secret", "password"],
      ["value", "contact-value"],
    ] as const
  ).map(([key, rule]) => [key.toLowerCase(), rule]),
);

/** `name` of these objects is a person's or company's name; elsewhere it is a business label. */
const NAME_LABELS: Readonly<Record<string, string>> = {
  Part: "Musterartikel",
  InvoicePos: "Musterposition",
  OrderPos: "Musterposition",
  CreditNotePos: "Musterposition",
  VoucherPos: "Musterposition",
  CheckAccount: "Musterkonto",
  Document: "Musterdokument",
  DocumentFolder: "Musterordner",
  Tag: "Mustertag",
};

const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$|^\d{2}\.\d{2}\.\d{4}$/;
const UPPER_CODE = /^[A-Z0-9][A-Z0-9_./%:-]{0,15}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const IBAN = /^[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const VAT = /^(?:ATU|DE|CHE|[A-Z]{2})\d{8,12}$/;
const PHONE = /^\+?[\d ()/-]{7,}$/;
const HEX32 = /(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/g;
const XML_DECLARATION = /^\s*<\?xml[^>]*\?>/;

interface Context {
  readonly key: string | undefined;
  readonly objectName: string | undefined;
  readonly mode: ScrubMode;
}

/** Creates a scrubber; counters (and so the fake values) are shared by everything it scrubs. */
export function createScrubber(options: ScrubberOptions): Scrubber {
  const secrets = options.secrets.filter((secret) => secret.length > 0);
  const byRule = new Map<string, number>();
  const defaultedKeys = new Set<string>();
  const fakes = new Map<string, Map<string, string>>();

  function count(rule: string): void {
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  /** The same original in the same category always gets the same fake. */
  function fake(category: string, original: string, make: (n: number) => string): string {
    let table = fakes.get(category);
    if (table === undefined) {
      table = new Map();
      fakes.set(category, table);
    }
    const known = table.get(original);
    if (known !== undefined) return known;
    const made = make(table.size + 1);
    table.set(original, made);
    return made;
  }

  function replaceSecrets(text: string): string {
    let result = text;
    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
        count("secret");
      }
    }
    return result;
  }

  function replaceHex(text: string): string {
    return text.replace(HEX32, (match) => {
      count("hex-token");
      return fake("hex", match.toLowerCase(), (n) => n.toString(16).padStart(32, "0"));
    });
  }

  /** Safety patterns that apply even to reference data and error messages. */
  function safety(text: string): string {
    if (XML_DECLARATION.test(text)) {
      count("xml");
      return scrubXml(text);
    }
    // URLs first: their fakes contain no "@", so a URL never turns into an e-mail fake.
    let result = replaceHex(text).replace(new RegExp(URL_PATTERN.source, "gi"), (match) => {
      count("url");
      return fake("url", match, (n) => `https://example.com/scrubbed/${n}`);
    });
    result = result.replace(new RegExp(EMAIL.source, "g"), (match) => {
      count("email");
      return fake("email", match.toLowerCase(), (n) => `person${n}@example.com`);
    });
    if (IBAN.test(result)) {
      count("iban");
      return fake("iban", result.replace(/ /g, ""), ibanFake);
    }
    if (IPV4.test(result)) {
      count("ip");
      return fake("ip", result, (n) => `192.0.2.${(n % 254) + 1}`);
    }
    return result;
  }

  function byKeyRule(rule: KeyRule, value: string, ctx: Context): string {
    count(rule);
    switch (rule) {
      case "org":
        return fake("org", value, (n) => `Musterfirma ${n} GmbH`);
      case "person-first":
        return fake("first", value, (n) => `Vorname${n}`);
      case "person-last":
        return fake("last", value, (n) => `Mustermann${n}`);
      case "person-full":
        return fake("full", value, (n) => `Max Mustermann${n}`);
      case "initials":
        return "MM";
      case "username":
        return EMAIL.test(value)
          ? fake("email", value.toLowerCase(), (n) => `person${n}@example.com`)
          : fake("user", value, (n) => `user${n}`);
      case "email":
        return fake("email", value.toLowerCase(), (n) => `person${n}@example.com`);
      case "phone":
        return fake("phone", value, (n) => `+49 30 ${String(n).padStart(7, "0")}`);
      case "iban":
        return fake("iban", value.replace(/ /g, ""), ibanFake);
      case "bic":
        return fake("bic", value, (n) => `TEST${String(n).padStart(2, "0")}XXXXX`.slice(0, 11));
      case "vat":
        return fake("vat", value, (n) => `DE${String(n).padStart(9, "0")}`);
      case "tax-number":
        return fake("tax-number", value, (n) => `000/000/${String(n).padStart(5, "0")}`);
      case "buyer-reference":
        return fake("buyer-reference", value, (n) => `00000000-${String(n).padStart(5, "0")}-00`);
      case "street":
        return fake("street", value, (n) => `Musterstraße ${n}`);
      case "zip":
        return fake("zip", value, (n) => String(n).padStart(Math.max(value.length, 1), "0"));
      case "city":
        return fake("city", value, (n) => `Musterstadt ${n}`);
      case "address":
        return fake(
          "address",
          value,
          (n) => `Musterfirma ${n} GmbH\nMusterstraße ${n}\n00000 Musterstadt`,
        );
      case "free-text":
        return fake("text", value, (n) => `Muster-Text ${n}`);
      case "file-name":
        return fake("file", value, (n) => `datei-${n}${extensionOf(value)}`);
      case "url":
        return fake("url", value, (n) => `https://example.com/scrubbed/${n}`);
      case "host":
        return fake("host", value, (n) => `smtp${n}.example.com`);
      case "doc-number":
        return fake(`number:${ctx.key ?? ""}`, value, (n) => replaceDigits(value, n));
      case "ip":
        return fake("ip", value, (n) => `192.0.2.${(n % 254) + 1}`);
      case "birthday":
        return value.length >= 10 ? `1970-01-01${value.slice(10)}` : "1970-01-01";
      case "password":
        return REDACTED;
      case "contact-value":
        // CommunicationWay.value and similar: e-mail, phone or URL depending on the row.
        if (EMAIL.test(value)) return byKeyRule("email", value, ctx);
        if (URL_PATTERN.test(value)) return byKeyRule("url", value, ctx);
        if (PHONE.test(value)) return byKeyRule("phone", value, ctx);
        return byKeyRule("free-text", value, ctx);
    }
  }

  function nameRule(ctx: Context): KeyRule | { readonly label: string } {
    if (ctx.objectName === "Contact" || ctx.objectName === undefined) return "org";
    return { label: NAME_LABELS[ctx.objectName] ?? "Mustername" };
  }

  function scrubString(original: string, ctx: Context): string {
    const value = replaceSecrets(original);
    if (value === "" || value === REDACTED) return value;
    if (ctx.mode === "reference" || REFERENCE_OBJECTS.has(ctx.objectName ?? "")) {
      return safety(value);
    }

    const key = ctx.key?.toLowerCase();
    if (key !== undefined) {
      if (key === "name") {
        const rule = nameRule(ctx);
        if (typeof rule === "string") return byKeyRule(rule, value, ctx);
        count("label");
        return fake(`label:${rule.label}`, value, (n) => `${rule.label} ${n}`);
      }
      if ((key === "content" || key === "pdf") && value.length > 100) {
        count("base64");
        return value.startsWith("JVBER") ? FAKE_PDF_BASE64 : "c2NydWJiZWQ=";
      }
      const rule = KEY_RULES.get(key) ?? addressRule(key);
      if (rule !== undefined) return byKeyRule(rule, value, ctx);
      if (KEEP_KEYS.has(key)) return value;
    }

    if (NUMERIC.test(value) || DATE_LIKE.test(value)) return value;
    const patterned = safety(value);
    if (patterned !== value) return patterned;
    if (VAT.test(value)) return byKeyRule("vat", value, ctx);
    if (PHONE.test(value) && /\d{6,}/.test(value.replace(/\D/g, ""))) {
      return byKeyRule("phone", value, ctx);
    }
    if (UPPER_CODE.test(value)) return value;

    defaultedKeys.add(ctx.key ?? "(root)");
    return byKeyRule("free-text", value, ctx);
  }

  function walk(value: unknown, ctx: Context): unknown {
    if (typeof value === "string") return scrubString(value, ctx);
    if (Array.isArray(value)) return value.map((item) => walk(item, ctx));
    if (value === null || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    const objectName = typeof record["objectName"] === "string" ? record["objectName"] : undefined;
    const result: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(record)) {
      if (objectName === "SevClient" && key === "id") {
        count("sev-client");
        result[key] = fakeSevClientId(member);
        continue;
      }
      result[key] = walk(member, { key, objectName, mode: ctx.mode });
    }
    return result;
  }

  function fakeSevClientId(member: unknown): unknown {
    if (typeof member === "number") return 9001;
    if (typeof member === "string") return replaceSecrets(member) === "" ? "" : "9001";
    return member;
  }

  return {
    scrub(value, mode = "full") {
      return walk(value, { key: undefined, objectName: undefined, mode });
    },
    scrubText(text) {
      return safety(replaceSecrets(text));
    },
    stats() {
      return {
        byRule: Object.fromEntries([...byRule.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
        defaultedKeys: [...defaultedKeys].sort(),
      };
    },
  };
}

/**
 * Throws when any secret occurs in `text`. The message never contains the secret itself. Call it
 * on the final serialized output before writing anything to disk.
 */
export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error("Refusing to write: the output still contains a secret (the API token).");
    }
  }
}

/** `addressStreet` → street, `addressZip` → zip, `addressName` → org, … (Invoice/Order fields). */
function addressRule(key: string): KeyRule | undefined {
  if (!key.startsWith("address") || key === "address" || KEEP_KEYS.has(key)) return undefined;
  if (key.includes("gender") || key.includes("country")) return undefined;
  if (key.includes("street")) return "street";
  if (key.includes("zip")) return "zip";
  if (key.includes("city")) return "city";
  if (key.includes("name")) return "org";
  return "address";
}

function ibanFake(n: number): string {
  return `DE${String(n).padStart(20, "0")}`;
}

function extensionOf(fileName: string): string {
  const match = /\.[A-Za-z0-9]{1,5}$/.exec(fileName);
  return match === null ? "" : match[0].toLowerCase();
}

/**
 * Replaces the digits of a document number with `n`, keeping letters, separators and `%…%`
 * placeholders (D-027 evidence): `RE-1038` → `RE-0001`, `RE-%YYYY%MM1038` → `RE-%YYYY%MM0001`.
 */
function replaceDigits(value: string, n: number): string {
  const digitCount = (value.match(/\d/g) ?? []).length;
  if (digitCount === 0) return value;
  const digits = String(n).padStart(digitCount, "0").slice(-digitCount);
  let index = 0;
  return value.replace(/\d/g, () => digits[index++] ?? "0");
}

/**
 * Keeps the XML declaration, the root element's name and its namespace declarations (enough to
 * tell CII from UBL and to check the encoding), and drops everything else.
 */
function scrubXml(xml: string): string {
  const declaration = XML_DECLARATION.exec(xml)?.[0].trim() ?? "";
  const rest = xml
    .slice(XML_DECLARATION.exec(xml)?.[0].length ?? 0)
    .replace(/<!--[\s\S]*?-->/g, "");
  const root = /<([A-Za-z_][\w.:-]*)([^>]*)>/.exec(rest);
  if (root === null) return `${declaration}\n<!-- scrubbed: ${xml.length} characters -->`;
  const name = root[1] ?? "root";
  const namespaces = (root[2] ?? "").match(/\sxmlns(?::[\w.-]+)?="[^"]*"/g) ?? [];
  return (
    `${declaration}\n<${name}${namespaces.join("")}>\n` +
    `<!-- scrubbed by scripts/lib/scrub.ts: ${xml.length} characters -->\n</${name}>`
  );
}
