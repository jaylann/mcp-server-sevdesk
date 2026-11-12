import type { FakeRoute } from "./fake-client.js";

/** Country enrichment uses the same fixture as input resolution; explicit routes win. */
export function withCountryRoute(routes: readonly FakeRoute[]): FakeRoute[] {
  return [
    ...routes,
    { path: "/StaticCountry", response: { fixture: "meta/static-countries.json" } },
  ];
}
