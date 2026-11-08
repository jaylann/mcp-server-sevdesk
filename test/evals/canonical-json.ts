/**
 * JSON with object keys sorted at every level, so equal values always serialize to equal text
 * (the basis of cassette keys and view caching). `undefined` members are dropped as in
 * `JSON.stringify`; arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, member]) => [name, sortKeys(member)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
