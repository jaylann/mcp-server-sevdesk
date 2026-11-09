/**
 * Matching a requested `redirect_uri` against the URIs a client's metadata document registers.
 *
 * - `https` URIs match exactly, character for character.
 * - Loopback URIs (`http://localhost`, `http://127.0.0.1`, `http://[::1]`) match ignoring the
 *   port, as native clients (Claude Code) listen on a random one (RFC 8252 §7.3). Each loopback
 *   name only matches itself: `localhost` never matches `127.0.0.1`.
 * - Anything else (plain http to other hosts, custom schemes, fragments, credentials,
 *   non-canonical spellings) never matches.
 *
 * A URI is only accepted in its canonical form (`new URL(uri).href === uri`), so parser
 * differences between this server and the browser cannot redirect somewhere else.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface ParsedRedirect {
  readonly url: URL;
  readonly loopback: boolean;
}

function parseRedirect(uri: string): ParsedRedirect | undefined {
  if (uri.length > 2048 || uri.includes("#")) return undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.href !== uri || url.username !== "" || url.password !== "") return undefined;
  if (url.protocol === "https:" && url.hostname !== "") return { url, loopback: false };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { url, loopback: true };
  return undefined;
}

/**
 * The redirect URI to use when `requested` matches one of `registered` (it is then returned
 * unchanged), else `undefined`.
 */
export function matchRedirectUri(
  requested: string,
  registered: readonly string[],
): string | undefined {
  const wanted = parseRedirect(requested);
  if (wanted === undefined) return undefined;
  for (const candidate of registered) {
    const entry = parseRedirect(candidate);
    if (entry === undefined || entry.loopback !== wanted.loopback) continue;
    if (!wanted.loopback) {
      if (candidate === requested) return requested;
      continue;
    }
    if (
      entry.url.hostname === wanted.url.hostname &&
      entry.url.pathname === wanted.url.pathname &&
      entry.url.search === wanted.url.search
    ) {
      return requested;
    }
  }
  return undefined;
}

/** Whether `uri` is a loopback redirect (the client runs on the user's own machine). */
export function isLoopbackRedirect(uri: string): boolean {
  return parseRedirect(uri)?.loopback === true;
}
