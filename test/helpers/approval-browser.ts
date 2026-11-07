/**
 * Plays the browser for the local approval page: raw `node:http` requests to 127.0.0.1, so tests
 * can also send what a browser would not (a wrong Host, a foreign Origin, no cookie).
 *
 * {@link submitDecision} sends the headers a real browser sends for the page's form POST: the
 * `Origin` follows from the page's effective referrer policy as the Fetch standard defines it
 * ("append a request Origin header": under `no-referrer` a non-CORS POST carries `Origin: null`),
 * plus the browser-set `Sec-Fetch-*` headers. It never forges the origin the server wants to see.
 */
import { request } from "node:http";

export interface PageResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface RawRequest {
  readonly method?: string;
  /** Headers to send; `undefined` leaves a header out. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

/** Sends one request to `url` (an `http://127.0.0.1:<port>/…` URL) and reads the whole answer. */
export function send(url: string, options: RawRequest = {}): Promise<PageResponse> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  const requested: Record<string, string | undefined> = { Host: target.host, ...options.headers };
  for (const [name, value] of Object.entries(requested)) {
    if (value !== undefined) headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}

export interface OpenedApproval {
  readonly page: PageResponse;
  /** The CSRF token from the form (undefined when the page has no form). */
  readonly csrf: string | undefined;
  /** `name=value` of the cookie the page set. */
  readonly cookie: string | undefined;
  /** The referrer policy a browser applies to the page (see {@link effectiveReferrerPolicy}). */
  readonly referrerPolicy: string;
}

/**
 * The page's referrer policy as a browser applies it: a `<meta name="referrer">` overrides the
 * `Referrer-Policy` header; without either, browsers default to `strict-origin-when-cross-origin`.
 */
export function effectiveReferrerPolicy(page: PageResponse): string {
  const meta = /<meta name="referrer" content="([^"]+)">/.exec(page.body)?.[1];
  const header = page.headers["referrer-policy"];
  const fromHeader = Array.isArray(header) ? header.at(-1) : header;
  return meta ?? fromHeader ?? "strict-origin-when-cross-origin";
}

/**
 * The `Origin` a browser sends with a same-origin, non-CORS form POST from a page with
 * `referrerPolicy` (Fetch standard): `null` under `no-referrer`, otherwise the page's origin
 * (the downgrade and cross-origin cases of the other policies do not apply to a same-origin
 * http page).
 */
export function browserOrigin(referrerPolicy: string, pageOrigin: string): string {
  return referrerPolicy === "no-referrer" ? "null" : pageOrigin;
}

/** GETs the approval page like a browser and extracts the form token, the cookie and the policy. */
export async function openApproval(url: string): Promise<OpenedApproval> {
  const page = await send(url);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
  const setCookie = page.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return {
    page,
    csrf,
    cookie: first?.split(";")[0],
    referrerPolicy: effectiveReferrerPolicy(page),
  };
}

/**
 * POSTs a decision the way a browser submits the page's form: `Origin` derived from the page's
 * referrer policy, `Sec-Fetch-Site: same-origin`, the form token and the cookie. `overrides`
 * replace or (with `undefined`) remove headers, to send what a browser would not.
 */
export function submitDecision(
  url: string,
  decision: string,
  opened: OpenedApproval,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<PageResponse> {
  const pageOrigin = new URL(url).origin;
  const body = new URLSearchParams({ csrf: opened.csrf ?? "", decision }).toString();
  return send(url, {
    method: "POST",
    headers: {
      Origin: browserOrigin(opened.referrerPolicy, pageOrigin),
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-User": "?1",
      "Content-Type": "application/x-www-form-urlencoded",
      ...(opened.cookie === undefined ? {} : { Cookie: opened.cookie }),
      ...overrides,
    },
    body,
  });
}

/** Opens the page and approves (or rejects) like a human would. */
export async function decideInBrowser(
  url: string,
  decision: "approve" | "reject",
): Promise<PageResponse> {
  return submitDecision(url, decision, await openApproval(url));
}
