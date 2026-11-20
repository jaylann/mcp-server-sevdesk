import type { FakeRoute } from "./fake-client.js";

/**
 * Country enrichment uses the same fixture as input resolution; explicit routes win. Also an empty
 * credit note list: finalizing or sending a credit note draft first checks that no other credit
 * note has its number (`checkCreditNoteNumberFree`), and a test that cares routes `/CreditNote`
 * itself.
 */
export function withCountryRoute(routes: readonly FakeRoute[]): FakeRoute[] {
  return [
    ...routes,
    { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } },
    { path: "/CreditNote", response: { body: { objects: [] } } },
  ];
}
