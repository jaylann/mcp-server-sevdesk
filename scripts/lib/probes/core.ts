/**
 * Building blocks of the API probe (`pnpm probe`): probe definitions, an HTTP wrapper that keeps
 * scrubbed evidence of every exchange, read helpers, and the factory for tagged test data that
 * write probes create for themselves.
 *
 * Everything goes through the normal sevDesk client, so its safety rules hold: read-only mode
 * refuses data-changing requests before sending, writes are never retried, getPdf always carries
 * `preventSendBy=true`, redirects are refused and the token is redacted from errors.
 */
import type { SevdeskClientEvent } from "../../../src/sevdesk/client.js";
import { SevdeskError, type SevdeskErrorKind } from "../../../src/sevdesk/errors.js";
import type { QueryValue, SevdeskClient } from "../../../src/sevdesk/types.js";
import { rowsOf } from "../fixture-plan.js";
import type { Scrubber } from "../scrub.js";

export type ProbeMode = "read" | "write";
export type Verdict = "confirmed" | "contradicted" | "observed" | "inconclusive";
export type DeviationVerdict = "confirms" | "contradicts" | "informs";
export type Query = Readonly<Record<string, Exclude<QueryValue, undefined>>>;
export type Row = Readonly<Record<string, unknown>>;

/** What a probe concluded. `finding` is trusted text; sevDesk values in it must be scrubbed. */
export interface ProbeOutcome {
  readonly verdict: Verdict;
  readonly finding: string;
  /**
   * Per deviation entry; entries of {@link ProbeDefinition.deviations} without a value here get
   * `confirms` for a confirmed probe, `contradicts` for a contradicted one, else `informs`.
   */
  readonly deviations?: Readonly<Record<string, DeviationVerdict>>;
  /**
   * Long texts the report shows in full, e.g. a scrubbed XML fixture candidate. The probe scrubs
   * them; the runner runs them through the run's scrubber again and caps their size.
   */
  readonly attachments?: readonly ProbeAttachment[];
}

/** A block of text attached to a finding (rendered fenced, inside a collapsed section). */
export interface ProbeAttachment {
  /** Trusted, one line: what it is (e.g. "Fixture candidate: getXml of an e-invoice"). */
  readonly label: string;
  /** Info string of the code fence, e.g. `xml`. */
  readonly language?: string;
  readonly content: string;
}

export interface ProbeDefinition {
  /** Stable id, e.g. `read-getxml-shapes`. */
  readonly id: string;
  readonly title: string;
  /** `write` probes run only with `--allow-writes` and create their own tagged test data. */
  readonly mode: ProbeMode;
  /** The question it answers, for the report and `--list`. */
  readonly question: string;
  /** Entries of spec/deviations.md (or regression ids like B8) it confirms or contradicts. */
  readonly deviations: readonly string[];
  /** Runs only when selected with `--only` (e.g. a request burst). */
  readonly optIn?: boolean;
  /**
   * Sends an e-mail: runs only when the operator passed `--probe-email <address>` (an address they
   * own), and only to that address. Never to a contact's address.
   */
  readonly sendsEmail?: boolean;
  readonly run: (ctx: ProbeContext) => Promise<ProbeOutcome>;
}

/** One request and its answer, scrubbed, as shown in the report. */
export interface Exchange {
  readonly request: string;
  readonly requestBody?: unknown;
  /** `2xx` for success (the client does not expose the exact code), the HTTP status, or the kind. */
  readonly status: string;
  readonly contentType?: string;
  readonly body?: unknown;
  readonly error?: string;
}

/** A request's outcome for the probe's own logic (unscrubbed). */
export interface HttpResult {
  readonly ok: boolean;
  /** HTTP status of a failure; `undefined` on success. */
  readonly status: number | undefined;
  readonly kind?: SevdeskErrorKind;
  readonly contentType?: string;
  /** Raw body text (download) or the JSON of the unwrapped objects (writes). */
  readonly text?: string;
  /**
   * The raw body bytes of a GET (JSON or not), e.g. to tell a CSV's encoding: the decoded `text`
   * has lost a byte-order mark and any byte that is not UTF-8.
   */
  readonly bytes?: Uint8Array;
  /** Parsed body, when JSON. */
  readonly json?: unknown;
  /** `json.objects` for GETs, the unwrapped payload for writes. */
  readonly objects?: unknown;
  /** sevDesk's message (scrubbed), or the client's trusted message when sevDesk sent none. */
  readonly message?: string;
}

interface GetOptions {
  /**
   * Sends the GET as a side effect with this tier (`sideEffect: true`): for the export-job GETs,
   * which start a job in sevDesk. Only `write`: nothing a probe reads may finalize, enshrine or
   * e-mail. The client still refuses it in read-only mode and never retries it.
   */
  readonly tier?: "write";
  /** Largest body accepted (`SevdeskRequest.maxBytes`); the client's default otherwise. */
  readonly maxBytes?: number;
}

export interface ProbeHttp {
  /** GET through `client.download` (raw body); never throws for HTTP errors. */
  get(path: string, query?: Query, options?: GetOptions): Promise<HttpResult>;
  /** A data-changing request through `client.request` with the given tier; never retried. */
  write(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      readonly body?: unknown;
      /**
       * A multipart body instead of JSON (e.g. `Voucher/Factory/uploadTempFile`). The evidence
       * lists its parts (field, scrubbed file name, type, size), never their bytes.
       */
      readonly form?: FormData;
      readonly query?: Query;
      readonly tier: "write" | "commit" | "external";
    },
  ): Promise<HttpResult>;
}

/** A record a write probe created, for the cleanup list. */
export interface CreatedRecord {
  readonly objectName: string;
  readonly id: number;
  /** Mutable: updated when a probe finalizes, pays or cancels it. */
  state: string;
  readonly probe: string;
}

export interface ProbeContext {
  readonly probeId: string;
  readonly http: ProbeHttp;
  readonly read: ReadHelpers;
  /** Set only in write mode. */
  readonly data: TestData | undefined;
  readonly systemVersion: "1.0" | "2.0";
  /** Berlin date, YYYY-MM-DD. */
  readonly today: string;
  /** Unix seconds at the start of the run. */
  readonly nowSeconds: number;
  readonly scrubber: Scrubber;
  /** The operator's own address for e-mail probes (`--probe-email`); unset otherwise. */
  readonly probeEmail?: string;
  /** A separate client with its own pacing and diagnostics hook (for the opt-in burst probe). */
  readonly makeClient?: (
    requestsPerSecond: number,
    onEvent: (event: SevdeskClientEvent) => void,
  ) => SevdeskClient;
}

// ---------------------------------------------------------------------------------------------
// HTTP with evidence
// ---------------------------------------------------------------------------------------------

const MAX_TEXT = 20_000;

export function requestLine(method: string, path: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    params.append(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const search = params.toString().replace(/%5B/g, "[").replace(/%5D/g, "]");
  return `${method} ${path}${search === "" ? "" : `?${search}`}`;
}

/**
 * Query parameters that only steer a request (paging, embedding, the model a reference names):
 * the probe's own constants, never account data, so the evidence shows them as sent.
 */
const STRUCTURAL_QUERY_KEY =
  /^(?:limit|offset|countAll|emptyState|embed|.+\[(?:objectName|modelName|limit)\])$/;
/** Switch values a probe writes out as text. */
const SWITCH_VALUE = /^(?:true|false|all)$/;

/**
 * The query as the evidence shows it. Filter values can be account data (a probe reads an invoice
 * number and filters by it), and the report is meant to be shared, so each value goes through the
 * scrubber under its own key, like a field of a response body: document and customer numbers,
 * names and free text become fakes; ids, amounts, dates and upper-case codes stay. The request
 * itself is sent with the real values (review 2026-11, round 3: the request line of a "scrubbed"
 * report still held the invoice numbers).
 */
export function evidenceQuery(query: Query | undefined, scrubber: Scrubber): Query | undefined {
  if (query === undefined) return undefined;
  const shown: Record<string, Exclude<QueryValue, undefined>> = {};
  for (const [key, value] of Object.entries(query)) {
    if (
      typeof value === "boolean" ||
      STRUCTURAL_QUERY_KEY.test(key) ||
      (typeof value === "string" && SWITCH_VALUE.test(value))
    ) {
      shown[key] = value;
      continue;
    }
    const scrubbed = (scrubber.scrub({ [key]: value }) as Record<string, unknown>)[key];
    shown[key] =
      typeof scrubbed === "string" || typeof scrubbed === "number" || typeof scrubbed === "boolean"
        ? scrubbed
        : "<redacted>";
  }
  return shown;
}

/** An HTTP wrapper that appends a scrubbed {@link Exchange} to `evidence` for every request. */
export function createProbeHttp(
  client: SevdeskClient,
  scrubber: Scrubber,
  evidence: { push(exchange: Exchange): unknown },
): ProbeHttp {
  /** `scrubbedRequestBody` is evidence already: scrubbed exactly once by the caller. */
  function failure(error: unknown, request: string, scrubbedRequestBody?: unknown): HttpResult {
    const scrubbedBody =
      scrubbedRequestBody === undefined ? {} : { requestBody: scrubbedRequestBody };
    if (error instanceof SevdeskError) {
      const message =
        error.upstreamMessage === undefined ? undefined : scrubber.scrubText(error.upstreamMessage);
      evidence.push({
        request,
        ...scrubbedBody,
        status: error.status === undefined ? error.kind : String(error.status),
        error: `${error.kind}${message === undefined ? `: ${error.message}` : `: ${message}`}`,
      });
      return {
        ok: false,
        status: error.status,
        kind: error.kind,
        // sevDesk's own words when it sent some, else the client's trusted message.
        message: message ?? error.message,
      };
    }
    const message = scrubber.scrubText(error instanceof Error ? error.message : String(error));
    evidence.push({ request, ...scrubbedBody, status: "error", error: message });
    return { ok: false, status: undefined, message };
  }

  return {
    async get(path, query, options = {}) {
      const request = requestLine("GET", path, evidenceQuery(query, scrubber));
      try {
        const response = await client.download({
          method: "GET",
          path,
          ...(query === undefined ? {} : { query }),
          ...(options.tier === undefined ? {} : { sideEffect: true, tier: options.tier }),
          ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        });
        const text = new TextDecoder().decode(response.body);
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          json = undefined;
        }
        const objects = (json as { objects?: unknown } | undefined)?.objects;
        evidence.push({
          request,
          status: "2xx",
          ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
          body:
            // Only the first line (a CSV's header row, an XML declaration, `%PDF-1.x`), never
            // the data rows after it.
            json === undefined
              ? `${scrubber.scrubText((text.split(/\r?\n/, 1)[0] ?? "").slice(0, 120))}… (${response.body.length} bytes, not JSON)`
              : scrubber.scrub(json),
        });
        return {
          ok: true,
          status: undefined,
          ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
          text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
          bytes: response.body,
          json,
          objects,
        };
      } catch (error) {
        return failure(error, request);
      }
    },

    async write(method, path, options) {
      const request = requestLine(method, path, evidenceQuery(options.query, scrubber));
      const requestBody =
        options.form !== undefined
          ? describeForm(options.form, scrubber)
          : options.body === undefined
            ? undefined
            : scrubber.scrub(options.body);
      try {
        const objects = await client.request({
          method,
          path,
          tier: options.tier,
          ...(options.body === undefined ? {} : { body: options.body }),
          ...(options.form === undefined ? {} : { form: options.form }),
          ...(options.query === undefined ? {} : { query: options.query }),
        });
        evidence.push({
          request,
          ...(requestBody === undefined ? {} : { requestBody }),
          status: "2xx",
          body: scrubber.scrub({ objects }),
        });
        return { ok: true, status: undefined, json: { objects }, objects };
      } catch (error) {
        return failure(error, request, requestBody);
      }
    },
  };
}

/**
 * Evidence of a multipart body: per part its field name (ours), and for files the scrubbed file
 * name, media type and size. File contents never reach the report.
 */
function describeForm(form: FormData, scrubber: Scrubber): { readonly form: unknown[] } {
  const parts: unknown[] = [];
  form.forEach((value, field) => {
    if (typeof value === "string") {
      parts.push({ field, value: scrubber.scrubText(value) });
      return;
    }
    const scrubbed = scrubber.scrub({ filename: value.name }) as { filename?: unknown };
    parts.push({ field, filename: scrubbed.filename, type: value.type, size: value.size });
  });
  return { form: parts };
}

// ---------------------------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------------------------

export interface ReadHelpers {
  /** Rows of one page (`limit` default 100, `countAll`), plus sevDesk's total. */
  page(
    path: string,
    query?: Query,
    limit?: number,
  ): Promise<{ rows: Row[]; total: number | undefined; result: HttpResult }>;
  /** `countAll` total of a filtered collection (one row requested). */
  total(path: string, query?: Query): Promise<number | undefined>;
  /** The first row matching `predicate` among the first `limit` rows. */
  first(
    path: string,
    query: Query | undefined,
    predicate?: (row: Row) => boolean,
    limit?: number,
  ): Promise<Row | undefined>;
  /** GET `/<objectName>/<id>` → the single row, or `undefined`. */
  byId(objectName: string, id: number, query?: Query): Promise<Row | undefined>;
}

export function createReadHelpers(http: ProbeHttp): ReadHelpers {
  async function page(path: string, query: Query = {}, limit = 100) {
    const result = await http.get(path, { ...query, limit, offset: 0, countAll: true });
    if (!result.ok) return { rows: [], total: undefined, result };
    const rows =
      result.objects === undefined || result.objects === null ? [] : rowsOf(result.objects);
    const rawTotal = (result.json as { total?: unknown } | undefined)?.total;
    const total = rawTotal === undefined || rawTotal === null ? undefined : Number(rawTotal);
    return { rows, total: Number.isFinite(total) ? total : undefined, result };
  }
  return {
    page,
    async total(path, query) {
      return (await page(path, query, 1)).total;
    },
    async first(path, query, predicate = () => true, limit = 100) {
      return (await page(path, query, limit)).rows.find(predicate);
    },
    async byId(objectName, id, query) {
      const result = await http.get(`/${objectName}/${id}`, query);
      if (!result.ok || result.objects === undefined || result.objects === null) return undefined;
      return rowsOf(result.objects)[0];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------------------------

/** A scalar field as a string (`""` for null/missing). */
export function str(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The id of a `{id, objectName}` reference field, or `undefined`. */
export function refId(row: Row | undefined, key: string): number | undefined {
  const value = row?.[key];
  if (typeof value !== "object" || value === null) return undefined;
  const id = Number((value as Row)["id"]);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** The id of the created record in a write response: `objects.<key>.id`, `objects.id` or the first row. */
export function createdId(objects: unknown, key?: string): number | undefined {
  if (objects === null || objects === undefined) return undefined;
  if (key !== undefined && typeof objects === "object" && !Array.isArray(objects)) {
    const nested = (objects as Row)[key];
    if (nested !== undefined) return createdId(nested);
  }
  const first = rowsOf(objects)[0];
  const id = Number(first?.["id"]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The fields that show whether a document was sent or changed. */
export function sendState(row: Row | undefined): Record<string, string> {
  return {
    status: str(row, "status"),
    sendDate: str(row, "sendDate"),
    sendType: str(row, "sendType"),
    update: str(row, "update"),
  };
}

/** `a → b` for every key whose value differs; `""` when nothing changed. */
export function diffState(before: Record<string, string>, after: Record<string, string>): string {
  return Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${before[key] || "(empty)"} → ${after[key] || "(empty)"}`)
    .join("; ");
}

/** Unix seconds of 00:00 Europe/Berlin on `date` (YYYY-MM-DD). */
export function berlinMidnight(date: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(utcMidnight))
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart ?? "");
  const offsetMinutes =
    match === null ? 0 : (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  return Math.floor(utcMidnight / 1000) - offsetMinutes * 60;
}

/** `YYYY-MM-DD` → `dd.mm.yyyy`. */
export function germanDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day ?? ""}.${month ?? ""}.${year ?? ""}`;
}

/** `date` (YYYY-MM-DD) shifted by `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Tagged test data (write mode)
// ---------------------------------------------------------------------------------------------

interface DocumentOptions {
  readonly date?: string;
  readonly currency?: string;
  readonly showNet?: boolean;
  readonly timeToPay?: number;
  /** Positions as sevDesk fields; defaults to one position of 100.00 net at 19 %. */
  readonly positions?: readonly Readonly<Record<string, unknown>>[];
  /** Extra header fields (e.g. structured address fields), merged last. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Header fields to leave out (e.g. `deliveryDate`, to see whether sevDesk requires it). */
  readonly omit?: readonly string[];
}

export type DocumentKind = "Invoice" | "CreditNote" | "Order";

export interface TestData {
  readonly tag: string;
  readonly created: CreatedRecord[];
  /** The tagged customer contact of this run (created once). */
  contact(): Promise<number>;
  /** A SevUser id for `contactPerson`. */
  contactPerson(): Promise<number>;
  /** The first check account, if any. */
  checkAccount(): Promise<number | undefined>;
  /** Creates a draft without a document number; `undefined` with the failure when refused. */
  draft(
    kind: DocumentKind,
    options?: DocumentOptions & { readonly orderType?: "AN" | "AB" | "LI" },
  ): Promise<{ readonly id: number | undefined; readonly result: HttpResult }>;
  /** `PUT /<kind>/<id>/sendBy` (sendType VPR, sendDraft false): marks it as sent by post. */
  finalize(kind: DocumentKind, id: number): Promise<HttpResult>;
  /** Registers a record created by a probe directly. */
  register(objectName: string, id: number, state: string): void;
  /** Updates the state shown in the cleanup list. */
  mark(objectName: string, id: number, state: string): void;
}

const POSITION_KEY: Readonly<Record<DocumentKind, string>> = {
  Invoice: "invoicePosSave",
  CreditNote: "creditNotePosSave",
  Order: "orderPosSave",
};

const SAVE_PATH: Readonly<Record<DocumentKind, string>> = {
  Invoice: "/Invoice/Factory/saveInvoice",
  CreditNote: "/CreditNote/Factory/saveCreditNote",
  Order: "/Order/Factory/saveOrder",
};

const RESPONSE_KEY: Readonly<Record<DocumentKind, string>> = {
  Invoice: "invoice",
  CreditNote: "creditNote",
  Order: "order",
};

export function createTestData(options: {
  readonly http: ProbeHttp;
  readonly read: ReadHelpers;
  readonly tag: string;
  readonly today: string;
  readonly systemVersion: "1.0" | "2.0";
  readonly created: CreatedRecord[];
  readonly probeId: () => string;
}): TestData {
  const { http, read, tag, today, systemVersion, created } = options;
  let contactId: Promise<number> | undefined;
  let userId: Promise<number> | undefined;

  function register(objectName: string, id: number, state: string): void {
    created.push({ objectName, id, state, probe: options.probeId() });
  }

  async function createContact(): Promise<number> {
    const result = await http.write("POST", "/Contact", {
      tier: "write",
      body: { name: tag, category: { id: 3, objectName: "Category" }, status: 1000 },
    });
    const id = createdId(result.objects);
    if (id === undefined) {
      throw new Error(
        `Could not create the tagged test contact: ${result.message ?? result.kind ?? "no id"}.`,
      );
    }
    register("Contact", id, "active (can be deleted in the web app)");
    return id;
  }

  async function firstUser(): Promise<number> {
    const user = await read.first("/SevUser", undefined);
    const id = Number(user?.["id"]);
    if (!Number.isSafeInteger(id)) throw new Error("No SevUser found for contactPerson.");
    return id;
  }

  function taxFields(): Record<string, unknown> {
    return systemVersion === "2.0"
      ? { taxRule: { id: "1", objectName: "TaxRule" }, taxRate: 0, taxText: "Umsatzsteuer 19%" }
      : { taxType: "default", taxRate: 0, taxText: "Umsatzsteuer 19%" };
  }

  return {
    tag,
    created,
    register,
    mark(objectName, id, state) {
      const record = created.find((item) => item.objectName === objectName && item.id === id);
      if (record !== undefined) record.state = state;
    },
    contact() {
      contactId ??= createContact();
      return contactId;
    },
    contactPerson() {
      userId ??= firstUser();
      return userId;
    },
    async checkAccount() {
      const account = await read.first(
        "/CheckAccount",
        undefined,
        (row) => str(row, "status") !== "0",
      );
      const id = Number(account?.["id"]);
      return Number.isSafeInteger(id) ? id : undefined;
    },
    async draft(kind, documentOptions = {}) {
      const isoDate = documentOptions.date ?? today;
      const date = germanDate(isoDate);
      // Delivery dates as Unix seconds of Berlin midnight, document dates as dd.mm.yyyy: the
      // forms the draft tools send (recorded by jernoxit/sevdesk-rs).
      const deliveryDate = berlinMidnight(isoDate);
      const contact = { id: await this.contact(), objectName: "Contact" };
      const contactPerson = { id: await this.contactPerson(), objectName: "SevUser" };
      const common = {
        objectName: kind,
        mapAll: true,
        contact,
        contactPerson,
        addressCountry: { id: 1, objectName: "StaticCountry" },
        currency: documentOptions.currency ?? "EUR",
        header: `${tag} ${kind}`,
        customerInternalNote: tag,
        showNet: documentOptions.showNet ?? true,
        ...taxFields(),
      };
      const base: Record<string, unknown> =
        kind === "Invoice"
          ? {
              ...common,
              invoiceDate: date,
              deliveryDate,
              status: "100",
              invoiceType: "RE",
              discount: 0,
              timeToPay: documentOptions.timeToPay ?? 14,
            }
          : kind === "CreditNote"
            ? {
                ...common,
                // PROVISION takes tax rule 9 (rule 1 is refused); UNDERACHIEVEMENT would need a
                // finalized source invoice (refSrcInvoice).
                ...(systemVersion === "2.0" ? { taxRule: { id: "9", objectName: "TaxRule" } } : {}),
                creditNoteType: "CN",
                creditNoteDate: date,
                deliveryDate,
                status: "100",
                discount: 0,
                bookingCategory: "PROVISION",
              }
            : {
                ...common,
                orderDate: date,
                status: 100,
                version: 0,
                orderType: documentOptions.orderType ?? "AN",
              };
      const omitted = new Set(documentOptions.omit ?? []);
      const header = Object.fromEntries(
        Object.entries({ ...base, ...documentOptions.fields }).filter(([key]) => !omitted.has(key)),
      );
      const positions = (documentOptions.positions ?? [{ price: 100 }]).map((position, index) => ({
        objectName: `${kind}Pos`,
        mapAll: true,
        quantity: 1,
        name: `${tag} position ${index + 1}`,
        unity: { id: 1, objectName: "Unity" },
        taxRate: 19,
        ...position,
      }));
      const result = await http.write("POST", SAVE_PATH[kind], {
        tier: "write",
        body: {
          [RESPONSE_KEY[kind]]: header,
          [POSITION_KEY[kind]]: positions,
          [POSITION_KEY[kind].replace("Save", "Delete")]: null,
        },
      });
      const id = createdId(result.objects, RESPONSE_KEY[kind]);
      if (id !== undefined) register(kind, id, "draft (deletable in the web app)");
      return { id, result };
    },
    async finalize(kind, id) {
      const result = await http.write("PUT", `/${kind}/${id}/sendBy`, {
        tier: "commit",
        body: { sendType: "VPR", sendDraft: false },
      });
      if (result.ok) this.mark(kind, id, "finalized (cannot be deleted; cancel or leave)");
      return result;
    },
  };
}
