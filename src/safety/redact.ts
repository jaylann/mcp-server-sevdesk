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

/** Settings that hold a secret themselves (a rotation list holds several, comma-separated). */
const SECRET_SETTINGS = [
  "SEVDESK_API_TOKEN",
  "SEVDESK_HTTP_BEARER_TOKEN",
  "SEVDESK_HTTP_SECRET",
  "SEVDESK_HTTP_SECRET_PREVIOUS",
] as const;
/** Settings that name a file holding a secret. */
const SECRET_FILE_SETTINGS = [
  "SEVDESK_API_TOKEN_FILE",
  "SEVDESK_HTTP_BEARER_TOKEN_FILE",
  "SEVDESK_HTTP_SECRET_FILE",
] as const;
/** Shorter pieces are not redacted on their own: they would blank out ordinary words. */
const MIN_SECRET_PIECE = 8;

/**
 * Every secret the environment configures, for {@link redactSecrets} over configuration problems
 * (which quote the values they reject, so a secret pasted into the wrong setting would be
 * printed): each secret setting whole and each member of a comma- or whitespace-separated list
 * (bearer and server-secret rotation), and the contents of the `*_FILE` settings. A file that
 * cannot be read is skipped. A token kept in the OS keychain is not read here; sevDesk tokens are
 * caught by their shape instead (`redactConfigProblem`). Security review 2026-11, wave 2.
 */
export function configuredSecrets(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
): string[] {
  const values: string[] = [];
  for (const name of SECRET_SETTINGS) {
    const value = env[name];
    if (value !== undefined) values.push(value);
  }
  for (const name of SECRET_FILE_SETTINGS) {
    const path = env[name];
    if (path === undefined || path === "") continue;
    try {
      values.push(readFile(path));
    } catch {
      // Unreadable: the configuration problem says so; there is nothing to redact from it.
    }
  }
  const pieces = values.flatMap((value) => [value.trim(), ...value.split(/[\s,]+/)]);
  return [...new Set(pieces.filter((piece) => piece.length >= MIN_SECRET_PIECE))];
}
