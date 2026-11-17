/**
 * Test helpers for the lifecycle tools: records built from the M2 fixtures with overrides (same
 * keys and scalar types as the recordings, see the fixtures' provenance), routes for them, and a
 * client whose answers change after the first write, so tests can tell a read-back from the
 * snapshot `prepare` took.
 */
import { changesData } from "../../../../src/sevdesk/scoped-client.js";
import type {
  CollectedList,
  HttpMethod,
  ListAllOptions,
  ListOptions,
  Page,
  QueryValue,
  SevdeskClient,
  SevdeskRequest,
} from "../../../../src/sevdesk/types.js";
import { withCountryRoute } from "../../../helpers/country-route.js";
import {
  changedData,
  type FakeRoute,
  FakeSevdeskClient,
  loadFixture,
  type RecordedCall,
} from "../../../helpers/fake-client.js";

export type Row = Record<string, unknown>;

function rowsOf(path: string): Row[] {
  const objects = (loadFixture(path).body as { objects: unknown }).objects;
  return structuredClone(Array.isArray(objects) ? objects : [objects]) as Row[];
}

function rowWithId(path: string, id: string): Row {
  const row = rowsOf(path).find((candidate) => candidate["id"] === id);
  if (row === undefined) throw new Error(`no row ${id} in ${path}`);
  return row;
}

/**
 * Invoice 1001 (community: sevDesk.NET recording, fake values): RE-1001, open (200), EUR,
 * net 149.02 / tax 28.31 / gross 177.33, paidAmount 0, contact Musterfirma GmbH embedded.
 */
export function invoiceRow(overrides: Row = {}): Row {
  return { ...rowsOf("invoices/invoice-1001.json")[0], ...overrides };
}

/** Credit note 2001 (community: sevdesk-rs recording): GU-1001, open (200), gross 23.80 EUR. */
export function creditNoteRow(overrides: Row = {}): Row {
  return { ...rowsOf("credit-notes/credit-note-2001.json")[0], ...overrides };
}

/** Order 3002 (community: OrderManager2 recording): AB-1002, accepted (500), gross 171.38 EUR. */
export function orderRow(overrides: Row = {}): Row {
  return { ...rowsOf("orders/order-3002.json")[0], ...overrides };
}

/**
 * Check accounts of `banking/check-accounts.json`: 4001 offline EUR (Basiskonto), 4002 online EUR,
 * 4003 register EUR (Kasse), 4004 online archived, 4005 online USD.
 */
export function accountRow(id: number, overrides: Row = {}): Row {
  return { ...rowWithId("banking/check-accounts.json", String(id)), ...overrides };
}

/**
 * A free incoming bank transaction on account 4002 (keys of the recorded transaction 5001):
 * id 5101, 177.33, status 100, not enshrined.
 */
export function transactionRow(overrides: Row = {}): Row {
  return {
    ...rowWithId("banking/transactions-list.json", "5001"),
    id: "5101",
    amount: "177.33",
    status: "100",
    payeePayerName: "Musterfirma GmbH",
    paymtPurpose: "RE-1001",
    checkAccount: { id: "4002", objectName: "CheckAccount" },
    enshrined: null,
    ...overrides,
  };
}

/** The first row of a write-response fixture in `test/fixtures/lifecycle/`. */
export function fixtureRow(name: string): Row {
  const [row] = rowsOf(`lifecycle/${name}`);
  if (row === undefined) throw new Error(`fixture ${name} has no row`);
  return row;
}

const OBJECT_PATHS = {
  invoice: "Invoice",
  creditNote: "CreditNote",
  order: "Order",
} as const;

/** `GET /{Invoice|CreditNote|Order}/{id}?embed=contact` answering with `row`. */
export function documentRoute(kind: keyof typeof OBJECT_PATHS, row: Row): FakeRoute {
  return {
    path: `/${OBJECT_PATHS[kind]}/${String(row["id"])}`,
    query: { embed: "contact" },
    response: { body: { objects: [row] } },
  };
}

/**
 * Empty position lists of every kind, no document discounts on any invoice, credit note or order
 * (the recorded empty answer of `getDiscounts`), and the default layout of any invoice, order and
 * credit note ({@link renderRoute}): what finalize, send and enshrine read for their preview
 * facts and approval binding (`readDocumentContent`). `rows` for one path replace its empty list.
 */
export function positionRoutes(rows: Readonly<Record<string, readonly Row[]>> = {}): FakeRoute[] {
  return [
    ...["/InvoicePos", "/CreditNotePos", "/OrderPos", "/VoucherPos"].map((path) => ({
      path,
      response: { body: { objects: rows[path] ?? [] } },
    })),
    noDiscountsRoute,
    renderRoute("invoice"),
    renderRoute("order"),
  ];
}

/** The current language, template and letterhead of a layout answer (see {@link layoutObjects}). */
export interface LayoutValues {
  readonly language?: string | null;
  readonly template?: string | null;
  readonly letterpaper?: string | null;
}

/** Which language values a layout answer lists: an invoice's or an order's (and credit note's). */
export type LayoutStyle = "invoice" | "order";

/**
 * The language choices sevDesk lists (recorded 2026-11-17, D-140): the same eight translation
 * codes on every kind, but invoices store `en` and `de` where orders and credit notes store the
 * locale form.
 */
const LANGUAGE_CHOICES: readonly (readonly [string, string, string])[] = [
  ["de_DE", "de", "deutsch"],
  ["de_AT", "de_AT", "deutsch (Österreich)"],
  ["de_CH", "de_CH", "deutsch (Schweiz)"],
  ["en_US", "en", "englisch"],
  ["es_ES", "es_ES", "spanisch"],
  ["fr_FR", "fr_FR", "französisch"],
  ["it_IT", "it_IT", "italienisch"],
  ["el_GR", "el_GR", "griechisch"],
];

/**
 * The `objects` of a layout answer in the recorded shape (D-113: `render` answers `{docId, pdf,
 * parameters}`, `changeParameter` the same under `metaData`): language, template and letterhead
 * with their choices, and one more print option with a boolean value. Templates `tpl-standard`
 * (Standard) and `tpl-modern` (Modern), letterheads `lp-1` (Briefpapier 1) and `lp-2` (Zweites
 * Briefpapier): ids and names are made up (the recording is scrubbed). Defaults as recorded: an
 * invoice in German (`de`) on Standard and Briefpapier 1; an order or credit note in German
 * (`de_DE`) on Standard with the letterhead value `""` (none chosen).
 */
export function layoutObjects(values: LayoutValues = {}, style: LayoutStyle = "invoice"): Row {
  const parameter = (key: string, value: string | null, choices: Row[]): Row => ({
    key,
    name: key,
    values: choices,
    visible: true,
    value,
  });
  const invoice = style === "invoice";
  const pick = (value: string | null | undefined, fallback: string) =>
    value === undefined ? fallback : value;
  return {
    docId: "00000000000000000000000000000001",
    pdf: "JVBERi0xLjQKJSVFT0YK",
    parameters: [
      parameter(
        "language",
        pick(values.language, invoice ? "de" : "de_DE"),
        LANGUAGE_CHOICES.map(([locale, invoiceValue, name]) => ({
          name: invoice ? invoiceValue : name,
          value: invoice ? invoiceValue : locale,
          translationCode: `SEVDOC_LANG_${locale.toUpperCase()}`,
          isCustom: null,
        })),
      ),
      parameter("template", pick(values.template, "tpl-standard"), [
        { name: "Standard", value: "tpl-standard" },
        { name: "Modern", value: "tpl-modern" },
      ]),
      parameter("letterpaper", pick(values.letterpaper, invoice ? "lp-1" : ""), [
        { name: "Briefpapier 1", value: "lp-1" },
        { name: "Zweites Briefpapier", value: "lp-2" },
      ]),
      parameter("printFooter", null, [{ name: "ja", value: true }]),
    ],
  };
}

/**
 * `POST /{Invoice|Order|CreditNote}/{id}/render` (`{forceReload: false}`): style `invoice` serves
 * every invoice, style `order` every order and credit note, answering the layout `values`
 * ({@link layoutObjects}, parameters at the top level as recorded); `objects` replaces the whole
 * answer.
 */
export function renderRoute(
  style: LayoutStyle = "invoice",
  values: LayoutValues = {},
  objects?: unknown,
): FakeRoute {
  return {
    method: "POST",
    path: style === "invoice" ? "/Invoice/{id}/render" : "/{Order|CreditNote}/{id}/render",
    pathPattern:
      style === "invoice" ? /^\/Invoice\/\d+\/render$/ : /^\/(?:Order|CreditNote)\/\d+\/render$/,
    response: { body: { objects: objects ?? layoutObjects(values, style) } },
  };
}

/**
 * `PUT /{kind}/{id}/changeParameter` answering the layout `values` in the recorded shape: under
 * `metaData` (invoices), with `result` beside it (orders, credit notes).
 */
export function changeParameterRoute(
  path: string,
  style: LayoutStyle,
  values: LayoutValues,
): FakeRoute {
  const metaData = layoutObjects(values, style);
  return {
    method: "PUT",
    path,
    response: {
      body: { objects: style === "invoice" ? { metaData } : { result: 1, metaData } },
    },
  };
}

/** `GET /{Invoice|CreditNote|Order}/{id}/getDiscounts` for any document: none (recorded shape). */
export const noDiscountsRoute: FakeRoute = {
  path: "/{kind}/{id}/getDiscounts",
  pathPattern: /^\/(Invoice|CreditNote|Order)\/\d+\/getDiscounts$/,
  response: { fixture: "recorded/2026-11-16/orders/order-discounts.json" },
};

/** `GET /CheckAccount/{id}`. */
export function accountRoute(row: Row): FakeRoute {
  return { path: `/CheckAccount/${String(row["id"])}`, response: { body: { objects: [row] } } };
}

/** `GET /CheckAccountTransaction/{id}`. */
export function transactionRoute(row: Row): FakeRoute {
  return {
    path: `/CheckAccountTransaction/${String(row["id"])}`,
    response: { body: { objects: [row] } },
  };
}

/**
 * `GET /CheckAccountTransactionLog` (filtered by the transaction) answering `entries`: what the
 * book-payment tools read for a free transaction. Default: no entries.
 */
export function transactionLogRoute(entries: readonly Row[] = []): FakeRoute {
  return {
    path: "/CheckAccountTransactionLog",
    response: { body: { objects: entries, total: entries.length } },
  };
}

/** A data-changing route answering with a fixture of `test/fixtures/lifecycle/`. */
export function writeRoute(method: HttpMethod, path: string, fixture: string): FakeRoute {
  return { method, path, response: { fixture: `lifecycle/${fixture}` } };
}

/**
 * A client that answers from `before` until the first data-changing request and from `after`
 * from then on (the write itself included), recording every call in order.
 */
export class StagedClient implements SevdeskClient {
  readonly before: FakeSevdeskClient;
  readonly after: FakeSevdeskClient;
  private written = false;

  constructor(before: readonly FakeRoute[], after: readonly FakeRoute[]) {
    // Empty position lists after the given routes: the approval binding reads them.
    this.before = new FakeSevdeskClient(withCountryRoute([...before, ...positionRoutes()]));
    this.after = new FakeSevdeskClient(withCountryRoute(after));
  }

  /** Every call, in order. */
  get calls(): RecordedCall[] {
    return [...this.before.calls, ...this.after.calls];
  }

  /** Calls that changed data. */
  writes(): RecordedCall[] {
    return this.calls.filter(changedData);
  }

  private current(): FakeSevdeskClient {
    return this.written ? this.after : this.before;
  }

  request(request: SevdeskRequest): Promise<unknown> {
    if (changesData(request)) this.written = true;
    return this.current().request(request);
  }

  list(
    path: string,
    query?: Readonly<Record<string, QueryValue>>,
    options?: ListOptions,
  ): Promise<Page> {
    return this.current().list(path, query, options);
  }

  listAll(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: ListAllOptions,
  ): Promise<CollectedList> {
    return this.current().listAll(path, query, options);
  }

  download(
    request: SevdeskRequest,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    if (changesData(request)) this.written = true;
    return this.current().download(request);
  }
}
