import type { IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";

import { afterEach, describe, expect, it } from "vitest";

import type { ReadFileOptions } from "../../../src/safety/file-access.js";
import type { PinnedGet, PinnedGetRequest } from "../../../src/safety/pinned-https.js";
import {
  createLinkGet,
  createUrlFileReader,
  isAllowedHost,
} from "../../../src/safety/url-files.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  fakeLinks,
  LINK,
  LINK_HOST,
  LINK_PDF,
  PUBLIC,
  redirect,
  served,
} from "../../helpers/links.js";
import { selfSignedCertificate } from "../http/oauth/self-signed.js";

const RECEIPT: ReadFileOptions = { maxBytes: 1_000_000, kinds: ["pdf", "png", "jpeg"] };
const EINVOICE: ReadFileOptions = { maxBytes: 1_000_000, kinds: ["pdf", "xml"] };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** Pieces of the link and of the remote answers that must never appear in a message. */
const NEVER_SHOWN = ["SIGNATURE-7f3a", "Rechnung-4711", "/portal", "93.184.216.34", "<html"];

/** The refusal `promise` rejects with: a trusted validation error that shows nothing secret. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SevdeskError);
  expect(error).toMatchObject({ kind: "validation", status: undefined });
  const { message } = error as SevdeskError;
  for (const secret of NEVER_SHOWN) expect(message).not.toContain(secret);
  expect(message.endsWith("Nothing was sent to sevDesk.")).toBe(true);
  return message;
}

describe("isAllowedHost", () => {
  it("matches exact hosts and the subdomains of a *. entry, never the apex or a look-alike", () => {
    const hosts = ["belege.example.com", "*.files.example.net"];
    expect(isAllowedHost("belege.example.com", hosts)).toBe(true);
    expect(isAllowedHost("a.files.example.net", hosts)).toBe(true);
    expect(isAllowedHost("a.b.files.example.net", hosts)).toBe(true);
    expect(isAllowedHost("files.example.net", hosts)).toBe(false);
    expect(isAllowedHost("evilfiles.example.net", hosts)).toBe(false);
    expect(isAllowedHost("x.belege.example.com", hosts)).toBe(false);
    expect(isAllowedHost("belege.example.com.evil.net", hosts)).toBe(false);
    expect(isAllowedHost("belege.example.com", [])).toBe(false);
  });
});

describe("createUrlFileReader: before any network I/O", () => {
  it("refuses every link while SEVDESK_FILE_URL_HOSTS is empty, naming the setting", async () => {
    const links = fakeLinks({ hosts: [] });
    const message = await refusal(links.reader(LINK, RECEIPT));
    expect(message).toContain("Files from links are off: SEVDESK_FILE_URL_HOSTS is not set");
    expect(links.resolved).toEqual([]);
    expect(links.requests).toEqual([]);
  });

  it.each([
    ["http://belege.example.com/r.pdf", "is not https"],
    ["ftp://belege.example.com/r.pdf", "is not https"],
    ["file:///etc/passwd", "is not https"],
    ["https://user:secret@belege.example.com/r.pdf", "carries a user name or password"],
    ["https://belege.example.com@evil.example.org/r.pdf", "carries a user name or password"],
    ["https://belege.example.com:8443/r.pdf", "names a port"],
    ["https://127.0.0.1/r.pdf", "names an IP address"],
    ["https://169.254.169.254/latest/meta-data", "names an IP address"],
    ["https://0x7f.1/r.pdf", "names an IP address"],
    ["https://2130706433/r.pdf", "names an IP address"],
    ["https://[::1]/r.pdf", "names an IP address"],
    ["https://[::ffff:10.0.0.1]/r.pdf", "names an IP address"],
    ["https://evil.example.org/r.pdf", "is on a host outside SEVDESK_FILE_URL_HOSTS"],
    ["https://example.com/r.pdf", "is on a host outside SEVDESK_FILE_URL_HOSTS"],
    ["https://belege.example.com./r.pdf", "is on a host outside SEVDESK_FILE_URL_HOSTS"],
    ["https://bad host/r.pdf", "is not a valid URL"],
  ])("refuses %s without resolving or connecting", async (link, reason) => {
    const links = fakeLinks();
    const message = await refusal(links.reader(link, RECEIPT));
    expect(message).toContain(reason);
    expect(message).not.toContain("secret");
    expect(message).not.toContain("evil");
    expect(links.resolved).toEqual([]);
    expect(links.requests).toEqual([]);
  });

  it("names the allowed hosts (the operator's configuration), at most ten", async () => {
    const hosts = Array.from({ length: 12 }, (_, index) => `h${String(index)}.example.com`);
    const message = await refusal(
      fakeLinks({ hosts }).reader("https://other.example.com/r.pdf", RECEIPT),
    );
    expect(message).toContain("(allowed: h0.example.com, h1.example.com,");
    expect(message).toContain("h9.example.com and 2 more)");
    expect(message).not.toContain("other.example.com");
  });
});

describe("createUrlFileReader: resolution", () => {
  it("resolves once, connects to the checked address and sends path and query", async () => {
    const links = fakeLinks();
    const file = await links.reader(LINK, RECEIPT);

    expect(file).toEqual({
      name: "Rechnung-4711.pdf",
      kind: "pdf",
      bytes: new Uint8Array(LINK_PDF),
      source: "url",
      host: LINK_HOST,
    });
    expect(links.resolved).toEqual([LINK_HOST]);
    expect(links.requests).toHaveLength(1);
    expect(links.requests[0]).toMatchObject({
      hostname: LINK_HOST,
      path: "/portal/Rechnung-4711.pdf?sig=SIGNATURE-7f3a&exp=1",
      address: PUBLIC,
      maxBytes: RECEIPT.maxBytes,
    });
    // The request names no header at all: the transport sends only Accept and User-Agent.
    expect(Object.keys(links.requests[0] ?? {}).sort()).toEqual([
      "address",
      "hostname",
      "maxBytes",
      "path",
      "signal",
    ]);
  });

  it.each([
    ["a private address", [{ address: "10.0.0.5", family: 4 as const }]],
    ["the metadata service", [{ address: "169.254.169.254", family: 4 as const }]],
    ["loopback", [{ address: "127.0.0.1", family: 4 as const }]],
    ["CGNAT", [{ address: "100.64.1.2", family: 4 as const }]],
    ["multicast", [{ address: "224.0.0.1", family: 4 as const }]],
    ["IPv6 loopback", [{ address: "::1", family: 6 as const }]],
    ["IPv6 link-local", [{ address: "fe80::1", family: 6 as const }]],
    ["IPv6 unique local", [{ address: "fd00::1", family: 6 as const }]],
    ["an IPv4-mapped private address", [{ address: "::ffff:192.168.1.1", family: 6 as const }]],
    ["one private among public ones", [PUBLIC, { address: "10.0.0.5", family: 4 as const }]],
  ])("refuses a host that resolves to %s, without connecting", async (_name, addresses) => {
    const links = fakeLinks({ addresses: { [LINK_HOST]: addresses } });
    const message = await refusal(links.reader(LINK, RECEIPT));
    expect(message).toContain("resolves to an address this server does not connect to");
    expect(links.requests).toEqual([]);
  });

  it("refuses a host that does not resolve, or not in time", async () => {
    const missing = fakeLinks({ addresses: {} });
    expect(await refusal(missing.reader(LINK, RECEIPT))).toContain("could not be resolved");

    const reader = createUrlFileReader({
      hosts: [LINK_HOST],
      resolve: () => new Promise(() => undefined),
      get: () => Promise.reject(new Error("must not connect")),
      resolveTimeoutMs: 20,
    });
    expect(await refusal(reader(LINK, RECEIPT))).toContain("could not be resolved");
  });

  it("never uses a second resolution: a redirect back to the host keeps its first address", async () => {
    let answers = 0;
    const requests: PinnedGetRequest[] = [];
    const reader = createUrlFileReader({
      hosts: [LINK_HOST],
      // DNS rebinding: public at the first answer, the metadata service afterwards.
      resolve: () => {
        answers += 1;
        return Promise.resolve(
          answers === 1 ? [PUBLIC] : [{ address: "169.254.169.254", family: 4 as const }],
        );
      },
      get: (request) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1 ? redirect("/download/final.pdf") : served(LINK_PDF),
        );
      },
    });

    const file = await reader(LINK, RECEIPT);

    expect(file.name).toBe("final.pdf");
    expect(answers).toBe(1);
    expect(requests.map((request) => request.address)).toEqual([PUBLIC, PUBLIC]);
    expect(requests.map((request) => request.path)).toEqual([
      "/portal/Rechnung-4711.pdf?sig=SIGNATURE-7f3a&exp=1",
      "/download/final.pdf",
    ]);
  });
});

describe("createUrlFileReader: redirects", () => {
  const CDN = "cdn.example.net";

  it("follows a redirect to another allowed host, checked and resolved like the first", async () => {
    const links = fakeLinks({
      hosts: [LINK_HOST, `*.${CDN}`],
      addresses: { [LINK_HOST]: [PUBLIC], [`eu.${CDN}`]: [{ address: "8.8.4.4", family: 4 }] },
      respond: (request) =>
        request.hostname === LINK_HOST
          ? redirect(`https://eu.${CDN}/x/Beleg%20M%C3%A4rz.pdf?X-Amz-Signature=abc#frag`, 307)
          : served(LINK_PDF, { "content-type": "binary/octet-stream" }),
    });

    const file = await links.reader(LINK, RECEIPT);

    expect(file).toMatchObject({ name: "Beleg_M_rz.pdf", host: `eu.${CDN}`, source: "url" });
    expect(links.resolved).toEqual([LINK_HOST, `eu.${CDN}`]);
    expect(links.requests[1]).toMatchObject({
      hostname: `eu.${CDN}`,
      path: "/x/Beleg%20M%C3%A4rz.pdf?X-Amz-Signature=abc",
      address: { address: "8.8.4.4", family: 4 },
    });
  });

  it.each([
    ["to a private address", "https://inner.example.com/x.pdf", "resolves to an address"],
    ["to an IP literal", "https://10.0.0.1/x.pdf", "redirects to a target that names an IP"],
    ["to metadata", "https://169.254.169.254/latest", "redirects to a target that names an IP"],
    ["to http", "http://belege.example.com/x.pdf", "redirects to a target that is not https"],
    ["to a host off the list", "https://evil.example.org/x.pdf", "redirects to a target that is"],
    ["with credentials", "https://u:p@belege.example.com/x", "carries a user name or password"],
    [
      "to another port",
      "https://belege.example.com:444/x",
      "redirects to a target that names a port",
    ],
    ["without a target", "", "redirects without naming a target"],
  ])("refuses a redirect %s", async (_name, location, reason) => {
    const links = fakeLinks({
      hosts: [LINK_HOST, "inner.example.com"],
      addresses: {
        [LINK_HOST]: [PUBLIC],
        "inner.example.com": [{ address: "192.168.0.10", family: 4 }],
      },
      respond: () => redirect(location),
    });
    const message = await refusal(links.reader(LINK, RECEIPT));
    expect(message).toContain(reason);
    // Nothing of the target is repeated (the allowed hosts are the operator's own list).
    expect(message).not.toContain("evil");
    expect(message).not.toContain("x.pdf");
    expect(message).not.toContain("192.168");
    expect(links.requests).toHaveLength(1);
  });

  it("stops after three redirects", async () => {
    const links = fakeLinks({ respond: () => redirect("/again") });
    expect(await refusal(links.reader(LINK, RECEIPT))).toContain("redirects more than 3 times");
    expect(links.requests).toHaveLength(4);
    expect(links.resolved).toEqual([LINK_HOST]);
  });
});

describe("createUrlFileReader: the answer", () => {
  it("accepts generic and missing content types and recognizes the kind by content", async () => {
    for (const headers of [{}, { "content-type": "application/octet-stream" }]) {
      const file = await fakeLinks({ respond: () => served(PNG, headers) }).reader(
        "https://belege.example.com/scan.jpg",
        RECEIPT,
      );
      expect(file).toMatchObject({ kind: "png", name: "scan.png" });
    }
    const xml = await fakeLinks({
      respond: () =>
        served('<?xml version="1.0"?><Invoice/>', {
          "content-type": "application/xrechnung+xml; charset=utf-8",
        }),
    }).reader("https://belege.example.com/a/b/", EINVOICE);
    expect(xml).toMatchObject({ kind: "xml", name: "download.xml" });
  });

  it.each([
    ["text/html", "<html><body>Sign in</body></html>"],
    ["application/json", '{"error":"expired"}'],
    ["text/plain", "%PDF-1.7 looks like a PDF"],
  ])("refuses a %s answer (a sign-in or error page)", async (type, body) => {
    const links = fakeLinks({ respond: () => served(body, { "content-type": type }) });
    const message = await refusal(links.reader(LINK, EINVOICE));
    expect(message).toContain("did not answer with a PDF, XML file but with another content type");
    expect(message).not.toContain(type);
    expect(message).not.toContain("expired");
  });

  it("refuses an XHTML page although its content type ends in +xml", async () => {
    const links = fakeLinks({
      respond: () =>
        served('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>', {
          "content-type": "application/xhtml+xml; charset=utf-8",
        }),
    });
    const message = await refusal(links.reader(LINK, EINVOICE));
    expect(message).toContain("did not answer with a PDF, XML file but with another content type");
  });

  it.each([
    ["a doctype", "<!DOCTYPE html><html><body>Anmelden</body></html>"],
    ["an html element", "<html lang=de><body>Sign in</body></html>"],
    ["a byte order mark and white space", "﻿ \n\t<HTML>"],
    ["a declaration and a comment", '<?xml version="1.0"?>\n<!-- portal -->\n<!doctype HTML>'],
  ])("refuses a web page with %s, served as XML or without a type", async (_name, body) => {
    for (const type of ["application/octet-stream", "text/xml", undefined]) {
      const links = fakeLinks({
        respond: () => served(body, type === undefined ? {} : { "content-type": type }),
      });
      expect(await refusal(links.reader(LINK, EINVOICE))).toContain(
        "did not answer with a PDF, XML file but with a web page (a sign-in or error page",
      );
      expect(await refusal(links.reader(LINK, RECEIPT))).toContain(
        "did not answer with a PDF, PNG, JPEG file but with a web page",
      );
    }
  });

  it("reads an e-invoice that starts with a byte order mark, a declaration and a comment", async () => {
    const body =
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- <html> -->\n<rsm:CrossIndustryInvoice/>';
    const links = fakeLinks({ respond: () => served(body, { "content-type": "application/xml" }) });
    await expect(links.reader(LINK, EINVOICE)).resolves.toMatchObject({ kind: "xml" });
  });

  it("refuses content that does not match the declared type or the accepted kinds", async () => {
    const mismatch = fakeLinks({
      respond: () => served(PNG, { "content-type": "application/pdf" }),
    });
    expect(await refusal(mismatch.reader(LINK, RECEIPT))).toContain(
      "does not match the content type the link declared",
    );
    const wrongKind = fakeLinks({ respond: () => served(PNG, { "content-type": "image/png" }) });
    expect(await refusal(wrongKind.reader(LINK, EINVOICE))).toContain(
      "is not an accepted file type (accepted: PDF, XML; checked by content)",
    );
  });

  it("refuses compressed answers", async () => {
    const links = fakeLinks({
      respond: () =>
        served(LINK_PDF, { "content-type": "application/pdf", "content-encoding": "gzip" }),
    });
    expect(await refusal(links.reader(LINK, RECEIPT))).toContain("compressed body");
  });

  it("refuses bodies over the caller's limit, declared or not", async () => {
    const limit = { ...RECEIPT, maxBytes: 16 };
    const declared = fakeLinks({
      respond: () =>
        served(LINK_PDF.subarray(0, 10), {
          "content-type": "application/pdf",
          "content-length": "4096",
        }),
    });
    expect(await refusal(declared.reader(LINK, limit))).toContain(
      "larger than the limit here of 16 bytes",
    );
    const undeclared = fakeLinks();
    expect(await refusal(undeclared.reader(LINK, limit))).toContain("larger than the limit here");
    expect(undeclared.requests[0]?.maxBytes).toBe(16);
  });

  it.each([
    [404, "HTTP 404 (not found, or the link has expired)"],
    [403, "HTTP 403 (the link needs a sign-in or has expired; this server sends no credentials)"],
    [500, "HTTP 500. Nothing"],
  ])("refuses status %i", async (status, text) => {
    const links = fakeLinks({ respond: () => served("<html>error page</html>", {}, status) });
    expect(await refusal(links.reader(LINK, RECEIPT))).toContain(text);
  });

  it("maps network failures to Node's error code only", async () => {
    const reader = createUrlFileReader({
      hosts: [LINK_HOST],
      resolve: () => Promise.resolve([PUBLIC]),
      get: () =>
        Promise.reject(
          Object.assign(new Error("connect ECONNREFUSED 93.184.216.34:443 <html>"), {
            code: "ECONNREFUSED",
          }),
        ),
    });
    const message = await refusal(reader(LINK, RECEIPT));
    expect(message).toContain("could not be downloaded from the link (ECONNREFUSED)");
  });

  it("gives up after the whole download's time, and stops when the call is cancelled", async () => {
    const hanging: PinnedGet = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const reader = createUrlFileReader({
      hosts: [LINK_HOST],
      resolve: () => Promise.resolve([PUBLIC]),
      get: hanging,
      timeoutMs: 50,
    });
    expect(await refusal(reader(LINK, RECEIPT))).toContain("did not finish within 0.05 seconds");

    const controller = new AbortController();
    const slow = createUrlFileReader({
      hosts: [LINK_HOST],
      resolve: () => Promise.resolve([PUBLIC]),
      get: hanging,
    });
    const pending = slow(LINK, { ...RECEIPT, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  describe("a cancellation or the deadline during a redirect", () => {
    const CDN = "cdn.example.net";
    const options = {
      hosts: [LINK_HOST, CDN],
      addresses: { [LINK_HOST]: [PUBLIC], [CDN]: [{ address: "8.8.4.4", family: 4 as const }] },
    };

    it("stops before the next hop when the call is cancelled", async () => {
      const controller = new AbortController();
      const links = fakeLinks({
        ...options,
        respond: (request) => {
          if (request.hostname !== LINK_HOST) return served(LINK_PDF);
          controller.abort();
          return redirect(`https://${CDN}/final.pdf`);
        },
      });
      await expect(
        links.reader(LINK, { ...RECEIPT, signal: controller.signal }),
      ).rejects.toMatchObject({ kind: "aborted" });
      expect(links.resolved).toEqual([LINK_HOST]);
      expect(links.requests).toHaveLength(1);
    });

    it("stops before the next hop when the deadline has passed", async () => {
      const links = fakeLinks({
        ...options,
        timeoutMs: 20,
        respond: async (request) => {
          if (request.hostname !== LINK_HOST) return served(LINK_PDF);
          await new Promise((resolve) => setTimeout(resolve, 80));
          return redirect(`https://${CDN}/final.pdf`);
        },
      });
      expect(await refusal(links.reader(LINK, RECEIPT))).toContain(
        "did not finish within 0.02 seconds",
      );
      expect(links.resolved).toEqual([LINK_HOST]);
      expect(links.requests).toHaveLength(1);
    });
  });

  it("runs at most two downloads per account and four in all, and frees the slots", async () => {
    const release: (() => void)[] = [];
    const readerOf = (account?: string) =>
      createUrlFileReader({
        hosts: [LINK_HOST],
        account,
        resolve: () => Promise.resolve([PUBLIC]),
        get: () =>
          new Promise((resolve) => {
            release.push(() => {
              resolve(served(LINK_PDF));
            });
          }),
      });
    const first = readerOf("account-1");
    const second = readerOf("account-2");
    // Without an account the downloads count against the one local account of stdio.
    const local = readerOf();

    const running = [first(LINK, RECEIPT), first(LINK, RECEIPT)];
    await expect.poll(() => release.length).toBe(2);
    expect(await refusal(first(LINK, RECEIPT))).toContain(
      "2 downloads from links are already running for this account",
    );

    running.push(local(LINK, RECEIPT), local(LINK, RECEIPT));
    await expect.poll(() => release.length).toBe(4);
    expect(await refusal(local(LINK, RECEIPT))).toContain("already running for this account");
    // Another account still has room of its own, but the process is full.
    expect(await refusal(second(LINK, RECEIPT))).toContain(
      "Too many downloads from links are running on this server at once",
    );

    for (const done of release.splice(0)) done();
    await Promise.all(running);
    const again = [first(LINK, RECEIPT), first(LINK, RECEIPT)];
    await expect.poll(() => release.length).toBe(2);
    for (const done of release.splice(0)) done();
    await expect(Promise.all(again)).resolves.toHaveLength(2);
  });
});

describe("createUrlFileReader: the file's name", () => {
  const name = async (path: string): Promise<string> =>
    (await fakeLinks().reader(`https://${LINK_HOST}${path}?sig=SIGNATURE-7f3a`, RECEIPT)).name;

  it("is the last path segment when it is a short file name, with the content's extension", async () => {
    expect(await name("/portal/Rechnung-4711.pdf")).toBe("Rechnung-4711.pdf");
    expect(await name("/portal/Rechnung-4711.PDF")).toBe("Rechnung-4711.pdf");
    expect(await name("/x/Beleg%20M%C3%A4rz.jpeg")).toBe("Beleg_M_rz.pdf");
    const longest = `${"R".repeat(60)}.pdf`;
    expect(await name(`/x/${longest}`)).toBe(longest);
  });

  it.each([
    ["a capability token without an extension", "/dl/9fK2xQzLmN4pRtV8wY1aB3cD5eF7gH9jK0Qz"],
    ["a segment longer than 64 characters", `/x/${"R".repeat(61)}.pdf`],
    ["an 80-character segment", `/portal/Rechnung_${"0".repeat(67)}.pdf`],
    ["a broken escape", "/x/Beleg%E4.pdf"],
    ["an extension alone", "/x/.pdf"],
    ["no segment", "/"],
  ])("is download.<ext> for %s", async (_name, path) => {
    expect(await name(path)).toBe("download.pdf");
  });
});

describe("createLinkGet (real TLS on 127.0.0.1)", () => {
  const HOST = "files.example.test";
  const { key, cert } = selfSignedCertificate(HOST);
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  async function tlsServer(
    handler: Parameters<typeof createHttpsServer>[1],
  ): Promise<{ port: number; seen: { path: string; headers: IncomingHttpHeaders }[] }> {
    const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
    const server = createHttpsServer({ key, cert }, (request, response) => {
      seen.push({ path: request.url ?? "", headers: request.headers });
      handler?.(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { port: typeof address === "object" && address !== null ? address.port : 0, seen };
  }

  /**
   * The reader over the real transport: the fake resolver answers with a public address (so the
   * check passes), and the transport is pointed at the local server instead.
   */
  function reader(port: number, options: { totalTimeoutMs?: number } = {}) {
    const real = createLinkGet({ port, ca: cert, ...options });
    return createUrlFileReader({
      hosts: [HOST],
      resolve: () => Promise.resolve([PUBLIC]),
      get: (request) => real({ ...request, address: { address: "127.0.0.1", family: 4 } }),
    });
  }

  const link = `https://${HOST}/belege/Beleg-0815.pdf?token=SECRET-TOKEN`;

  it("sends no credentials: only Accept, User-Agent, Host and Connection", async () => {
    const { port, seen } = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf", "Set-Cookie": "a=b" });
      response.end(LINK_PDF);
    });

    const file = await reader(port)(link, RECEIPT);

    expect(file).toMatchObject({ name: "Beleg-0815.pdf", kind: "pdf", host: HOST });
    expect(Buffer.from(file.bytes)).toEqual(Buffer.from(LINK_PDF));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/belege/Beleg-0815.pdf?token=SECRET-TOKEN");
    const headers = seen[0]?.headers ?? {};
    expect(Object.keys(headers).sort()).toEqual(["accept", "connection", "host", "user-agent"]);
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.host).toBe(`${HOST}:${String(port)}`);
    expect(headers["user-agent"]).toBe("mcp-server-sevdesk (file download)");
  });

  it("stops reading a body over the limit, with and without Content-Length", async () => {
    const limit = { ...RECEIPT, maxBytes: 1_024 };
    const declared = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": "4096" });
      response.end(Buffer.alloc(4_096, 0x20));
    });
    expect(await refusal(reader(declared.port)(link, limit))).toContain(
      "larger than the limit here of 1024 bytes",
    );
    const streamed = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.write(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(800, 0x20)]));
      response.end(Buffer.alloc(800, 0x20));
    });
    expect(await refusal(reader(streamed.port)(link, limit))).toContain(
      "larger than the limit here of 1024 bytes",
    );
  });

  it("gives up on a body that trickles in too slowly", async () => {
    const { port } = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.write("%PDF-1.7\n");
      // …and never ends.
    });
    expect(await refusal(reader(port, { totalTimeoutMs: 150 })(link, RECEIPT))).toContain(
      "could not be downloaded from the link",
    );
  });

  it("refuses a page or a compressed answer on its headers, before reading the body", async () => {
    // Both bodies never end: only a refusal on the headers comes back before the deadline.
    const page = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.write("<html>");
    });
    expect(await refusal(reader(page.port, { totalTimeoutMs: 3_000 })(link, RECEIPT))).toContain(
      "did not answer with a PDF, PNG, JPEG file but with another content type",
    );
    const compressed = await tlsServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Encoding": "gzip" });
      response.write("%PDF-1.7\n");
    });
    expect(
      await refusal(reader(compressed.port, { totalTimeoutMs: 3_000 })(link, RECEIPT)),
    ).toContain("compressed body");
  });

  it("does not follow a redirect itself; the reader checks the target", async () => {
    const { port, seen } = await tlsServer((_request, response) => {
      response.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data" });
      response.end();
    });
    const message = await refusal(reader(port)(link, RECEIPT));
    expect(message).toContain("redirects to a target that names an IP address");
    expect(seen).toHaveLength(1);
  });

  it("verifies the certificate against the host name", async () => {
    const { port } = await tlsServer((_request, response) => response.end("%PDF-1.7"));
    const unknownCa = createLinkGet({ port });
    await expect(
      unknownCa({
        hostname: HOST,
        path: "/x.pdf",
        address: { address: "127.0.0.1", family: 4 },
      }),
    ).rejects.toThrow();
  });
});
