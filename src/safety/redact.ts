/**
 * Secret redaction for anything that may leave the process: error messages, diagnostics, audit
 * log lines. The sevDesk token grants full account access (no scopes, never expires), so every
 * string that could contain it goes through here first.
 */

/** Replacement text for a redacted value. */
export const REDACTED = "[REDACTED]";

/** Header names whose values are credentials (compared case-insensitively). */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Replaces every occurrence of each secret in `text` with {@link REDACTED}, including its
 * URL-encoded forms (percent-encoding in either hex case, `+` for spaces). Matching is
 * case-insensitive, so an upper-cased echo of a hex token is caught too; over-redaction is the
 * safe failure mode. Empty secrets are ignored.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret === undefined || secret.length === 0) continue;
    variants.add(secret);
    const component = encodeURIComponent(secret);
    variants.add(component);
    variants.add(component.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()));
    variants.add(component.replace(/%20/g, "+"));
    variants.add(encodeURI(secret));
  }
  if (variants.size === 0) return text;

  // Longest first, so a secret that contains another is replaced as a whole.
  const pattern = [...variants]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return text.replace(new RegExp(pattern, "gi"), REDACTED);
}

/**
 * Returns a plain, lower-cased copy of `headers` that is safe to log: credential headers are
 * replaced by {@link REDACTED}.
 */
export function redactHeaders(
  headers: Headers | Readonly<Record<string, string>>,
): Record<string, string> {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    result[key] = SENSITIVE_HEADERS.has(key) ? REDACTED : value;
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
