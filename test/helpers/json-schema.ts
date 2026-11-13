/** Inline local references for structural assertions, retaining siblings and stopping at cycles. */
export function inlineLocalRefs(
  value: unknown,
  root: unknown = value,
  ancestors: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) return value.map((child) => inlineLocalRefs(child, root, ancestors));
  if (value === null || typeof value !== "object") return value;
  const { $ref, $defs: _defs, ...siblings } = value as Record<string, unknown>;
  if (typeof $ref === "string") {
    if (!$ref.startsWith("#/")) throw new Error(`Non-local schema reference: ${$ref}`);
    if (ancestors.has($ref)) return { $ref, ...siblings };
    let target = root;
    for (const segment of $ref.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (target === null || typeof target !== "object" || !Object.hasOwn(target, key)) {
        throw new Error(`Unresolved schema reference: ${$ref}`);
      }
      target = (target as Record<string, unknown>)[key];
    }
    return {
      ...(inlineLocalRefs(target, root, new Set([...ancestors, $ref])) as object),
      ...(inlineLocalRefs(siblings, root, ancestors) as object),
    };
  }
  return Object.fromEntries(
    Object.entries(siblings).map(([key, child]) => [key, inlineLocalRefs(child, root, ancestors)]),
  );
}
