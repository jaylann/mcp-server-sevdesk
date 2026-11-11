/**
 * Plays the browser for the local approval page: raw `node:http` requests to 127.0.0.1, so tests
 * can also send what a browser would not (a wrong Host, a foreign Origin, no cookie).
 *
 * {@link submitDecision} sends the headers a real browser sends for the page's form POST: the
 * `Origin` follows from the page's effective referrer policy as the Fetch standard defines it
 * ("append a request Origin header": under `no-referrer` a non-CORS POST carries `Origin: null`),
 * plus the browser-set `Sec-Fetch-*` headers. It never forges the origin the server wants to see.
 *
 * {@link openApproval} takes the launch link the server logged (`/open/<ticket>`) and behaves
 * like one browser profile: the first time it presents the ticket, keeps the cookies and follows
 * the redirect to the page; later calls for the same link are that browser opening the link
 * again, with its cookies. A second party is played with a raw {@link send} (no cookies).
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
  /** The last answer: the approval page, or the launch link's answer when it did not redirect. */
  readonly page: PageResponse;
  /** The CSRF token from the form (undefined when the page has no form). */
  readonly csrf: string | undefined;
  /** `name=value` of the cookie the launch link set for the approval page. */
  readonly cookie: string | undefined;
  /** The referrer policy a browser applies to the page (see {@link effectiveReferrerPolicy}). */
  readonly referrerPolicy: string;
  /** The approval page's address (where the launch link redirected to), if it was reached. */
  readonly pageUrl: string | undefined;
}

/** What the browser keeps per launch link: the cookies, and where the link led. */
interface Visit {
  readonly launchCookie: string | undefined;
  readonly pageCookie: string | undefined;
  readonly pageUrl: string;
}

/** The browser profile of this test file: one cookie jar, by launch link. */
const visits = new Map<string, Visit>();

function isLaunchLink(url: string): boolean {
  return new URL(url).pathname.startsWith("/open/");
}

/** `name=value` of the response's cookie that is scoped to a path under `prefix`. */
function cookieFor(response: PageResponse, prefix: string): string | undefined {
  const header = response.headers["set-cookie"];
  const all = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return all.find((cookie) => cookie.includes(`Path=${prefix}`))?.split(";")[0];
}

/**
 * Presents a launch link like a browser: the ticket (with this browser's cookie for the link, if
 * it was here before), then the redirect with the page cookie. Without a redirect the launch
 * link's own answer is the result.
 */
async function followLaunchLink(
  url: string,
  language: string | undefined,
): Promise<{ readonly page: PageResponse; readonly visit: Visit | undefined }> {
  const before = visits.get(url);
  const launch = await send(url, {
    headers: { "Accept-Language": language, Cookie: before?.launchCookie },
  });
  const location = launch.headers["location"];
  if (launch.status !== 303 || typeof location !== "string") {
    return { page: launch, visit: undefined };
  }
  const visit: Visit = {
    launchCookie: cookieFor(launch, "/open/") ?? before?.launchCookie,
    pageCookie: cookieFor(launch, "/approve/") ?? before?.pageCookie,
    pageUrl: new URL(location, url).href,
  };
  visits.set(url, visit);
  const page = await send(visit.pageUrl, {
    headers: { "Accept-Language": language, Cookie: visit.pageCookie },
  });
  return { page, visit };
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

/**
 * Opens the approval like a browser and extracts the form token, the cookie and the policy. `url`
 * is the launch link from the server log (the ticket is presented, the redirect followed), or
 * the page's own address, which is then requested as it is, without a cookie. `language` is the
 * browser's `Accept-Language` (none: the page answers in English).
 */
export async function openApproval(url: string, language?: string): Promise<OpenedApproval> {
  const { page, visit } = isLaunchLink(url)
    ? await followLaunchLink(url, language)
    : {
        page: await send(url, { headers: { "Accept-Language": language } }),
        visit: undefined,
      };
  return {
    page,
    csrf: /name="csrf" value="([^"]+)"/.exec(page.body)?.[1],
    cookie: visit?.pageCookie,
    referrerPolicy: effectiveReferrerPolicy(page),
    pageUrl: visit?.pageUrl,
  };
}

/**
 * POSTs a decision the way a browser submits the page's form: `Origin` derived from the page's
 * referrer policy, `Sec-Fetch-Site: same-origin`, the form token and the cookie. `overrides`
 * replace or (with `undefined`) remove headers, to send what a browser would not.
 *
 * The form posts to the page `opened` reached. `url` may be the launch link that led there (the
 * usual case) or another page's address, to send one approval's token and cookie to another.
 */
export function submitDecision(
  url: string,
  decision: string,
  opened: OpenedApproval,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Promise<PageResponse> {
  const target = isLaunchLink(url) ? (opened.pageUrl ?? url) : url;
  const pageOrigin = new URL(target).origin;
  const body = new URLSearchParams({ csrf: opened.csrf ?? "", decision }).toString();
  return send(target, {
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

/** Opens the page and approves (or rejects) like a human would, in a browser set to `language`. */
export async function decideInBrowser(
  url: string,
  decision: "approve" | "reject",
  language?: string,
): Promise<PageResponse> {
  return submitDecision(url, decision, await openApproval(url, language), {
    "Accept-Language": language,
  });
}
