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
import {
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
    this.before = new FakeSevdeskClient(before);
    this.after = new FakeSevdeskClient(after);
  }

  /** Every call, in order. */
  get calls(): RecordedCall[] {
    return [...this.before.calls, ...this.after.calls];
  }

  /** Calls that changed data. */
  writes(): RecordedCall[] {
    return this.calls.filter((call) => call.method !== "GET" || call.sideEffect);
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
