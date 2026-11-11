/**
 * Stable hashes that bind a human confirmation to exactly one action: the tool, its arguments and
 * the preview the human saw. Both sides of a confirmation (asking and executing) compute them the
 * same way, so a changed argument or a changed sevDesk record is detected.
 */
import { createHash } from "node:crypto";

import type { ConfirmationPreview } from "./write-types.js";

/**
 * JSON with object keys sorted (code-unit order, recursively) and no whitespace, so equal values
 * always produce equal text. Object members whose value is `undefined` are left out, like
 * `JSON.stringify` does. Accepts JSON-compatible values only (null, booleans, finite numbers,
 * strings, arrays, plain objects) and throws a `TypeError` for anything else (functions,
 * `undefined` at the top level or in arrays, bigint, non-finite numbers, class instances such as
 * `Date`), so a value that cannot be compared reliably is never hashed silently.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson: numbers must be finite.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}.`);
}

/** Lower-case hex SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * SHA-256 of the tool name and the canonical JSON of its parsed arguments. `dryRun` is left out:
 * a dry run and the real call of the same action hash alike, and the flag never changes what
 * the action does.
 */
export function argumentsHash(toolName: string, args: Readonly<Record<string, unknown>>): string {
  const { dryRun: _dryRun, ...rest } = args;
  return sha256Hex(canonicalJson({ tool: toolName, arguments: rest }));
}

/**
 * SHA-256 of the canonical JSON of a confirmation preview. With a German preview (`previewDe`,
 * the text a German reader approves on the approval page) the hash covers both texts, so an
 * approval is bound to everything either reader saw; without one it is the hash of `preview`
 * alone. A `binding` (a digest of content the action depends on but the preview does not show,
 * see `WritePlan.binding`) is covered too, so the approval no longer matches once that content
 * changes; without one the hash is the same as before bindings existed.
 */
export function previewHash(
  preview: ConfirmationPreview,
  previewDe?: ConfirmationPreview,
  binding?: string,
): string {
  if (binding !== undefined) {
    return sha256Hex(canonicalJson({ en: preview, de: previewDe, binding }));
  }
  return sha256Hex(
    canonicalJson(previewDe === undefined ? preview : { en: preview, de: previewDe }),
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
