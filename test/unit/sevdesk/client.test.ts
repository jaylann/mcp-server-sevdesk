import { describe, expect, it, vi } from "vitest";

import type { Tier } from "../../../src/safety/tiers.js";
import {
  createSevdeskClient,
  parseRetryAfter,
  type SevdeskClientConfig,
  type SevdeskClientEvent,
  writeBlockReason,
  writesAllowed,
} from "../../../src/sevdesk/client.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  FAKE_EPOCH,
  type FakeReply,
  jsonResponse,
  networkError,
  sevdeskErrorResponse,
} from "../../helpers/fake-fetch.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BASE_URL = "https://my.sevdesk.de/api/v1";

const baseConfig: SevdeskClientConfig = {
  token: TOKEN,
  baseUrl: BASE_URL,
  allowedTiers: new Set<Tier>(["read", "write"]),
  readOnly: false,
  dryRun: false,
  requestsPerSecond: 1000,
  timeoutMs: 1000,
  userAgent: "mcp-server-sevdesk/test",
};

interface SetupOptions {
  readonly config?: Partial<SevdeskClientConfig>;
  readonly random?: number;
  readonly onEvent?: (event: SevdeskClientEvent) => void;
}

function setup(replies: FakeReply[] = [], options: SetupOptions = {}) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const events: SevdeskClientEvent[] = [];
  const client = createSevdeskClient(
    { ...baseConfig, ...options.config },
    {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: clock.now,
      monotonicNow: clock.now,
      random: () => options.random ?? 0.5,
      onEvent: (event) => {
        events.push(event);
        options.onEvent?.(event);
      },
    },
  );
  return { client, fake, clock, events };
}

async function catchError(promise: Promise<unknown>): Promise<SevdeskError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SevdeskError) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("request headers and URL", () => {
  it("sends the raw token, user agent and Accept header on a GET", async () => {
    const { client, fake } = setup([envelope([{ id: "1" }])]);

    await client.request({ method: "GET", path: "/Contact" });

    const [request] = fake.requests;
    expect(request?.url.href).toBe(`${BASE_URL}/Contact`);
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("authorization")).toBe(TOKEN);
    expect(request?.headers.get("user-agent")).toBe("mcp-server-sevdesk/test");
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(request?.headers.has("content-type")).toBe(false);
    expect(request?.redirect).toBe("manual");
    expect(request?.body).toBeUndefined();
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { client, fake } = setup([envelope([])], {
      config: { baseUrl: `${BASE_URL}/` },
    });
    await client.request({ method: "GET", path: "/Contact" });
    expect(fake.requests[0]?.url.href).toBe(`${BASE_URL}/Contact`);
  });

  it("sends JSON bodies with Content-Type and keeps key order", async () => {
    const { client, fake } = setup([envelope({ id: "5" }, undefined)]);
    const body = { voucher: { objectName: "Voucher" }, filename: "abc.pdf", voucherPosSave: [] };

    await client.request({
      method: "POST",
      tier: "write",
      path: "/Voucher/Factory/saveVoucher",
      body,
    });

    const [request] = fake.requests;
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toBe(
      '{"voucher":{"objectName":"Voucher"},"filename":"abc.pdf","voucherPosSave":[]}',
    );
  });

  it("sends multipart forms without forcing a Content-Type", async () => {
    const { client, fake } = setup([envelope({ filename: "tmp.pdf" })]);
    const form = new FormData();
    form.append("file", new Blob(["%PDF"]), "receipt.pdf");

    await client.request({
      method: "POST",
      tier: "write",
      path: "/Voucher/Factory/uploadTempFile",
      form,
    });

    expect(fake.requests[0]?.body).toBe(form);
    expect(fake.requests[0]?.headers.has("content-type")).toBe(false);
  });

  it("serializes query values: skips undefined, booleans as 1/0, encodes bracket keys", async () => {
    const { client, fake } = setup([envelope([])]);

    await client.request({
      method: "GET",
      path: "/Invoice",
      query: {
        "contact[id]": 42,
        "contact[objectName]": "Contact",
        embed: undefined,
        depth: true,
        isBooked: false,
        status: 0,
        name: "Müller & Söhne",
      },
    });

    const url = fake.requests[0]?.url;
    expect(url?.search).toContain("contact%5Bid%5D=42");
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([
      "contact[id]",
      "contact[objectName]",
      "depth",
      "isBooked",
      "status",
      "name",
    ]);
    expect(url?.searchParams.get("depth")).toBe("1");
    expect(url?.searchParams.get("isBooked")).toBe("0");
    expect(url?.searchParams.get("status")).toBe("0");
    expect(url?.searchParams.get("name")).toBe("Müller & Söhne");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the query value %s locally",
    async (value) => {
      const { client, fake } = setup();
      const error = await catchError(
        client.request({ method: "GET", path: "/Invoice", query: { status: value } }),
      );
      expect(error.kind).toBe("validation");
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("rejects an empty query parameter name", async () => {
    const { client, fake } = setup();
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", query: { "": "x" } }),
    );
    expect(error.kind).toBe("validation");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects a body together with a form, a GET with a body, and unserializable bodies", async () => {
    const { client, fake } = setup();
    const form = new FormData();

    const both = await catchError(
      client.request({ method: "POST", tier: "write", path: "/Contact", body: {}, form }),
    );
    const getWithBody = await catchError(
      client.request({ method: "GET", path: "/Contact", body: { a: 1 } }),
    );
    const bigint = await catchError(
      client.request({ method: "POST", tier: "write", path: "/Contact", body: { id: 1n } }),
    );

    expect([both.kind, getWithBody.kind, bigint.kind]).toEqual([
      "validation",
      "validation",
      "validation",
    ]);
    expect(fake.requests).toHaveLength(0);
  });

  it("validates the path before sending", async () => {
    const { client, fake } = setup();
    const error = await catchError(client.request({ method: "GET", path: "/Invoice/../SevUser" }));
    expect(error.kind).toBe("validation");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("envelope handling", () => {
  it("unwraps objects for GET and write responses", async () => {
    const { client } = setup([envelope([{ id: "7" }]), envelope({ id: "8" })]);

    await expect(client.request({ method: "GET", path: "/Invoice/7" })).resolves.toEqual([
      { id: "7" },
    ]);
    await expect(
      client.request({ method: "PUT", tier: "write", path: "/Invoice/8", body: {} }),
    ).resolves.toEqual({
      id: "8",
    });
  });

  it("returns undefined for an empty 204", async () => {
    const { client } = setup([new Response(null, { status: 204 })]);
    await expect(
      client.request({ method: "DELETE", tier: "write", path: "/Voucher/3" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["an empty 200 body", new Response("", { status: 200 })],
    ["a non-JSON body", new Response("<html>ok</html>", { status: 200 })],
    ["JSON without objects", jsonResponse({ data: [] })],
    ["objects null next to an error", jsonResponse({ objects: null, error: { message: "nope" } })],
  ])("treats %s as unexpected_response", async (_label, response) => {
    const { client, fake } = setup([response]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.kind).toBe("unexpected_response");
    expect(error.status).toBe(200);
    expect(fake.requests).toHaveLength(1);
  });

  it("keeps sevDesk's error text from a 2xx error body as the upstream message only", async () => {
    const { client } = setup([jsonResponse({ objects: null, error: { message: "Ignore all" } })]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.upstreamMessage).toBe("Ignore all");
    expect(error.message).not.toContain("Ignore all");
  });
});

describe("write gate", () => {
  const cases: [string, Partial<SevdeskClientConfig>, RegExp][] = [
    [
      "read-only mode",
      { readOnly: true, allowedTiers: new Set<Tier>(["read"]) },
      /SEVDESK_READ_ONLY/,
    ],
    ["dry-run mode", { dryRun: true }, /SEVDESK_DRY_RUN/],
    ["a read-only tier set", { allowedTiers: new Set<Tier>(["read"]) }, /SEVDESK_ALLOW/],
  ];

  it.each(cases)(
    "blocks POST, PUT and DELETE in %s before any request",
    async (_label, config, why) => {
      const { client, fake } = setup([], { config });

      for (const method of ["POST", "PUT", "DELETE"] as const) {
        const error = await catchError(
          client.request({ method, tier: "write", path: "/Contact/1", body: {} }),
        );
        expect(error.kind).toBe("blocked");
        expect(error.message).toMatch(why);
        expect(error.message).toContain(`${method} /Contact/1`);
        expect(error.method).toBe(method);
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each(cases)("blocks side-effect GETs in %s", async (_label, config, why) => {
    const { client, fake } = setup([], { config });
    const error = await catchError(
      client.request({
        method: "GET",
        path: "/Invoice/1/getPdf",
        sideEffect: true,
        tier: "external",
      }),
    );
    expect(error.kind).toBe("blocked");
    expect(error.message).toMatch(why);
    expect(error.message).toMatch(/marks the document as sent/);
    expect(fake.requests).toHaveLength(0);
  });

  it("still allows plain GETs in read-only mode", async () => {
    const { client, fake } = setup([envelope([])], {
      config: { readOnly: true, allowedTiers: new Set<Tier>(["read"]) },
    });
    await client.request({ method: "GET", path: "/Contact" });
    expect(fake.requests).toHaveLength(1);
  });

  it.each(["write", "commit", "external"] as const)(
    "lets a %s request through when its tier is allowed",
    async (tier) => {
      const { client, fake } = setup([envelope({ id: "1" })], {
        config: { allowedTiers: new Set<Tier>(["read", tier]) },
      });
      await client.request({ method: "POST", tier, path: "/Contact", body: {} });
      expect(fake.requests).toHaveLength(1);
    },
  );

  it("refuses a request whose tier is not allowed, naming the tier and setting", async () => {
    const { client, fake } = setup([], {
      config: { allowedTiers: new Set<Tier>(["read", "write"]) },
    });
    const error = await catchError(
      client.request({ method: "PUT", tier: "commit", path: "/Invoice/1/enshrine" }),
    );
    expect(error.kind).toBe("blocked");
    expect(error.message).toContain("commit tier");
    expect(error.message).toContain("SEVDESK_ALLOW=commit");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a request that changes data without a declared tier", async () => {
    const { client, fake } = setup([], {
      config: { allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]) },
    });
    const post = await catchError(client.request({ method: "POST", path: "/Contact", body: {} }));
    const sending = await catchError(
      client.request({ method: "GET", path: "/CreditNote/3/sendByWithRender" }),
    );
    const smuggled = await catchError(
      client.request({
        method: "DELETE",
        path: "/Voucher/1",
        tier: "read" as unknown as "write",
      }),
    );
    for (const error of [post, sending, smuggled]) {
      expect(error.kind).toBe("blocked");
      expect(error.message).toMatch(/internal error: a request that changes data did not declare/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("ignores the tier on plain reads", async () => {
    const { client, fake } = setup([envelope([])], {
      config: { readOnly: true, allowedTiers: new Set<Tier>(["read"]) },
    });
    await client.request({ method: "GET", path: "/Contact", tier: "commit" });
    expect(fake.requests).toHaveLength(1);
  });

  it("exposes the gate for the dispatcher", () => {
    const read = new Set<Tier>(["read"]);
    const write = new Set<Tier>(["read", "write"]);
    const open = { readOnly: false, dryRun: false };
    expect(writesAllowed({ allowedTiers: write, ...open }, "write")).toBe(true);
    expect(writesAllowed({ allowedTiers: write, ...open }, "commit")).toBe(false);
    expect(writesAllowed({ allowedTiers: write, ...open }, undefined)).toBe(false);
    expect(writesAllowed({ allowedTiers: read, ...open }, "write")).toBe(false);
    expect(
      writeBlockReason({ allowedTiers: write, readOnly: true, dryRun: true }, "write"),
    ).toMatch(/SEVDESK_READ_ONLY/);
    expect(
      writeBlockReason({ allowedTiers: write, readOnly: false, dryRun: true }, "write"),
    ).toMatch(/SEVDESK_DRY_RUN/);
    expect(writeBlockReason({ allowedTiers: read, ...open }, "external")).toMatch(
      /external tier.*SEVDESK_ALLOW=external/,
    );
  });
});

describe("endpoint minimum tier", () => {
  const all = { allowedTiers: new Set<Tier>(["read", "write", "commit", "external"]) };

  it.each([
    ["PUT", "/Invoice/1/sendBy", "write"],
    ["PUT", "/Invoice/1/bookAmount", "write"],
    ["PUT", "/Invoice/1/enshrine", "write"],
    ["POST", "/Invoice/1/cancelInvoice", "write"],
    ["PUT", "/Invoice/1/resetToDraft", "write"],
    ["POST", "/Invoice/1/sendViaEmail", "write"],
    ["POST", "/Invoice/1/sendViaEmail", "commit"],
  ] as const)(
    "refuses %s %s from a %s tool before sending, even with every tier enabled",
    async (method, path, tier) => {
      const { client, fake } = setup([], { config: all });

      const failure = await catchError(client.request({ method, tier, path, body: {} }));

      expect(failure.kind).toBe("blocked");
      expect(failure.message).toMatch(
        new RegExp(
          `needs at least the (commit|external) tier, but the calling tool has the ${tier} tier`,
        ),
      );
      expect(failure.message).toContain("Nothing was sent.");
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("refuses a side-effect getPdf (marks as sent) from a write tool", async () => {
    const { client, fake } = setup([], { config: all });

    const failure = await catchError(
      client.request({ method: "GET", path: "/Invoice/1/getPdf", sideEffect: true, tier: "write" }),
    );

    expect(failure.message).toContain("needs at least the commit tier");
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["PUT", "/Invoice/1/sendBy", "commit"],
    ["PUT", "/Invoice/1/sendBy", "external"],
    ["POST", "/Invoice/1/sendViaEmail", "external"],
    ["POST", "/Invoice/Factory/saveInvoice", "write"],
  ] as const)("lets %s %s through from a %s tool", async (method, path, tier) => {
    const { client, fake } = setup([envelope({ id: "1" })], { config: all });

    await client.request({ method, tier, path, body: {} });

    expect(fake.requests).toHaveLength(1);
  });

  it("checks the endpoint tier before the configured tiers", () => {
    const write = new Set<Tier>(["read", "write"]);
    expect(
      writeBlockReason({ allowedTiers: write, readOnly: false, dryRun: false }, "write", "commit"),
    ).toMatch(/^internal error: this endpoint needs at least the commit tier/);
    expect(
      writeBlockReason({ allowedTiers: write, readOnly: false, dryRun: false }, "commit", "commit"),
    ).toMatch(/SEVDESK_ALLOW=commit/);
  });
});

describe("state-changing GET endpoints", () => {
  const readOnly = { readOnly: true, allowedTiers: new Set<Tier>(["read"]) };

  it.each([
    "/Invoice/12/getPdf",
    "/Order/12/getPdf",
    "/CreditNote/12/getPdf",
    "/Invoice/12/GETPDF",
  ])("sends %s as a read with preventSendBy=true when no side effect is declared", async (path) => {
    const { client, fake } = setup([envelope({ content: "JVBERi0=" })], { config: readOnly });
    await client.request({ method: "GET", path, query: { download: false } });
    const params = fake.requests[0]?.url.searchParams;
    // The literal the community measurements verified (D-023); `1` is unconfirmed.
    expect(params?.get("preventSendBy")).toBe("true");
    expect(params?.get("download")).toBe("0");
  });

  it.each([true, 1, "1", "true"])(
    "keeps an explicit preventSendBy %j as a read and sends it as the literal true",
    async (value) => {
      const { client, fake } = setup([envelope({})], { config: readOnly });
      await client.request({
        method: "GET",
        path: "/Invoice/12/getPdf",
        query: { preventSendBy: value },
      });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.url.searchParams.getAll("preventSendBy")).toEqual(["true"]);
    },
  );

  it.each([false, 0, "0", "false", "no"])(
    "treats getPdf with preventSendBy %j as a side effect",
    async (value) => {
      const { client, fake } = setup([], { config: readOnly });
      const error = await catchError(
        client.request({
          method: "GET",
          path: "/Invoice/12/getPdf",
          query: { preventSendBy: value },
        }),
      );
      expect(error.kind).toBe("blocked");
      expect(fake.requests).toHaveLength(0);
    },
  );

  it("does not add preventSendBy when the side effect is declared", async () => {
    const { client, fake } = setup([envelope({})], {
      config: { allowedTiers: new Set<Tier>(["read", "external"]) },
    });
    await client.request({
      method: "GET",
      path: "/Invoice/12/getPdf",
      sideEffect: true,
      tier: "external",
    });
    expect(fake.requests[0]?.url.searchParams.has("preventSendBy")).toBe(false);
  });

  it.each([
    ["/Export/createDatevCsvZipExportJob", { enshrineDocuments: true }],
    ["/Export/datevCSV", { enshrine: 1 }],
    ["/Export/datevCSV", { Enshrine: "yes" }],
  ])("treats %s with %j as a side effect", async (path, query) => {
    const { client, fake } = setup([], { config: readOnly });
    const error = await catchError(client.request({ method: "GET", path, query }));
    expect(error.kind).toBe("blocked");
    expect(error.message).toMatch(/enshrines/);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([{ enshrineDocuments: false }, { enshrine: 0 }, { includeEnshrined: true }, {}])(
    "keeps a DATEV export with %j as a read",
    async (query) => {
      const { client, fake } = setup([envelope({ id: "9" })], { config: readOnly });
      await client.request({ method: "GET", path: "/Export/createDatevCsvZipExportJob", query });
      expect(fake.requests).toHaveLength(1);
    },
  );
});

describe("error classification", () => {
  it.each([
    [401, "Authentication required", "auth"],
    [403, "Forbidden", "auth"],
    [404, "Not Found", "not_found"],
    [400, "Model_Contact with id 99 not found", "not_found"],
    [400, "Wrong parameter", "validation"],
    [422, "invoiceDate must be given", "validation"],
    [500, "Argument #1 ($date) must be of type string", "validation"],
    [500, "TypeError: Cannot read property", "validation"],
    [500, "voucherDate must be given", "validation"],
  ] as const)("maps %i %j to %s without retrying", async (status, message, kind) => {
    const { client, fake } = setup([sevdeskErrorResponse(status, message)]);

    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.upstreamMessage).toBe(message);
    expect(error.exceptionUuid).toBe("4f1c2d3e-0000-4000-8000-000000000001");
    expect(error.message).not.toContain(message);
    expect(error.method).toBe("GET");
    expect(error.path).toBe("/Invoice");
    expect(fake.requests).toHaveLength(1);
  });

  it("uses a trusted template message", async () => {
    const { client } = setup([sevdeskErrorResponse(422, "x")]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.message).toBe("sevDesk rejected the request: validation error (HTTP 422).");
  });

  it("redacts the token from upstream text and truncates it", async () => {
    const echo = `bad token ${TOKEN} ${"x".repeat(1000)}`;
    const { client } = setup([sevdeskErrorResponse(401, echo)]);

    const error = await catchError(client.request({ method: "GET", path: "/Contact" }));

    expect(error.upstreamMessage).not.toContain(TOKEN);
    expect(error.upstreamMessage).toContain("[REDACTED]");
    expect(error.upstreamMessage?.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("handles non-JSON error bodies", async () => {
    const { client } = setup([new Response("Bad Gateway", { status: 502 })], {
      config: { allowedTiers: new Set<Tier>(["read", "write"]) },
    });
    const error = await catchError(
      client.request({ method: "POST", tier: "write", path: "/Contact", body: {} }),
    );
    expect(error.kind).toBe("server");
    expect(error.upstreamMessage).toBe("Bad Gateway");
  });

  it("does not follow redirects", async () => {
    const { client, fake } = setup([
      new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    ]);
    const error = await catchError(client.request({ method: "GET", path: "/Contact" }));
    expect(error.kind).toBe("unexpected_response");
    expect(error.message).toMatch(/redirect/);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("retries", () => {
  it("retries a GET on 5xx with exponential full-jitter backoff", async () => {
    const { client, fake, clock } = setup([
      sevdeskErrorResponse(500, "Internal error"),
      sevdeskErrorResponse(503, "Unavailable"),
      envelope([{ id: "1" }]),
    ]);

    await expect(client.request({ method: "GET", path: "/Invoice" })).resolves.toEqual([
      { id: "1" },
    ]);

    expect(fake.requests).toHaveLength(3);
    // random() = 0.5: 0.5 × 500 ms, then 0.5 × 1000 ms.
    expect(clock.sleeps).toEqual([250, 500]);
  });

  it("gives up after three attempts", async () => {
    const { client, fake, clock } = setup([
      sevdeskErrorResponse(500, "a"),
      sevdeskErrorResponse(500, "b"),
      sevdeskErrorResponse(500, "c"),
    ]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.kind).toBe("server");
    expect(error.upstreamMessage).toBe("c");
    expect(fake.requests).toHaveLength(3);
    expect(clock.sleeps).toHaveLength(2);
  });

  it("uses the full jitter range", async () => {
    const low = setup([sevdeskErrorResponse(500, "a"), envelope([])], { random: 0 });
    await low.client.request({ method: "GET", path: "/Invoice" });
    // A zero backoff leaves only the pacer's 1 ms spacing (1000 requests/s).
    expect(low.clock.sleeps).toEqual([0, 1]);

    const high = setup([sevdeskErrorResponse(500, "a"), envelope([])], { random: 0.999 });
    await high.client.request({ method: "GET", path: "/Invoice" });
    expect(high.clock.sleeps).toEqual([500]);
  });

  it("retries network errors on GET", async () => {
    const { client, fake } = setup([{ throws: networkError() }, envelope([])]);
    await client.request({ method: "GET", path: "/Invoice" });
    expect(fake.requests).toHaveLength(2);
  });

  it("classifies a persistent network failure", async () => {
    const { client } = setup([
      { throws: networkError("ENOTFOUND") },
      { throws: networkError("ENOTFOUND") },
      { throws: networkError("ENOTFOUND") },
    ]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.kind).toBe("network");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it.each([
    ["2", 2000],
    ["0", 250],
    ["120", 30_000],
    [new Date(FAKE_EPOCH + 5000).toUTCString(), 5000],
  ])("honors Retry-After %j as %i ms", async (retryAfter, expected) => {
    const { client, clock } = setup([
      sevdeskErrorResponse(429, "Too many requests", { "Retry-After": retryAfter }),
      envelope([]),
    ]);
    await client.request({ method: "GET", path: "/Invoice" });
    expect(clock.sleeps).toEqual([expected]);
  });

  it("falls back to jitter for an unparsable Retry-After", async () => {
    const { client, clock } = setup([
      sevdeskErrorResponse(429, "Too many requests", { "Retry-After": "soon" }),
      envelope([]),
    ]);
    await client.request({ method: "GET", path: "/Invoice" });
    expect(clock.sleeps).toEqual([250]);
  });

  it("parses Retry-After values", () => {
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("1.5", 0)).toBe(1500);
    expect(parseRetryAfter("garbage", 0)).toBeUndefined();
    expect(parseRetryAfter(new Date(1000).toUTCString(), 60_000)).toBe(250);
  });

  it("emits diagnostics without headers, bodies or the token", async () => {
    const { client, events } = setup([sevdeskErrorResponse(500, "x"), envelope([])]);
    await client.request({ method: "GET", path: "/Invoice", query: { name: "secret customer" } });

    expect(events.map((event) => event.type)).toEqual([
      "request",
      "failure",
      "retry",
      "request",
      "response",
    ]);
    expect(events[1]).toMatchObject({ kind: "server", status: 500, attempt: 1, path: "/Invoice" });
    expect(events[2]).toMatchObject({ kind: "server", delayMs: 250, attempt: 1 });
    expect(events[4]).toMatchObject({ status: 200, attempt: 2 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("secret customer");
  });

  it("ignores a throwing diagnostics hook", async () => {
    const { client } = setup([envelope([])], {
      onEvent: () => {
        throw new Error("logger broke");
      },
    });
    await expect(client.request({ method: "GET", path: "/Invoice" })).resolves.toEqual([]);
  });
});

describe("timeouts and cancellation", () => {
  it("times out a hanging request and retries GETs", async () => {
    const { client, fake } = setup(["hang", "hang", "hang"], { config: { timeoutMs: 20 } });
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("20 ms");
    expect(fake.requests).toHaveLength(3);
  });

  it("recovers when a retry after a timeout succeeds", async () => {
    const { client, fake } = setup(["hang", envelope([{ id: "1" }])], {
      config: { timeoutMs: 20 },
    });
    await expect(client.request({ method: "GET", path: "/Invoice" })).resolves.toEqual([
      { id: "1" },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it("reports a request cancelled in flight as aborted and does not retry it", async () => {
    const controller = new AbortController();
    const { client, fake } = setup(["hang"], {
      onEvent: (event) => {
        if (event.type === "request") controller.abort();
      },
    });
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: controller.signal }),
    );
    expect(error.kind).toBe("aborted");
    expect(error.message).toBe("The request to sevDesk was cancelled.");
    expect(fake.requests).toHaveLength(1);
  });

  it("reports the caller's own deadline as timeout and does not retry", async () => {
    const controller = new AbortController();
    const { client, fake, events } = setup(["hang", envelope([])], {
      onEvent: (event) => {
        if (event.type === "request") {
          controller.abort(new DOMException("deadline", "TimeoutError"));
        }
      },
    });
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: controller.signal }),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("sevDesk did not answer before the caller's deadline.");
    expect(fake.requests).toHaveLength(1);
    expect(events.some((event) => event.type === "retry")).toBe(false);
  });

  it("reports an expired AbortSignal.timeout from the caller as timeout", async () => {
    const { client, fake } = setup(["hang"]);
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: AbortSignal.timeout(10) }),
    );
    expect(error.kind).toBe("timeout");
    expect(fake.requests).toHaveLength(1);
  });

  it("reports a deadline that passed before sending, or during backoff, as timeout", async () => {
    const expired = AbortSignal.abort(new DOMException("deadline", "TimeoutError"));
    const before = setup();
    const early = await catchError(
      before.client.request({ method: "GET", path: "/Invoice", signal: expired }),
    );
    expect(early.kind).toBe("timeout");
    expect(before.fake.requests).toHaveLength(0);

    const controller = new AbortController();
    const during = setup([sevdeskErrorResponse(500, "x"), envelope([])], {
      onEvent: (event) => {
        if (event.type === "retry") controller.abort(new DOMException("deadline", "TimeoutError"));
      },
    });
    const late = await catchError(
      during.client.request({ method: "GET", path: "/Invoice", signal: controller.signal }),
    );
    expect(late.kind).toBe("timeout");
    expect(during.fake.requests).toHaveLength(1);
  });

  it("classifies an error thrown after cancellation as aborted", async () => {
    const controller = new AbortController();
    const { client, fake } = setup([
      () => {
        controller.abort();
        throw networkError();
      },
    ]);
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: controller.signal }),
    );
    expect(error.kind).toBe("aborted");
    expect(fake.requests).toHaveLength(1);
  });

  it("classifies an AbortError without a caller signal as aborted", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const { client, fake } = setup([{ throws: abortError }]);
    const error = await catchError(client.request({ method: "GET", path: "/Invoice" }));
    expect(error.kind).toBe("aborted");
    expect(fake.requests).toHaveLength(1);
  });

  it("does not send anything when the signal is already aborted", async () => {
    const { client, fake } = setup();
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: AbortSignal.abort() }),
    );
    expect(error.kind).toBe("aborted");
    expect(fake.requests).toHaveLength(0);
  });

  it("stops retrying when cancelled during the backoff", async () => {
    const controller = new AbortController();
    const { client, fake } = setup([sevdeskErrorResponse(500, "x"), envelope([])], {
      onEvent: (event) => {
        if (event.type === "retry") controller.abort();
      },
    });
    const error = await catchError(
      client.request({ method: "GET", path: "/Invoice", signal: controller.signal }),
    );
    expect(error.kind).toBe("aborted");
    expect(fake.requests).toHaveLength(1);
  });

  it("passes a combined signal to fetch", async () => {
    const controller = new AbortController();
    const { client, fake } = setup([envelope([])]);
    await client.request({ method: "GET", path: "/Invoice", signal: controller.signal });
    const signal = fake.requests[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(controller.signal);
  });
});

describe("list", () => {
  it("always sends limit, offset and countAll and parses the string total", async () => {
    const { client, fake } = setup([envelope([{ id: "1" }, { id: "2" }], "57")]);

    const page = await client.list("/Invoice", { status: 200 });

    expect(page).toEqual({ items: [{ id: "1" }, { id: "2" }], total: 57 });
    const params = fake.requests[0]?.url.searchParams;
    expect(params?.get("limit")).toBe("100");
    expect(params?.get("offset")).toBe("0");
    expect(params?.get("countAll")).toBe("1");
    expect(params?.get("status")).toBe("200");
  });

  it("passes explicit limit and offset", async () => {
    const { client, fake } = setup([envelope([])]);
    const page = await client.list("/Invoice", undefined, { limit: 1000, offset: 2000 });
    expect(page.total).toBeUndefined();
    expect(fake.requests[0]?.url.searchParams.get("limit")).toBe("1000");
    expect(fake.requests[0]?.url.searchParams.get("offset")).toBe("2000");
  });

  it.each([
    [{ limit: 0 }],
    [{ limit: 1001 }],
    [{ limit: 1.5 }],
    [{ limit: Number.NaN }],
    [{ offset: -1 }],
    [{ offset: 0.5 }],
  ])("rejects %j locally", async (options) => {
    const { client, fake } = setup();
    const error = await catchError(client.list("/Invoice", undefined, options));
    expect(error.kind).toBe("validation");
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["limit", "offset", "countAll"])("rejects %s inside the query", async (key) => {
    const { client, fake } = setup();
    const error = await catchError(client.list("/Invoice", { [key]: 5 }));
    expect(error.kind).toBe("validation");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects a non-array payload", async () => {
    const { client } = setup([envelope({ id: "1" })]);
    const error = await catchError(client.list("/Invoice"));
    expect(error.kind).toBe("unexpected_response");
  });
});

describe("listAll", () => {
  function pageOf(count: number, start = 0): Response {
    return envelope(
      Array.from({ length: count }, (_, index) => ({ id: String(start + index + 1) })),
      "8",
    );
  }

  it("collects pages until an empty page", async () => {
    const { client, fake } = setup([pageOf(3), pageOf(2, 3), pageOf(0)]);
    const progress: [number, number | undefined][] = [];

    const result = await client.listAll(
      "/Contact",
      { depth: 1 },
      {
        max: 100,
        pageSize: 5,
        onProgress: (fetched, total) => progress.push([fetched, total]),
      },
    );

    expect(result.items).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(8);
    expect(fake.requests.map((request) => request.url.searchParams.get("offset"))).toEqual([
      "0",
      "3",
      "5",
    ]);
    expect(fake.requests.every((request) => request.url.searchParams.get("limit") === "5")).toBe(
      true,
    );
    expect(fake.requests.every((request) => request.url.searchParams.get("depth") === "1")).toBe(
      true,
    );
    expect(progress).toEqual([
      [3, 8],
      [5, 8],
    ]);
  });

  it("stops at max and reports truncation", async () => {
    const { client, fake } = setup([pageOf(3), pageOf(2, 3)]);

    const result = await client.listAll("/Contact", undefined, { max: 4, pageSize: 3 });

    expect(result.items.map((item) => (item as { id: string }).id)).toEqual(["1", "2", "3", "4"]);
    expect(result.truncated).toBe(true);
    expect(fake.requests.map((request) => request.url.searchParams.get("limit"))).toEqual([
      "3",
      "2",
    ]);
  });

  it("probes one row when exactly max items were collected", async () => {
    const { client, fake } = setup([pageOf(3), pageOf(0)]);
    const result = await client.listAll("/Contact", undefined, { max: 3 });
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(3);
    expect(fake.requests.map((request) => request.url.searchParams.get("limit"))).toEqual([
      "4",
      "1",
    ]);
  });

  it("uses a default page size of 500", async () => {
    const { client, fake } = setup([pageOf(0)]);
    await client.listAll("/Contact", undefined, { max: 10_000 });
    expect(fake.requests[0]?.url.searchParams.get("limit")).toBe("500");
  });

  it.each([
    [{ max: 0 }],
    [{ max: 1.5 }],
    [{ max: 10, pageSize: 0 }],
    [{ max: 10, pageSize: 1001 }],
  ])("rejects %j locally", async (options) => {
    const { client, fake } = setup();
    const error = await catchError(client.listAll("/Contact", undefined, options));
    expect(error.kind).toBe("validation");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("download", () => {
  it("returns raw bytes and the content type", async () => {
    const bytes = new TextEncoder().encode("a;b\n1;2\n");
    const { client, fake } = setup([
      new Response(bytes, { status: 200, headers: { "Content-Type": "text/csv" } }),
    ]);

    const result = await client.download({ method: "GET", path: "/Export/invoiceCsv" });

    expect(new TextDecoder().decode(result.body)).toBe("a;b\n1;2\n");
    expect(result.contentType).toBe("text/csv");
    expect(fake.requests[0]?.headers.get("accept")).toBe("*/*");
    expect(fake.requests[0]?.headers.get("authorization")).toBe(TOKEN);
  });

  it("reports a missing content type as undefined", async () => {
    const { client } = setup([new Response(new Uint8Array([1, 2, 3]), { status: 200 })]);
    const result = await client.download({ method: "GET", path: "/Export/datevZip" });
    expect(result.contentType).toBeUndefined();
    expect([...result.body]).toEqual([1, 2, 3]);
  });

  it("retries and classifies errors like request()", async () => {
    const { client, fake } = setup([
      sevdeskErrorResponse(503, "busy"),
      sevdeskErrorResponse(404, "gone"),
    ]);
    const error = await catchError(client.download({ method: "GET", path: "/Export/datevZip" }));
    expect(error.kind).toBe("not_found");
    expect(fake.requests).toHaveLength(2);
  });

  it("applies the write gate", async () => {
    const { client, fake } = setup([], { config: { readOnly: true } });
    const error = await catchError(
      client.download({ method: "GET", path: "/Invoice/1/getXml", sideEffect: true }),
    );
    expect(error.kind).toBe("blocked");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("pacing", () => {
  it("spaces requests at the configured rate", async () => {
    const { client, clock } = setup([envelope([]), envelope([]), envelope([])], {
      config: { requestsPerSecond: 4 },
    });
    await Promise.all([
      client.request({ method: "GET", path: "/Contact" }),
      client.request({ method: "GET", path: "/Contact" }),
      client.request({ method: "GET", path: "/Contact" }),
    ]);
    // Three requests at 4/s: the third starts 500 ms after the first.
    expect(clock.now() - FAKE_EPOCH).toBe(500);
  });

  it("is not stalled by a wall clock jumping backwards", async () => {
    // Every Date.now() call jumps one hour back; a wall-clock pacer would wait for hours.
    let wall = FAKE_EPOCH;
    vi.spyOn(Date, "now").mockImplementation(() => {
      wall -= 3_600_000;
      return wall;
    });
    const sleeps: number[] = [];
    const fake = createFakeFetch(envelope([]), envelope([]), envelope([]));
    const client = createSevdeskClient(
      { ...baseConfig, requestsPerSecond: 4 },
      {
        fetch: fake.fetch,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );

    for (let index = 0; index < 3; index += 1) {
      await client.request({ method: "GET", path: "/Contact" });
    }

    expect(fake.requests).toHaveLength(3);
    expect(sleeps.every((ms) => ms <= 500)).toBe(true);
  });

  it("reads HTTP-date Retry-After against the wall clock, not the monotonic one", async () => {
    const clock = createFakeClock();
    const fake = createFakeFetch(
      sevdeskErrorResponse(429, "slow down", {
        "Retry-After": new Date(FAKE_EPOCH + 4000).toUTCString(),
      }),
      envelope([]),
    );
    const client = createSevdeskClient(baseConfig, {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: () => FAKE_EPOCH,
      monotonicNow: () => 0,
    });
    await client.request({ method: "GET", path: "/Contact" });
    expect(clock.sleeps[0]).toBe(4000);
  });
});
