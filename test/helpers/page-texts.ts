/**
 * The page texts of one language as a flat list, for the tests of the catalogs and for the
 * side-by-side list of the page preview (`scripts/preview-pages.ts`).
 */
import { Html } from "../../src/pages/html.js";

/** A marker no text contains by itself: a text function must put its argument into its result. */
export const TEXT_ARGUMENT = "⟦arg⟧";
/** What a text function gets for a parameter that is a number. */
export const NUMBER_ARGUMENT = 4711;

/** Text functions whose parameters are numbers, by path. */
const NUMERIC: ReadonlySet<string> = new Set([
  "consent.errors.tooManyConnections",
  "inboxPage.waiting",
  "signIn.fine",
]);

/**
 * Every text of `node` as `path → text`. Text functions are called with {@link TEXT_ARGUMENT}
 * (or {@link NUMBER_ARGUMENT}) for each parameter and listed as `path()`; markup is listed as
 * its source.
 */
export function flattenTexts(node: unknown, path = ""): Map<string, string> {
  const found = new Map<string, string>();
  if (typeof node === "string") {
    found.set(path, node);
  } else if (node instanceof Html) {
    found.set(path, node.toString());
  } else if (typeof node === "function") {
    const call = node as (...args: unknown[]) => unknown;
    const argument = NUMERIC.has(path) ? NUMBER_ARGUMENT : TEXT_ARGUMENT;
    const result = call(...Array.from({ length: call.length }, () => argument));
    for (const [key, text] of flattenTexts(result, `${path}()`)) found.set(key, text);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      for (const [inner, text] of flattenTexts(value, path === "" ? key : `${path}.${key}`)) {
        found.set(inner, text);
      }
    }
  }
  return found;
}

/** Whether the text function at `path` takes numbers. */
export function takesNumbers(path: string): boolean {
  return NUMERIC.has(path);
}
