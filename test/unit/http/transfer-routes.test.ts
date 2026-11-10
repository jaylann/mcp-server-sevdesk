import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestPrincipal } from "../../../src/accounts/types.js";
import { createBrowserSession, type InboxLogin } from "../../../src/http/browser-session.js";
import { createServerKeys } from "../../../src/http/keys.js";
import { createRateLimiter } from "../../../src/http/rate-limit.js";
import { createRouter } from "../../../src/http/router.js";
import { contentDisposition, kindList } from "../../../src/http/transfer-pages.js";
import {
  createTransferRoutes,
  FILES_RATE,
  MAX_UPLOAD_BODY_BYTES,
  UPLOAD_RATE_HOUR,
  UPLOAD_RATE_MINUTE,
  uploadName,
} from "../../../src/http/transfer-routes.js";
import { openBlobStore } from "../../../src/safety/blob-store.js";
import {
  createTransferStore,
  type FileTransferStore,
  type TransferStoreOptions,
} from "../../../src/safety/transfer-store.js";
import {
  type BrowserResponse,
  captureLog,
  createMemorySessionStore,
  csrfOf,
  fakeClock,
  ORIGIN,
  RemoteBrowser,
} from "../../helpers/remote-approvals.js";

const TOKEN_A = "a1c3".repeat(8);
const TOKEN_B = "b2d4".repeat(8);
const ACCOUNTS: Readonly<Record<string, string>> = { [TOKEN_A]: "1001", [TOKEN_B]: "2002" };
const A1: RequestPrincipal = { grantKey: "grant-a1", accountScope: "1001" };
const B: RequestPrincipal = { grantKey: "grant-b", accountScope: "2002" };
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\nBeleg 4711\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const XML = Buffer.from('<?xml version="1.0"?><rsm:CrossIndustryInvoice/>');
const IP = "203.0.113.7";

const stores: FileTransferStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});

async function setup(storeOptions: Partial<TransferStoreOptions> = {}) {
  const clock = fakeClock();
  const log = captureLog();
  const sessions = createMemorySessionStore(clock.now);
  const keys = createServerKeys(new Uint8Array(randomBytes(32)));
  const store = createTransferStore({
    blobs: await openBlobStore(),
    maxBytes: 64 * 1024 * 1024,
    fileTtlMs: 30 * 60_000,
    now: clock.now,
    pruneIntervalMs: 0,
    ...storeOptions,
  });
  stores.push(store);
  const login: InboxLogin = (token) => {
    const accountId = ACCOUNTS[token];
    return Promise.resolve(accountId === undefined ? { error: "refused" } : { accountId });
  };
  const session = createBrowserSession({ sessions, keys, origin: ORIGIN, login, now: clock.now });
  const transfer = createTransferRoutes({ store, session, origin: ORIGIN });
  const router = createRouter({
    http: { allowedHosts: ["mcp.example.com"], allowedOrigins: [ORIGIN], trustProxy: 0 },
    origin: ORIGIN,
    routes: [...session.routes, ...transfer],
    log,
    now: clock.now,
    limiter: createRateLimiter({ now: clock.now }),
  });
  const send = (request: Request) => router.fetch(request, IP);
  const browser = () => new RemoteBrowser(send);
  return { clock, log, sessions, store, session, transfer, router, send, browser };
}

type Env = Awaited<ReturnType<typeof setup>>;

async function signedIn(env: Env, token = TOKEN_A): Promise<RemoteBrowser> {
  const browser = env.browser();
  const response = await browser.signIn(token);
  expect(response.status).toBe(200);
  return browser;
}

interface Part {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type?: string;
}

/** A multipart body as a browser's form submission encodes it. */
async function multipart(
  fields: readonly (readonly [string, string | Part])[],
): Promise<{ body: Uint8Array; type: string }> {
  const form = new FormData();
  for (const [name, value] of fields) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, new File([value.bytes], value.name, { type: value.type ?? "" }));
  }
  const encoded = new Request("http://encoder.invalid/", { method: "POST", body: form });
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    type: encoded.headers.get("content-type") ?? "",
  };
}

/** Submits an upload form from `browser` (cookies, same-origin headers, Content-Length). */
async function upload(
  env: Env,
  browser: RemoteBrowser,
  path: string,
  fields: readonly (readonly [string, string | Part])[],
  headers: Readonly<Record<string, string | undefined>> = {},
): Promise<BrowserResponse> {
  const { body, type } = await multipart(fields);
  const sent: Record<string, string | undefined> = {
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": type,
    "Content-Length": String(body.byteLength),
    Cookie: [...browser.jar].map(([name, value]) => `${name}=${value}`).join("; "),
    ...headers,
  };
  const final: Record<string, string> = {};
  for (const [name, value] of Object.entries(sent)) if (value !== undefined) final[name] = value;
  const response = await env.send(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: final, body }),
  );
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** Opens the upload page and submits `file` with its CSRF tag. */
async function uploadFile(
  env: Env,
  browser: RemoteBrowser,
  path: string,
  file: Part,
): Promise<BrowserResponse> {
  const page = await browser.get(path);
  return upload(env, browser, path, [
    ["csrf", csrfOf(page.body) ?? ""],
    ["file", file],
  ]);
}

function withoutNonce(body: string): string {
  return body.replace(/nonce="[^"]+"/g, 'nonce=""');
}

describe("transfer routes: declaration", () => {
  it("declares the upload and download routes with their limits", async () => {
    const { transfer } = await setup();
    expect(
      transfer.map((route) => ({
        path: route.path,
        match: route.match,
        methods: route.methods,
        origin: route.origin,
        maxBodyBytes: route.maxBodyBytes,
        rateLimit: route.rateLimit,
        bodyTimeoutMs: route.bodyTimeoutMs,
        bodyPace: route.bodyPace,
        slots: route.bodySlots?.max,
        slotsPerAccount: route.bodySlots?.perKey,
      })),
    ).toEqual([
      {
        path: "/uploads/",
        match: "prefix",
        methods: ["GET", "POST"],
        origin: "form",
        maxBodyBytes: 20 * 1024 * 1024 + 64 * 1024,
        rateLimit: FILES_RATE,
        bodyTimeoutMs: 90_000,
        bodyPace: { idleMs: 10_000, graceMs: 10_000, minBytesPerSecond: 16 * 1024 },
        slots: 2,
        slotsPerAccount: 1,
      },
      {
        path: "/files/",
        match: "prefix",
        methods: ["GET"],
        origin: "form",
        maxBodyBytes: 0,
        rateLimit: FILES_RATE,
        bodyTimeoutMs: undefined,
        bodyPace: undefined,
        slots: undefined,
        slotsPerAccount: undefined,
      },
    ]);
    expect(MAX_UPLOAD_BODY_BYTES).toBe(20 * 1024 * 1024 + 64 * 1024);
    expect(FILES_RATE).toEqual({ name: "files", perMinute: 60 });
    expect(UPLOAD_RATE_MINUTE).toEqual({ name: "uploads", perMinute: 10 });
    expect(UPLOAD_RATE_HOUR).toEqual({ name: "uploads-hour", perMinute: 1, burst: 60 });
    const head = new Request(`${ORIGIN}/uploads/x`, { method: "POST" });
    const busy = transfer[0]?.bodySlots?.busy?.("route", head);
    expect(busy?.status).toBe(503);
    expect(busy?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(busy?.headers.get("retry-after")).toBe("10");
    expect(await busy?.text()).toContain("Other uploads are being received");
    const mine = transfer[0]?.bodySlots?.busy?.("key", head);
    expect(mine?.status).toBe(503);
    expect(await mine?.text()).toContain("Another upload of this sevDesk account");
  });
});

describe("transfer routes: upload page", () => {
  it("shows only the sign-in form without a session, returning to the page after", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const path = `/uploads/${ticket.id}`;
    const browser = env.browser();
    const page = await browser.get(path);
    expect(page.status).toBe(200);
    expect(page.body).toContain('type="password"');
    expect(page.body).toContain("Sign in to transfer files");
    expect(page.body).toContain(`name="next" value="${path}"`);
    for (const secret of [ticket.reference, "receipt", "1001", "PNG", "Largest file"]) {
      expect(page.body).not.toContain(secret);
    }
    // A malformed id gets the plain sign-in form (no `next`).
    const odd = await browser.get("/uploads/<script>");
    expect(odd.body).not.toContain('name="next"');

    const signed = await browser.post("/approvals/login", { token: TOKEN_A, next: path });
    expect(signed.status).toBe(303);
    expect(signed.headers.get("location")).toBe(`${ORIGIN}${path}`);
    const form = await browser.get(path);
    expect(form.status).toBe(200);
    expect(form.body).toContain("<h1>Upload a receipt</h1>");
    expect(form.body).toContain("sevDesk account <strong>1001</strong>");
    expect(form.body).toContain("<dd>PDF, PNG or JPEG (checked by content)</dd>");
    expect(form.body).toContain("<dd>20 MB</dd>");
    expect(form.body).toContain("<dd>2026-11-09 12:15 UTC</dd>");
    expect(form.body).toContain(`<strong>${ticket.reference}</strong>`);
    expect(form.body).toContain('enctype="multipart/form-data"');
    expect(form.body).toContain(
      'accept=".pdf,application/pdf,.png,image/png,.jpg,.jpeg,image/jpeg"',
    );
    expect(form.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(form.headers.get("content-security-policy")).not.toContain("script-src");
  });

  it("answers another account's ticket exactly like an unknown one", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const other = await signedIn(env, TOKEN_B);
    const foreign = await other.get(`/uploads/${ticket.id}`);
    const unknown = await other.get(`/uploads/${"x".repeat(43)}`);
    const malformed = await other.get("/uploads/abc");
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(withoutNonce(foreign.body)).toBe(withoutNonce(unknown.body));
    expect(foreign.body).not.toContain(ticket.reference);
    const posted = await upload(env, other, `/uploads/${ticket.id}`, [
      ["csrf", "x"],
      ["file", { name: "a.pdf", bytes: PDF }],
    ]);
    expect(posted.status).toBe(404);
    expect(env.store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
    // The other account's own ticket is shown to it.
    const own = env.store.createTicket(B, "einvoice");
    const ownPage = await other.get(`/uploads/${own.id}`);
    expect(ownPage.status).toBe(200);
    expect(ownPage.body).toContain("<strong>2002</strong>");
  });

  it("answers a German browser in German, with the size limit in the text", async () => {
    const env = await setup();
    const browser = await signedIn(env);
    browser.language = "de-DE,de;q=0.9,en;q=0.8";

    const missing = await browser.get(`/uploads/${"u".repeat(43)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-language")).toBe("de");
    expect(missing.body).toContain('<html lang="de">');
    expect(missing.body).toContain("<h1>Upload-Seite nicht gefunden</h1>");

    const head = new Request(`${ORIGIN}/uploads/x`, {
      method: "POST",
      headers: { "Accept-Language": "de" },
    });
    const busy = env.transfer[0]?.bodySlots?.busy?.("key", head);
    expect(await busy?.text()).toContain("ein anderer Upload dieses sevDesk-Kontos");
  });

  it("answers 410 for an expired upload page, on GET and POST", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const page = await browser.get(`/uploads/${ticket.id}`);
    env.clock.advance(15 * 60_000);
    expect((await browser.get(`/uploads/${ticket.id}`)).status).toBe(410);
    const late = await upload(env, browser, `/uploads/${ticket.id}`, [
      ["csrf", csrfOf(page.body) ?? ""],
      ["file", { name: "a.pdf", bytes: PDF }],
    ]);
    expect(late.status).toBe(410);
    expect(late.body).toContain("Upload page expired");
  });
});

describe("transfer routes: upload", () => {
  it("receives a file once and shows the receipt; the tool reads it", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const path = `/uploads/${ticket.id}`;
    const browser = await signedIn(env);
    const done = await uploadFile(env, browser, path, {
      name: "Beleg März.pdf",
      bytes: PDF,
      type: "application/pdf",
    });
    expect(done.status).toBe(200);
    expect(done.body).toContain("<h1>File received</h1>");
    expect(done.body).toContain("<strong>Beleg_Maerz.pdf</strong>");
    expect(done.body).toContain(`<strong>${ticket.reference}</strong>`);
    expect(await env.store.readUpload(A1, ticket.id)).toEqual({
      name: "Beleg_Maerz.pdf",
      kind: "pdf",
      bytes: PDF,
      source: "upload",
    });
    // Opening the page again shows the receipt; a second upload is refused.
    expect((await browser.get(path)).body).toContain("File received");
    const again = await upload(env, browser, path, [
      ["csrf", "irrelevant"],
      ["file", { name: "b.pdf", bytes: PDF }],
    ]);
    expect(again.status).toBe(409);
    expect(env.log.lines.filter((line) => line.includes("upload_received"))).toEqual([
      `info upload_received {"account":"1001","reference":"${ticket.reference}","kind":"pdf","bytes":${String(PDF.length)}}`,
    ]);
  });

  it("refuses a missing or wrong CSRF tag", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const path = `/uploads/${ticket.id}`;
    const wrong = await upload(env, browser, path, [
      ["csrf", "forged"],
      ["file", { name: "a.pdf", bytes: PDF }],
    ]);
    expect(wrong.status).toBe(403);
    const missing = await upload(env, browser, path, [["file", { name: "a.pdf", bytes: PDF }]]);
    expect(missing.status).toBe(400);
    const otherSession = await signedIn(env);
    const borrowed = csrfOf((await otherSession.get(path)).body) ?? "";
    const crossed = await upload(env, browser, path, [
      ["csrf", borrowed],
      ["file", { name: "a.pdf", bytes: PDF }],
    ]);
    expect(crossed.status).toBe(403);
    expect(env.store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
  });

  it.each([
    ["a foreign Origin", { Origin: "https://evil.example" }],
    ["Origin: null", { Origin: "null" }],
    ["no Origin and a cross-site fetch", { Origin: undefined, "Sec-Fetch-Site": "cross-site" }],
  ])("refuses %s before reading the body", async (_label, headers) => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const page = await browser.get(`/uploads/${ticket.id}`);
    const response = await upload(
      env,
      browser,
      `/uploads/${ticket.id}`,
      [
        ["csrf", csrfOf(page.body) ?? ""],
        ["file", { name: "a.pdf", bytes: PDF }],
      ],
      headers,
    );
    expect(response.status).toBe(403);
    expect(env.store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
  });

  it("refuses an upload without a session, without reading the body", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const response = await upload(env, env.browser(), `/uploads/${ticket.id}`, [
      ["csrf", "x"],
      ["file", { name: "a.pdf", bytes: PDF }],
    ]);
    expect(response.status).toBe(403);
    expect(response.body).toContain("Sign in again");
    expect(env.log.lines.some((line) => line.includes('"reason":"signed_out"'))).toBe(true);
  });

  it("checks the declared length and type before the body: 411, 413, 415", async () => {
    const env = await setup({ maxUploadBytes: 1_000 });
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const path = `/uploads/${ticket.id}`;
    const fields = [
      ["csrf", "x"],
      ["file", { name: "a.pdf", bytes: PDF }],
    ] as const;
    const chunked = await upload(env, browser, path, fields, { "Content-Length": undefined });
    expect(chunked.status).toBe(411);
    const huge = await upload(env, browser, path, fields, {
      "Content-Length": String(1_000 + 64 * 1024 + 1),
    });
    expect(huge.status).toBe(413);
    expect(huge.body).toContain("File too large");
    const urlencoded = await browser.post(path, { csrf: "x", file: "a" });
    expect(urlencoded.status).toBe(415);
  });

  it("refuses files over the limit, empty files and kinds the ticket does not take", async () => {
    const env = await setup({ maxUploadBytes: 2_000 });
    const browser = await signedIn(env);
    const receipt = env.store.createTicket(A1, "receipt");
    const big = await uploadFile(env, browser, `/uploads/${receipt.id}`, {
      name: "big.pdf",
      bytes: Buffer.concat([PDF, Buffer.alloc(2_000)]),
    });
    expect(big.status).toBe(413);
    const empty = await uploadFile(env, browser, `/uploads/${receipt.id}`, {
      name: "e.pdf",
      bytes: new Uint8Array(0),
    });
    expect(empty.status).toBe(400);
    const xml = await uploadFile(env, browser, `/uploads/${receipt.id}`, {
      name: "invoice.pdf",
      bytes: XML,
      type: "application/pdf",
    });
    expect(xml.status).toBe(415);
    const einvoice = env.store.createTicket(A1, "einvoice");
    const png = await uploadFile(env, browser, `/uploads/${einvoice.id}`, {
      name: "scan.png",
      bytes: PNG,
    });
    expect(png.status).toBe(415);
    expect(png.body).toContain("checked by the file&#39;s content");
    const ok = await uploadFile(env, browser, `/uploads/${einvoice.id}`, {
      name: "xrechnung.xml",
      bytes: XML,
    });
    expect(ok.status).toBe(200);
    expect((await env.store.readUpload(A1, einvoice.id))?.name).toBe("xrechnung.xml");
  });

  it.each([
    ["two files", [["file", { name: "b.pdf", bytes: PDF }]]],
    ["an extra field", [["note", "hello"]]],
    ["a second csrf", [["csrf", "again"]]],
  ] as const)("refuses a form with %s", async (_label, extra) => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const page = await browser.get(`/uploads/${ticket.id}`);
    const response = await upload(env, browser, `/uploads/${ticket.id}`, [
      ["csrf", csrfOf(page.body) ?? ""],
      ["file", { name: "a.pdf", bytes: PDF }],
      ...extra,
    ]);
    expect(response.status).toBe(400);
    expect(env.store.ticketFor(ticket.id, "1001")).toMatchObject({ status: "pending" });
  });

  it("refuses a file sent as a text field and a malformed body", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const page = await browser.get(`/uploads/${ticket.id}`);
    const csrf = csrfOf(page.body) ?? "";
    const text = await upload(env, browser, `/uploads/${ticket.id}`, [
      ["csrf", csrf],
      ["file", "%PDF-1.7 not a file part"],
    ]);
    expect(text.status).toBe(400);
    const garbage = await env.send(
      new Request(`${ORIGIN}/uploads/${ticket.id}`, {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: [...browser.jar].map(([name, value]) => `${name}=${value}`).join("; "),
          "Content-Type": "multipart/form-data; boundary=xyz",
          "Content-Length": "9",
        },
        body: "not-multi",
      }),
    );
    expect(garbage.status).toBe(400);
  });

  it.each([
    ["../../etc/passwd.pdf", "passwd.pdf"],
    ["..\\..\\Windows\\win.ini.pdf", "win.ini.pdf"],
    ["Rechnung‮fdp.exe.pdf", "Rechnungfdp.exe.pdf"],
    ["a\"b'c.pdf", "a_b_c.pdf"],
    ["<script>alert(1)</script>.pdf", "script.pdf"],
    ["<img src=x onerror=alert(1)>.pdf", "img_src_x_onerror_alert_1.pdf"],
    ["CON.pdf", "upload.pdf"],
    ["   .pdf", "upload.pdf"],
    [`${"x".repeat(300)}.pdf`, `${"x".repeat(96)}.pdf`],
    ["photo.JPEG", "photo.pdf"],
  ])("cleans the hostile name %j", async (raw, cleaned) => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const response = await uploadFile(env, browser, `/uploads/${ticket.id}`, {
      name: raw,
      bytes: PDF,
    });
    expect(response.status).toBe(200);
    expect((await env.store.readUpload(A1, ticket.id))?.name).toBe(cleaned);
    expect(response.body).not.toContain("<script>alert");
    expect(response.body).not.toContain("<img");
    expect(response.body).not.toContain("‮");
    expect(env.log.lines.join("\n")).not.toContain(cleaned);
  });

  it("limits upload POSTs to 10 a minute per client", async () => {
    const env = await setup();
    const browser = await signedIn(env);
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await upload(env, browser, `/uploads/${"x".repeat(43)}`, [
        ["csrf", "x"],
        ["file", { name: "a.pdf", bytes: PDF }],
      ]);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(404));
    expect(statuses[10]).toBe(429);
  });

  it("answers 507 when the account's space is full", async () => {
    const env = await setup({ maxBytes: 200 });
    await env.store.createDownload(A1, {
      filename: "a.csv",
      kind: "csv",
      bytes: new Uint8Array(90),
    });
    const ticket = env.store.createTicket(A1, "receipt");
    const browser = await signedIn(env);
    const response = await uploadFile(env, browser, `/uploads/${ticket.id}`, {
      name: "a.pdf",
      bytes: PDF,
    });
    expect(response.status).toBe(507);
    expect(response.body).toContain("No space for the file");
  });

  it("lets one account send one body at a time and drops a stalled one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const env = await setup();
      const first = env.store.createTicket(A1, "receipt");
      const second = env.store.createTicket(A1, "receipt");
      const other = env.store.createTicket(B, "receipt");
      const a = await signedIn(env);
      const b = await signedIn(env, TOKEN_B);
      const firstPath = `/uploads/${first.id}`;
      const csrf = csrfOf((await a.get(firstPath)).body) ?? "";

      // Account A starts an upload and stops sending after the first bytes.
      const { body, type } = await multipart([
        ["csrf", csrf],
        ["file", { name: "a.pdf", bytes: PDF }],
      ]);
      const stalled = env.send(
        new Request(`${ORIGIN}${firstPath}`, {
          method: "POST",
          headers: {
            Origin: ORIGIN,
            "Content-Type": type,
            "Content-Length": String(body.byteLength),
            Cookie: [...a.jar].map(([name, value]) => `${name}=${value}`).join("; "),
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.subarray(0, 20));
            },
          }),
          duplex: "half",
        }),
      );
      await vi.waitFor(() => {
        expect(env.router.inFlight).toBe(1);
      });

      // A second body of A waits; account B still uploads.
      const busy = await uploadFile(env, a, `/uploads/${second.id}`, { name: "b.pdf", bytes: PDF });
      expect(busy.status).toBe(503);
      expect(busy.body).toContain("Another upload of this sevDesk account");
      const theirs = await uploadFile(env, b, `/uploads/${other.id}`, {
        name: "c.pdf",
        bytes: PDF,
      });
      expect(theirs.status).toBe(200);

      // Ten seconds without a byte: 408, the slot is free, the ticket can still be used.
      await vi.advanceTimersByTimeAsync(10_000);
      const dropped = await stalled;
      expect(dropped.status).toBe(408);
      expect(await dropped.text()).toContain("arrived too slowly");
      expect(env.store.ticketFor(first.id, "1001")).toMatchObject({ status: "pending" });
      const retried = await uploadFile(env, a, `/uploads/${second.id}`, {
        name: "b.pdf",
        bytes: PDF,
      });
      expect(retried.status).toBe(200);
      expect(env.router.inFlight).toBe(0);
      expect(env.log.lines.join("\n")).not.toContain(first.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 500 when the file cannot be stored, and keeps the ticket", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    vi.spyOn(env.store, "receive").mockRejectedValueOnce(new Error("disk gone"));
    const browser = await signedIn(env);
    const response = await uploadFile(env, browser, `/uploads/${ticket.id}`, {
      name: "a.pdf",
      bytes: PDF,
    });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain("disk gone");
  });
});

describe("transfer routes: downloads", () => {
  it("serves the file as an attachment with exact headers, 5 times, then 410", async () => {
    const env = await setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const link = await env.store.createDownload(A1, {
      filename: "Rechnung RE-1001 März.pdf",
      kind: "pdf",
      bytes: PDF,
    });
    const browser = await signedIn(env);
    const first = await env.send(
      new Request(`${ORIGIN}/files/${link.id}`, {
        headers: { Cookie: [...browser.jar].map(([n, v]) => `${n}=${v}`).join("; ") },
      }),
    );
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(PDF);
    expect(Object.fromEntries(first.headers)).toEqual({
      "accept-ranges": "none",
      "cache-control": "no-store, no-transform",
      "content-disposition":
        "attachment; filename=\"Rechnung_RE-1001_M_rz.pdf\"; filename*=UTF-8''Rechnung%20RE-1001%20M%C3%A4rz.pdf",
      "content-length": String(PDF.length),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "application/pdf",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    for (let index = 0; index < 4; index += 1) {
      expect((await browser.get(`/files/${link.id}`)).status).toBe(200);
    }
    const used = await browser.get(`/files/${link.id}`);
    expect(used.status).toBe(410);
    expect(used.body).toContain("Download link used up");
    // Serving a download never calls sevDesk (or anything else).
    expect(fetchSpy).not.toHaveBeenCalled();
    const served = env.log.lines.filter((line) => line.includes("download_served"));
    expect(served).toHaveLength(5);
    expect(served[0]).toBe(
      `info download_served {"account":"1001","reference":"${link.reference}","kind":"pdf","bytes":${String(PDF.length)}}`,
    );
  });

  it("needs a session of the link's account; HEAD is not allowed", async () => {
    const env = await setup();
    const link = await env.store.createDownload(A1, { filename: "a.csv", kind: "csv", bytes: PDF });
    const anonymous = env.browser();
    const page = await anonymous.get(`/files/${link.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`name="next" value="/files/${link.id}"`);
    expect(page.body).not.toContain(link.reference);
    const other = await signedIn(env, TOKEN_B);
    const foreign = await other.get(`/files/${link.id}`);
    const unknown = await other.get(`/files/${"y".repeat(43)}`);
    expect(foreign.status).toBe(404);
    expect(withoutNonce(foreign.body)).toBe(withoutNonce(unknown.body));
    expect((await other.get("/files/short")).status).toBe(404);
    const head = await env.send(new Request(`${ORIGIN}/files/${link.id}`, { method: "HEAD" }));
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET");
    // None of the refused requests used up a download.
    const owner = await signedIn(env);
    const ok = await owner.get(`/files/${link.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("answers 410 for an expired link", async () => {
    const env = await setup();
    const link = await env.store.createDownload(A1, { filename: "a.zip", kind: "zip", bytes: PDF });
    const browser = await signedIn(env);
    env.clock.advance(30 * 60_000);
    const response = await browser.get(`/files/${link.id}`);
    expect(response.status).toBe(410);
    expect(response.body).toContain("Download link expired");
  });

  it("logs no ids, names, cookies or CSRF tags", async () => {
    const env = await setup();
    const ticket = env.store.createTicket(A1, "receipt");
    const link = await env.store.createDownload(A1, {
      filename: "SECRET-NAME.pdf",
      kind: "pdf",
      bytes: PDF,
    });
    const browser = await signedIn(env);
    const page = await browser.get(`/uploads/${ticket.id}`);
    await uploadFile(env, browser, `/uploads/${ticket.id}`, {
      name: "UPLOADED-NAME.pdf",
      bytes: PDF,
    });
    await browser.get(`/files/${link.id}`);
    await env.browser().get(`/files/${link.id}`);
    const text = env.log.lines.join("\n");
    for (const secret of [
      ticket.id,
      link.id,
      "SECRET-NAME",
      "UPLOADED-NAME",
      csrfOf(page.body) ?? "csrf-missing",
      ...browser.jar.values(),
      TOKEN_A,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"route":"/uploads/*"');
    expect(text).toContain('"route":"/files/*"');
  });
});

describe("transfer pages: helpers", () => {
  it("encodes download names safely", () => {
    expect(contentDisposition("Report 2026.csv")).toBe(
      "attachment; filename=\"Report_2026.csv\"; filename*=UTF-8''Report%202026.csv",
    );
    expect(contentDisposition('a"\r\nSet-Cookie: x=1.pdf')).toBe(
      "attachment; filename=\"a_Set-Cookie_x_1.pdf\"; filename*=UTF-8''a%22Set-Cookie%3A%20x%3D1.pdf",
    );
    expect(contentDisposition("\uD800(x)*'.zip")).toBe(
      "attachment; filename=\"x_.zip\"; filename*=UTF-8''%28x%29%2A%27.zip",
    );
    expect(contentDisposition("äöü")).toBe(
      "attachment; filename=\"download\"; filename*=UTF-8''%C3%A4%C3%B6%C3%BC",
    );
  });

  it("names kinds and cleans upload names", () => {
    expect(kindList(["pdf"])).toBe("PDF");
    expect(kindList(["xml", "pdf"])).toBe("XML or PDF");
    expect(uploadName("scan.jpeg", "jpeg")).toBe("scan.jpg");
    expect(uploadName("", "png")).toBe("upload.png");
  });
});
