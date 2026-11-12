/**
 * Remote file transfer end to end: the composed HTTP mode (`startHttpMode`) with
 * `SEVDESK_HTTP_FILES` on (the default), used the way a claude.ai user meets it. OAuth consent
 * signs the browser in (also without the approval inbox); `sevdesk_upload_request` returns an
 * upload page; the browser opens it and uploads a receipt PDF (multipart, CSRF tag);
 * `sevdesk_voucher_create_draft` with `file: <uploadId>` sends the bytes and the cleaned name to
 * sevDesk; `sevdesk_document_save` returns a download link that the browser's session downloads,
 * with the exact headers and without a sevDesk request. Then what must not work: another account,
 * another grant of the same account, a browser without a session, a restart. And bearer mode,
 * where the browser signs in with the server's sevDesk token. Only the network edges are fakes:
 * sevDesk's API, its identity lookup and the CIMD host.
 *
 * See docs/adr/0008-file-transfer-over-http.md.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpLog } from "../../src/http/log.js";
import { type RunningHttp, startHttpMode } from "../../src/http/run.js";
import { loadFixture } from "../helpers/fake-client.js";
import { openRequest } from "../helpers/http-raw.js";
import {
  ACCOUNT,
  authorizeUrl,
  CLAUDE_AI_CLIENT,
  CLAUDE_AI_REDIRECT,
  completeConsent,
  CookieJar,
  fakeCimd,
  type FakeIdentity,
  fakeIdentity,
  ORIGIN,
  OTHER_ACCOUNT,
  OTHER_TOKEN,
  pkcePair,
  postForm,
  RESOURCE,
  SEVDESK_TOKEN,
} from "../helpers/oauth-browser.js";
import { csrfOf } from "../helpers/remote-approvals.js";
import { resultData, resultText } from "../helpers/write-flow.js";
import { draftRow, positionRow } from "../unit/tools/vouchers/routes.js";

const RECEIPT_PDF = fileURLToPath(
  new URL("../fixtures/einvoice/generated/plain-receipt.pdf", import.meta.url),
);
/** What a browser on Windows may send as the file name: a path, an umlaut, markup. */
const RAW_NAME = "C:\\Users\\Max\\Downloads\\Beleg März <2026>.pdf";
/** The name the server keeps and sends to sevDesk. */
const CLEAN_NAME = "Beleg_Maerz_2026.pdf";
const SESSION_COOKIE = "__Host-sevdesk_session";
/** The `filename` sevDesk's `uploadTempFile` fixture answers, which `saveVoucher` then gets. */
const TEMP_FILENAME = "f019bec36c65f5a0e7d2c63cc33f0681.pdf";
const DRAFT = {
  supplierId: 1001,
  number: "ER-2026-0815",
  date: "2026-11-02",
  positions: [{ accountDatevId: 4266, amount: "119.00", taxRate: 19 }],
};
const UNKNOWN_ID = "Q".repeat(43);
const NO_UPLOAD = "There is no uploaded file for this uploadId";

/** The invoice PDF sevDesk's `getPdf` fixture holds (`RE-1001.pdf`). */
function invoicePdf(): Uint8Array {
  const objects = (
    loadFixture("documents/invoice-pdf.json").body as { objects: { content: string } }
  ).objects;
  return new Uint8Array(Buffer.from(objects.content, "base64"));
}

interface FakeSevdesk {
  readonly fetch: typeof fetch;
  /** `METHOD /path` of every request. */
  readonly calls: string[];
  /** The `Authorization` values sevDesk saw. */
  readonly tokens: Set<string>;
  /** The receipt files sevDesk received (`uploadTempFile`). */
  readonly files: File[];
  /** The bodies `saveVoucher` received. */
  readonly saves: Record<string, unknown>[];
  /** The query strings `getPdf` received. */
  readonly pdfQueries: string[];
}

/**
 * sevDesk's API as the voucher draft (expense, supplier 1001, regular VAT, no duplicate) and the
 * invoice PDF of invoice 1001 need it, recording every request. The files and JSON bodies arrive as
 * the real client sends them (`FormData`, a JSON string).
 */
function fakeSevdesk(): FakeSevdesk {
  const calls: string[] = [];
  const tokens = new Set<string>();
  const files: File[] = [];
  const saves: Record<string, unknown>[] = [];
  const pdfQueries: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fixture = (path: string): Response => {
    const { status, body } = loadFixture(path);
    return json(body, status);
  };
  const answer = (method: string, url: URL, body: unknown): Response => {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(`${method} ${path}`);
    switch (`${method} ${path}`) {
      case "GET /Tools/bookkeepingSystemVersion":
        return fixture("meta/bookkeeping-system-version.json");
      case "GET /SevClient":
        return fixture("drafts/sev-client.json");
      case "GET /ReceiptGuidance/forAllAccounts":
        return fixture("recorded/2026-11-07/meta/receipt-guidance-all.json");
      case "GET /AccountDatev":
        return fixture("recorded/2026-11-07/meta/account-datev.json");
      case "GET /Contact/1001":
        return fixture("contacts/contact-1001.json");
      case "GET /Voucher":
        return json({ objects: [] });
      case "POST /Voucher/Factory/uploadTempFile": {
        const file = body instanceof FormData ? body.get("file") : null;
        if (file instanceof File) files.push(file);
        return fixture("vouchers/upload-temp-file.json");
      }
      case "POST /Voucher/Factory/saveVoucher": {
        saves.push(JSON.parse(String(body)) as Record<string, unknown>);
        const saved = loadFixture("vouchers/save-voucher-response.json");
        const copy = structuredClone(saved.body) as {
          objects: { voucher: Record<string, unknown> };
        };
        copy.objects.voucher["id"] = "2101";
        return json(copy, saved.status);
      }
      case "GET /Voucher/2101":
        return json({ objects: [draftRow({ document: { id: "9001", objectName: "Document" } })] });
      case "GET /VoucherPos":
        return json({ objects: [positionRow()], total: 1 });
      case "GET /Invoice/1001/getPdf":
        pdfQueries.push(url.search);
        return fixture("documents/invoice-pdf.json");
      default:
        return json({ error: { message: "Not found" } }, 404);
    }
  };
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    tokens.add(new Headers(init?.headers).get("authorization") ?? "");
    return Promise.resolve(answer(init?.method ?? "GET", url, init?.body));
  };
  return { fetch: fetchImpl, calls, tokens, files, saves, pdfQueries };
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

/** A state directory and server secret that survive a restart of the server. */
interface Workspace {
  readonly dir: string;
  readonly secret: string;
}

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "sdmcp-http-files-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { dir, secret: randomBytes(32).toString("base64url") };
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Setup {
  readonly running: RunningHttp;
  readonly fetch: Fetch;
  readonly sevdesk: FakeSevdesk;
  readonly identity: FakeIdentity;
  /** The server's log lines (JSON). */
  readonly lines: string[];
  /** `<stateDir>/files`, where the encrypted blobs live. */
  readonly filesDir: string;
  readonly auditPath: string;
}

/**
 * Starts the HTTP mode in OAuth mode on `space` (account {@link ACCOUNT}, tiers read and write,
 * `SEVDESK_CONFIRM` left at its default `elicit`, so there is no approval inbox), with `env` on top.
 */
async function start(space: Workspace, env: Record<string, string> = {}): Promise<Setup> {
  const lines: string[] = [];
  const sevdesk = fakeSevdesk();
  const identity = fakeIdentity();
  const stateDir = join(space.dir, "state");
  const auditPath = join(space.dir, "audit.jsonl");
  const running = await startHttpMode({
    env: {
      SEVDESK_HTTP_AUTH: "oauth",
      SEVDESK_HTTP_PUBLIC_URL: ORIGIN,
      SEVDESK_HTTP_HOST: "127.0.0.1",
      SEVDESK_HTTP_PORT: "0",
      SEVDESK_HTTP_SECRET: space.secret,
      SEVDESK_HTTP_STATE_DIR: stateDir,
      SEVDESK_OAUTH_ACCOUNTS: ACCOUNT,
      SEVDESK_ALLOW: "read,write",
      SEVDESK_AUDIT_LOG: auditPath,
      ...env,
    },
    log: createHttpLog({ write: (line) => lines.push(line) }),
    identity: identity.lookup,
    sevdeskFetch: sevdesk.fetch,
    cimd: fakeCimd(),
  });
  cleanup.push(() => running.close());
  return {
    running,
    fetch: (input, init) => running.server.router.fetch(new Request(input, init), "203.0.113.7"),
    sevdesk,
    identity,
    lines,
    filesDir: join(stateDir, "files"),
    auditPath,
  };
}

async function mcpClient(setup: Setup, bearer: string): Promise<Client> {
  const client = new Client({ name: "files-e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      fetch: setup.fetch,
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

/** A claude.ai connection: the MCP client, the browser that consented and the access token. */
interface Connection {
  readonly client: Client;
  readonly jar: CookieJar;
  readonly access: string;
}

/** Consents in the browser with `token` (tiers read and write) and connects claude.ai's client. */
async function connect(setup: Setup, token = SEVDESK_TOKEN): Promise<Connection> {
  const { verifier, challenge } = await pkcePair();
  const { redirect, jar } = await completeConsent(
    setup.fetch,
    authorizeUrl({ code_challenge: challenge }),
    { token, tiers: ["write"] },
  );
  const response = await postForm(setup.fetch, "/token", {
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code") ?? "",
    redirect_uri: CLAUDE_AI_REDIRECT,
    code_verifier: verifier,
    client_id: CLAUDE_AI_CLIENT,
    resource: RESOURCE,
  });
  const body = (await response.json()) as { access_token?: string };
  if (response.status !== 200 || body.access_token === undefined) {
    throw new Error(`code exchange failed (${String(response.status)})`);
  }
  return { client: await mcpClient(setup, body.access_token), jar, access: body.access_token };
}

function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return client.callTool({ name, arguments: args });
}

/** What `sevdesk_upload_request` returns. */
interface UploadRequest {
  readonly uploadId: string;
  readonly url: string;
  readonly reference: string;
  readonly expiresAt: string;
  readonly accepts: string[];
  readonly maxBytes: number;
}

async function requestUpload(client: Client): Promise<UploadRequest & { readonly id: string }> {
  const result = await call(client, "sevdesk_upload_request", { purpose: "receipt" });
  expect(result.isError).toBeFalsy();
  const data = resultData(result) as unknown as UploadRequest;
  return { ...data, id: data.uploadId.slice("upload:".length) };
}

/** What `sevdesk_document_save` returns as `download`. */
interface DownloadLink {
  readonly url: string;
  readonly reference: string;
  readonly expiresAt: string;
}

async function saveInvoicePdf(client: Client): Promise<DownloadLink & { readonly id: string }> {
  const result = await call(client, "sevdesk_document_save", { document: "invoice_pdf", id: 1001 });
  expect(result.isError).toBeFalsy();
  const data = resultData(result);
  expect(data).not.toHaveProperty("savedTo");
  const download = data["download"] as DownloadLink;
  return { ...download, id: download.url.split("/").pop() ?? "" };
}

interface Page {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/** A browser GET with the jar's cookies (none without a jar). */
async function open(setup: Setup, url: string, jar?: CookieJar): Promise<Page> {
  const cookie = jar?.header() ?? "";
  const response = await setup.fetch(url, cookie === "" ? {} : { headers: { Cookie: cookie } });
  jar?.store(response);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** The multipart body a browser sends for the upload form (`csrf`, then `file`). */
async function uploadForm(
  csrf: string,
  file: { readonly name: string; readonly bytes: Uint8Array; readonly type: string },
): Promise<{ readonly body: Uint8Array; readonly type: string }> {
  const form = new FormData();
  form.append("csrf", csrf);
  form.append("file", new File([file.bytes], file.name, { type: file.type }));
  const encoded = new Request("http://encoder.invalid/", { method: "POST", body: form });
  return {
    body: new Uint8Array(await encoded.arrayBuffer()),
    type: encoded.headers.get("content-type") ?? "",
  };
}

/** Opens the upload page and submits `file` with the page's CSRF tag, as the browser's form does. */
async function uploadInBrowser(
  setup: Setup,
  url: string,
  jar: CookieJar,
  file: { readonly name: string; readonly bytes: Uint8Array; readonly type: string },
): Promise<Page> {
  const page = await open(setup, url, jar);
  expect(page.status).toBe(200);
  const { body, type } = await uploadForm(csrfOf(page.body) ?? "", file);
  const response = await setup.fetch(url, {
    method: "POST",
    headers: {
      Cookie: jar.header(),
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
    },
    body,
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** Submits the sign-in form (with `next`) and keeps the cookie in `jar`. */
async function signIn(
  setup: Setup,
  jar: CookieJar,
  token: string,
  next?: string,
): Promise<Response> {
  const response = await setup.fetch(`${ORIGIN}/approvals/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, ...(next === undefined ? {} : { next }) }),
  });
  jar.store(response);
  return response;
}

async function receipt(): Promise<{ name: string; bytes: Uint8Array; type: string }> {
  return {
    name: RAW_NAME,
    bytes: new Uint8Array(await readFile(RECEIPT_PDF)),
    type: "application/pdf",
  };
}

/** Page HTML without its per-response CSP nonce, to compare two answers. */
function withoutNonce(html: string): string {
  return html.replace(/nonce="[^"]+"/g, 'nonce=""').replace(/'nonce-[^']+'/g, "'nonce-'");
}

/** Expects none of `secrets` in `text` (the failure names the index, never the value). */
function expectNone(text: string, secrets: readonly string[]): void {
  secrets.forEach((secret, index) => {
    expect(secret.length, `secret ${String(index)} is empty`).toBeGreaterThan(0);
    expect(text.includes(secret), `secret ${String(index)} leaked`).toBe(false);
  });
}

function events(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("remote file transfer end to end (OAuth)", () => {
  it.each([1, 12])("wires the configured limit %i into the running store", async (limit) => {
    const setup = await start(await workspace(), {
      SEVDESK_HTTP_FILES_MAX_PER_ACCOUNT: String(limit),
      // The fake API is local; filling slots should not spend seconds in production pacing.
      SEVDESK_RATE_LIMIT: "50",
    });
    const { client } = await connect(setup);
    const links: Awaited<ReturnType<typeof saveInvoicePdf>>[] = [];
    for (let index = 0; index < limit; index += 1) links.push(await saveInvoicePdf(client));
    const refused = await call(client, "sevdesk_upload_request", { purpose: "receipt" });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toContain(`already has ${String(limit)} uploads`);
    expect(resultText(refused)).toContain(links[0]?.expiresAt);
  });

  it("uploads a receipt for a voucher draft and hands out an invoice PDF as a download link", async () => {
    const setup = await start(await workspace());
    const { client, jar, access } = await connect(setup);

    // Consent signed the browser in although there is no approval inbox (SEVDESK_CONFIRM=elicit).
    const session = jar.get(SESSION_COOKIE) ?? "";
    expect(session).not.toBe("");
    expect((await open(setup, `${ORIGIN}/approvals`, jar)).status).toBe(404);

    // 1. The model asks for an upload page.
    const upload = await requestUpload(client);
    expect(upload.uploadId).toMatch(/^upload:[A-Za-z0-9_-]{43}$/);
    expect(upload.url).toBe(`${ORIGIN}/uploads/${upload.id}`);
    expect(upload.reference).toMatch(/^[A-Z2-9]{6}$/);
    expect(upload.accepts).toEqual(["pdf", "png", "jpeg"]);
    expect(upload.maxBytes).toBe(20 * 1024 * 1024);
    const callsBefore = setup.sevdesk.calls.length;

    // 2. The browser that consented opens the page: trusted text only, and the form.
    const page = await open(setup, upload.url, jar);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Upload a receipt");
    expect(page.body).toContain(upload.reference);
    expect(page.body).toContain(`<strong>${ACCOUNT}</strong>`);
    expect(page.body).toContain('enctype="multipart/form-data"');

    // 3. It uploads the receipt; the receipt page shows the cleaned name.
    const file = await receipt();
    const uploaded = await uploadInBrowser(setup, upload.url, jar, file);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toContain("File received");
    expect(uploaded.body).toContain(CLEAN_NAME);
    expect(uploaded.body).not.toContain("März");
    expect(setup.sevdesk.calls).toHaveLength(callsBefore);

    // 4. The draft with file: uploadId sends the bytes and the cleaned name to sevDesk.
    const draft = await call(client, "sevdesk_voucher_create_draft", {
      ...DRAFT,
      file: upload.uploadId,
    });
    expect(draft.isError, resultText(draft)).toBeFalsy();
    expect(resultData(draft)).toMatchObject({
      status: "done",
      result: { receipt: { name: CLEAN_NAME, kind: "pdf" } },
    });
    expect(setup.sevdesk.files).toHaveLength(1);
    const sent = setup.sevdesk.files[0];
    expect(sent?.name).toBe(CLEAN_NAME);
    expect(sent?.type).toBe("application/pdf");
    expect(new Uint8Array((await sent?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(file.bytes);
    expect(setup.sevdesk.saves[0]?.["filename"]).toBe(TEMP_FILENAME);
    expect(JSON.stringify(draft)).not.toContain(upload.id);
    await vi.waitFor(async () => {
      expect(await readdir(setup.filesDir)).toEqual([]);
    });
    expect((await open(setup, upload.url, jar)).status).toBe(404);

    // 5. The invoice PDF becomes a download link (fetched now, as a preview: preventSendBy).
    const link = await saveInvoicePdf(client);
    expect(link.url).toBe(`${ORIGIN}/files/${link.id}`);
    expect(link.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setup.sevdesk.pdfQueries).toHaveLength(1);
    expect(setup.sevdesk.pdfQueries[0]).toMatch(/preventSendBy=(true|1)/);

    // 6. The browser downloads it: the bytes, the exact headers, and no sevDesk request.
    const sevdeskCalls = setup.sevdesk.calls.length;
    const identityCalls = setup.identity.calls.length;
    const response = await setup.fetch(link.url, { headers: { Cookie: jar.header() } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(bytes).toEqual(invoicePdf());
    expect(Object.fromEntries(response.headers)).toEqual({
      "accept-ranges": "none",
      "cache-control": "no-store, no-transform",
      "content-disposition": `attachment; filename="RE-1001.pdf"; filename*=UTF-8''RE-1001.pdf`,
      "content-length": String(bytes.byteLength),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "application/pdf",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    expect(setup.sevdesk.calls).toHaveLength(sevdeskCalls);
    expect(setup.identity.calls).toHaveLength(identityCalls);
    expect([...setup.sevdesk.tokens]).toEqual([SEVDESK_TOKEN]);

    // Logs: the events by name, the routes as templates, and no id, name, token or cookie.
    const logged = events(setup.lines);
    expect(logged.map((line) => line["event"])).toEqual(
      expect.arrayContaining(["upload_received", "download_served"]),
    );
    expect(logged.find((line) => line["event"] === "upload_received")).toMatchObject({
      account: ACCOUNT,
      reference: upload.reference,
      kind: "pdf",
      bytes: file.bytes.byteLength,
    });
    const routes = logged.map((line) => line["route"]);
    expect(routes).toEqual(expect.arrayContaining(["/uploads/*", "/files/*"]));
    const secrets = [
      upload.id,
      link.id,
      "Beleg März",
      "Beleg_Maerz",
      "Downloads",
      SEVDESK_TOKEN,
      access,
      session,
      "sdmcp_",
    ];
    expectNone(setup.lines.join("\n"), secrets);

    // The audit log has the file events (account, grant, reference, kind, size, hash) and the
    // draft's arguments with the upload id redacted. File events are written in the background.
    const audit = await vi.waitFor(async () => {
      const text = await readFile(setup.auditPath, "utf8");
      expect(text).toContain('"event":"file_downloaded"');
      return text;
    });
    const auditEvents = events(audit.trim().split("\n"));
    expect(auditEvents.map((line) => line["event"])).toEqual(
      expect.arrayContaining(["file_received", "file_link_created", "file_downloaded", "executed"]),
    );
    expect(auditEvents.find((line) => line["event"] === "file_received")).toMatchObject({
      v: 1,
      account: ACCOUNT,
      reference: upload.reference,
      kind: "pdf",
      bytes: file.bytes.byteLength,
    });
    expect(audit).toContain('"file":"upload:[REDACTED]"');
    expectNone(audit, secrets);
  });

  it("uses one batch page to attach named files through create and update draft tools", async () => {
    const setup = await start(await workspace());
    const { client, jar } = await connect(setup);
    const request = await call(client, "sevdesk_upload_request", { purpose: "receipt", count: 2 });
    expect(request.isError).toBeFalsy();
    const data = resultData(request);
    const url = String(data["url"]);
    const page = await open(setup, url, jar);
    const receiptFile = await receipt();
    const form = new FormData();
    form.append("csrf", csrfOf(page.body) ?? "");
    form.append(
      "file",
      new File([receiptFile.bytes], "Erster Beleg.pdf", { type: "application/pdf" }),
    );
    form.append(
      "file",
      new File([receiptFile.bytes], "Zweiter Beleg.pdf", { type: "application/pdf" }),
    );
    const encoded = new Request("http://encoder.invalid/", { method: "POST", body: form });
    const body = new Uint8Array(await encoded.arrayBuffer());
    const response = await setup.fetch(url, {
      method: "POST",
      headers: {
        Cookie: jar.header(),
        Origin: ORIGIN,
        "Content-Type": encoded.headers.get("content-type") ?? "",
        "Content-Length": String(body.byteLength),
      },
      body,
    });
    expect(response.status).toBe(200);
    const receiptPage = await response.text();
    expect(receiptPage).toContain("Erster_Beleg.pdf");
    expect(receiptPage).toContain("Zweiter_Beleg.pdf");
    const listed = await call(client, "sevdesk_uploads_list", { batchId: data["batchId"] });
    expect(listed.isError).toBeFalsy();
    const files = resultData(listed)["files"];
    if (!Array.isArray(files)) throw new Error("missing files");
    const entries: readonly unknown[] = files;
    for (const [index, value] of entries.entries()) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("uploadId" in value) ||
        typeof value.uploadId !== "string"
      )
        throw new Error("invalid file reference");
      const toolName =
        index === 0 ? "sevdesk_voucher_create_draft" : "sevdesk_voucher_update_draft";
      const args =
        index === 0 ? { ...DRAFT, file: value.uploadId } : { id: 2101, file: value.uploadId };
      const saved = await call(client, toolName, args);
      expect(saved.isError, resultText(saved)).toBeFalsy();
      expect(resultData(saved)["status"]).toBe("done");
    }
    expect(setup.sevdesk.files.map((file) => file.name)).toEqual([
      "Erster_Beleg.pdf",
      "Zweiter_Beleg.pdf",
    ]);
    for (const file of setup.sevdesk.files)
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(receiptFile.bytes);
    await vi.waitFor(async () => {
      expect(await readdir(setup.filesDir)).toEqual([]);
    });
    const gone = await call(client, "sevdesk_uploads_list", { batchId: data["batchId"] });
    expect(gone.isError).toBe(true);
    expectNone(setup.lines.join("\n"), [String(data["batchId"]), "Erster_Beleg", "Zweiter_Beleg"]);
  });

  it("refuses an upload to another account and to another grant of the same account, as if unknown", async () => {
    const setup = await start(await workspace(), {
      SEVDESK_OAUTH_ACCOUNTS: `${ACCOUNT},${OTHER_ACCOUNT}`,
    });
    const owner = await connect(setup);
    const other = await connect(setup, OTHER_TOKEN);
    const sameAccount = await connect(setup);

    const upload = await requestUpload(owner.client);
    expect((await uploadInBrowser(setup, upload.url, owner.jar, await receipt())).status).toBe(200);
    const link = await saveInvoicePdf(owner.client);
    const callsBefore = setup.sevdesk.calls.length;

    // Tools: only the grant that asked can use the upload. The answer for another grant, another
    // account and an unknown id is the same, and names no id.
    const refusals: string[] = [];
    for (const [client, file] of [
      [sameAccount.client, upload.uploadId],
      [other.client, upload.uploadId],
      [owner.client, `upload:${UNKNOWN_ID}`],
    ] as const) {
      const result = await call(client, "sevdesk_voucher_create_draft", { ...DRAFT, file });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(NO_UPLOAD);
      expectNone(JSON.stringify(result), [upload.id, UNKNOWN_ID]);
      refusals.push(resultText(result));
    }
    expect(new Set(refusals).size).toBe(1);
    expect(setup.sevdesk.calls).toHaveLength(callsBefore);
    expect(setup.sevdesk.files).toEqual([]);

    // Pages: another account's browser gets exactly the answer for an unknown id.
    const foreignPage = await open(setup, upload.url, other.jar);
    const unknownPage = await open(setup, `${ORIGIN}/uploads/${UNKNOWN_ID}`, other.jar);
    expect(foreignPage.status).toBe(404);
    expect(withoutNonce(foreignPage.body)).toBe(withoutNonce(unknownPage.body));
    expect(foreignPage.body).not.toContain(upload.reference);
    const foreignFile = await open(setup, link.url, other.jar);
    const unknownFile = await open(setup, `${ORIGIN}/files/${UNKNOWN_ID}`, other.jar);
    expect(foreignFile.status).toBe(404);
    expect(withoutNonce(foreignFile.body)).toBe(withoutNonce(unknownFile.body));
    expect(foreignFile.headers.get("content-disposition")).toBeNull();

    // The pages go by account: a browser signed in to the same account (here through another
    // grant's consent) may download the account's link.
    const sameAccountFile = await setup.fetch(link.url, {
      headers: { Cookie: sameAccount.jar.header() },
    });
    expect(sameAccountFile.status).toBe(200);
    expect(new Uint8Array(await sameAccountFile.arrayBuffer())).toEqual(invoicePdf());
    expect(setup.sevdesk.calls).toHaveLength(callsBefore);

    // The owner's upload was not consumed by the refusals.
    const draft = await call(owner.client, "sevdesk_voucher_create_draft", {
      ...DRAFT,
      file: upload.uploadId,
    });
    expect(draft.isError, resultText(draft)).toBeFalsy();
    expect(setup.sevdesk.files.map((file) => file.name)).toEqual([CLEAN_NAME]);
  });

  it("shows a browser without a session only the sign-in form, and returns to the page after it", async () => {
    const setup = await start(await workspace());
    const { client, jar } = await connect(setup);
    const upload = await requestUpload(client);
    expect((await uploadInBrowser(setup, upload.url, jar, await receipt())).status).toBe(200);
    const link = await saveInvoicePdf(client);

    // A phone app that opens the link without the cookie: the sign-in form, no record data.
    const fresh = new CookieJar();
    const uploadPage = await open(setup, upload.url, fresh);
    expect(uploadPage.status).toBe(200);
    expect(uploadPage.body).toContain('name="token"');
    expect(uploadPage.body).toContain(`name="next" value="/uploads/${upload.id}"`);
    const filePage = await open(setup, link.url, fresh);
    expect(filePage.status).toBe(200);
    expect(filePage.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(filePage.headers.get("content-disposition")).toBeNull();
    expect(filePage.body).toContain(`name="next" value="/files/${link.id}"`);
    for (const body of [uploadPage.body, filePage.body]) {
      for (const data of [upload.reference, link.reference, ACCOUNT, CLEAN_NAME, "RE-1001"]) {
        expect(body).not.toContain(data);
      }
    }

    // Signing in with the account's sevDesk token leads back to the page.
    const signedIn = await signIn(setup, fresh, SEVDESK_TOKEN, `/files/${link.id}`);
    await signedIn.text();
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(link.url);
    const download = await setup.fetch(link.url, { headers: { Cookie: fresh.header() } });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(invoicePdf());
    expect((await open(setup, upload.url, fresh)).body).toContain("File received");

    // An open redirect is not possible: an unknown `next` lands on the "Signed in" page.
    const elsewhere = await signIn(setup, new CookieJar(), SEVDESK_TOKEN, "//attacker.example/x");
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("location")).toBeNull();
    expect(await elsewhere.text()).toContain("Signed in");
  });

  it("forgets every upload and link at a restart, and empties the files folder at startup", async () => {
    const space = await workspace();
    const first = await start(space);
    const { client, jar, access } = await connect(first);
    const upload = await requestUpload(client);
    expect((await uploadInBrowser(first, upload.url, jar, await receipt())).status).toBe(200);
    const link = await saveInvoicePdf(client);

    // Two encrypted blobs (the upload and the link) under random names, never the file's bytes.
    const blobNames = await readdir(first.filesDir);
    expect(blobNames).toHaveLength(2);
    const blobs = await Promise.all(
      blobNames.map(async (name) => [name, await readFile(join(first.filesDir, name))] as const),
    );
    const pdf = Buffer.from(await readFile(RECEIPT_PDF));
    for (const [name, content] of blobs) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{22}\.bin$/);
      expect(content.includes(pdf.subarray(0, 64))).toBe(false);
      expect(content.includes(Buffer.from(invoicePdf()).subarray(0, 32))).toBe(false);
    }

    // A clean shutdown deletes them; put them back, as a crash would have left them.
    await first.running.close();
    expect(await readdir(first.filesDir)).toEqual([]);
    for (const [name, content] of blobs) await writeFile(join(first.filesDir, name), content);

    const second = await start(space);
    expect(await readdir(second.filesDir)).toEqual([]);

    // The grant and the browser session survive (same secret and state directory); the upload
    // and the link do not.
    const again = await mcpClient(second, access);
    const draft = await call(again, "sevdesk_voucher_create_draft", {
      ...DRAFT,
      file: upload.uploadId,
    });
    expect(draft.isError).toBe(true);
    expect(resultText(draft)).toContain(NO_UPLOAD);
    expect(second.sevdesk.calls).toEqual([]);
    expect((await open(second, upload.url, jar)).status).toBe(404);
    expect((await open(second, link.url, jar)).status).toBe(404);
  });
});

describe("remote file transfer end to end (bearer)", () => {
  it("signs the browser in with the server's sevDesk token, then uploads and downloads", async () => {
    const bearer = randomBytes(32).toString("base64url");
    const setup = await start(await workspace(), {
      SEVDESK_HTTP_AUTH: "bearer",
      SEVDESK_HTTP_BEARER_TOKEN: bearer,
      SEVDESK_API_TOKEN: SEVDESK_TOKEN,
      SEVDESK_OAUTH_ACCOUNTS: "",
      SEVDESK_HTTP_SECRET: "",
    });
    const client = await mcpClient(setup, bearer);
    const upload = await requestUpload(client);
    const jar = new CookieJar();

    // The upload page asks to sign in; the bearer secret does not sign in.
    const page = await open(setup, upload.url, jar);
    expect(page.body).toContain(`name="next" value="/uploads/${upload.id}"`);
    const wrong = await signIn(setup, jar, bearer, `/uploads/${upload.id}`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expectNone(await wrong.text(), [bearer]);

    // The server's sevDesk token does, and leads back to the upload page.
    const login = await signIn(setup, jar, SEVDESK_TOKEN, `/uploads/${upload.id}`);
    await login.text();
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(upload.url);
    const session = jar.get(SESSION_COOKIE) ?? "";
    expect(session).not.toBe("");

    // An upload without Content-Length (a chunked body, as some proxies forward it) is refused
    // with 411 before the body is read; the ticket stays open.
    const form = await uploadForm(csrfOf((await open(setup, upload.url, jar)).body) ?? "", {
      name: "Beleg.pdf",
      bytes: new Uint8Array(await readFile(RECEIPT_PDF)),
      type: "application/pdf",
    });
    const chunked = openRequest(setup.running.port, {
      method: "POST",
      path: `/uploads/${upload.id}`,
      headers: {
        Host: new URL(ORIGIN).host,
        Origin: ORIGIN,
        Cookie: jar.header(),
        "Content-Type": form.type,
        "Transfer-Encoding": "chunked",
      },
      body: form.body,
    });
    chunked.request.end();
    expect((await chunked.response).statusCode).toBe(411);
    let refusal = "";
    for (let chunk = await chunked.next(); chunk !== undefined; chunk = await chunked.next()) {
      refusal += chunk;
    }
    expect(refusal).toContain("Size missing");

    // The upload, the draft with it, and a download link.
    const file = await receipt();
    expect((await uploadInBrowser(setup, upload.url, jar, file)).status).toBe(200);
    const draft = await call(client, "sevdesk_voucher_create_draft", {
      ...DRAFT,
      file: upload.uploadId,
    });
    expect(draft.isError, resultText(draft)).toBeFalsy();
    expect(setup.sevdesk.files.map((sent) => sent.name)).toEqual([CLEAN_NAME]);
    const link = await saveInvoicePdf(client);
    const download = await setup.fetch(link.url, { headers: { Cookie: jar.header() } });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(invoicePdf());
    expect([...setup.sevdesk.tokens]).toEqual([SEVDESK_TOKEN]);

    const logged = events(setup.lines);
    expect(logged).toContainEqual(
      expect.objectContaining({ event: "upload_refused", reason: "length_required" }),
    );
    expectNone(setup.lines.join("\n"), [
      upload.id,
      link.id,
      "Beleg März",
      "Beleg_Maerz",
      bearer,
      SEVDESK_TOKEN,
      session,
    ]);
  });
});
