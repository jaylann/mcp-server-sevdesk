/** Shared route builders for the master-data write tool tests. */
import type { SevdeskClient } from "../../../../src/sevdesk/types.js";
import {
  type FakeRoute,
  type FakeSevdeskClient,
  loadFixture,
} from "../../../helpers/fake-client.js";

export const EMPTY: FakeRoute["response"] = { body: { objects: [] } };

/** A GET-by-id response from `fixture` (array of one) with fields of its record replaced. */
export function patched(fixture: string, patch: Record<string, unknown>): FakeRoute["response"] {
  const body = loadFixture(fixture).body as { objects: Record<string, unknown>[] };
  const record = body.objects[0] ?? {};
  return { body: { objects: [{ ...record, ...patch }] } };
}

/** Replaces the responses of routes by key; `extra` routes go first (first match wins). */
export function routeTable(
  table: readonly (readonly [string, FakeRoute])[],
  overrides: Partial<Record<string, FakeRoute["response"]>> = {},
  extra: readonly FakeRoute[] = [],
): FakeRoute[] {
  return [
    ...extra,
    ...table.map(([key, route]) => {
      const response = overrides[key];
      return response === undefined ? route : { ...route, response };
    }),
  ];
}

/** Routes `getInvoice` / `getCreditNote` / `getOrder` read for one document. */
export function invoiceReadRoutes(
  id: number,
  invoice: FakeRoute["response"],
  positions: FakeRoute["response"] = EMPTY,
): FakeRoute[] {
  return [
    { path: `/Invoice/${id}`, query: { embed: "contact" }, response: invoice },
    {
      path: "/InvoicePos",
      query: { "invoice[id]": id, "invoice[objectName]": "Invoice" },
      response: positions,
    },
  ];
}

export function creditNoteReadRoutes(
  id: number,
  creditNote: FakeRoute["response"],
  positions: FakeRoute["response"] = EMPTY,
): FakeRoute[] {
  return [
    { path: `/CreditNote/${id}`, query: { embed: "contact" }, response: creditNote },
    {
      path: "/CreditNotePos",
      query: { "creditNote[id]": id, "creditNote[objectName]": "CreditNote" },
      response: positions,
    },
  ];
}

export const UNITS_ROUTE: FakeRoute = { path: "/Unity", response: { fixture: "meta/units.json" } };

/** A minimal tool context for calling `execute` directly with a hand-made client. */
export function directContext<C>(client: C) {
  return {
    client,
    config: {} as never,
    signal: new AbortController().signal,
    progress: () => Promise.resolve(),
    files: {} as never,
  };
}

/**
 * A client that answers `GET path` from `base` for the first `reads` calls and with the
 * unwrapped payload `later` afterwards, e.g. a source document sevDesk changed during the write.
 */
export function changingAfter(
  base: FakeSevdeskClient,
  path: string,
  reads: number,
  later: unknown,
): SevdeskClient {
  let seen = 0;
  return {
    request: (request) => {
      if (request.method === "GET" && request.path === path) {
        seen += 1;
        if (seen > reads) return Promise.resolve(later);
      }
      return base.request(request);
    },
    list: base.list.bind(base),
    listAll: base.listAll.bind(base),
    download: base.download.bind(base),
  };
}

/** The record of a GET-by-id fixture with fields replaced, as the client returns it (unwrapped). */
export function patchedRecord(fixture: string, patch: Record<string, unknown>): unknown[] {
  const body = loadFixture(fixture).body as { objects: Record<string, unknown>[] };
  return [{ ...(body.objects[0] ?? {}), ...patch }];
}
