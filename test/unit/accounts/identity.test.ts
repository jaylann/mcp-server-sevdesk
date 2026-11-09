import { describe, expect, it, vi } from "vitest";

import { createIdentityLookup, type IdentityLookupDeps } from "../../../src/accounts/identity.js";
import { IdentityError, type IdentityErrorKind } from "../../../src/accounts/types.js";
import { TEST_TOKEN } from "../../helpers/config.js";
import { loadFixture } from "../../helpers/fake-client.js";
import {
  createFakeClock,
  createFakeFetch,
  envelope,
  type FakeReply,
  jsonResponse,
  networkError,
  sevdeskErrorResponse,
} from "../../helpers/fake-fetch.js";

const SETTINGS = {
  baseUrl: "https://my.sevdesk.de/api/v1",
  userAgent: "mcp-server-sevdesk/0.0.0-test",
  requestsPerSecond: 4,
};

function lookup(replies: FakeReply[], deps: IdentityLookupDeps = {}) {
  const fake = createFakeFetch(...replies);
  const clock = createFakeClock();
  const identify = createIdentityLookup(SETTINGS, {
    fetch: fake.fetch,
    sleep: clock.sleep,
    monotonicNow: clock.now,
    now: clock.now,
    random: () => 0,
    ...deps,
  });
  return { identify, fake };
}

async function failure(promise: Promise<unknown>): Promise<IdentityError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof IdentityError))
    throw new Error(`expected an IdentityError: ${String(error)}`);
  return error;
}

function expectNoToken(error: IdentityError, token = TEST_TOKEN): void {
  expect(error.message).not.toContain(token);
  expect(JSON.stringify(error)).not.toContain(token);
  expect(String(error.stack)).not.toContain(token);
}

const sevClient = loadFixture("recorded/2026-11-08/meta/sev-client.json").body;
const sevUsers = loadFixture("meta/sev-users.json").body;

describe("identity lookup: GET /SevClient", () => {
  it("names the account of the recorded answer, read-only, with the token as Authorization", async () => {
    const { identify, fake } = lookup([jsonResponse(sevClient)]);

    const identity = await identify(TEST_TOKEN, new AbortController().signal);

    expect(identity).toEqual({ accountId: "9001", name: "Mustername 1" });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.method).toBe("GET");
    expect(request?.url.href).toBe("https://my.sevdesk.de/api/v1/SevClient");
    expect(request?.headers.get("authorization")).toBe(TEST_TOKEN);
    expect(request?.redirect).toBe("manual");
  });

  it("reads a single object too, cleans the name and leaves out an empty one", async () => {
    const { identify } = lookup([
      envelope({ id: 1234, name: "  Muster‮ GmbH\u0007 " }),
      envelope({ id: "77", name: "" }),
    ]);

    await expect(identify(TEST_TOKEN, new AbortController().signal)).resolves.toEqual({
      accountId: "1234",
      name: "Muster GmbH",
    });
    await expect(identify(TEST_TOKEN, new AbortController().signal)).resolves.toEqual({
      accountId: "77",
    });
  });

  it.each([
    ["no id", envelope([{ name: "x" }])],
    ["a non-numeric id", envelope([{ id: "abc" }])],
    ["no object", envelope([])],
    ["a broken body", new Response("not json", { status: 200 })],
  ])("reports an answer with %s as unexpected", async (_label, reply) => {
    const { identify } = lookup([reply]);

    const error = await failure(identify(TEST_TOKEN, new AbortController().signal));

    expect(error.kind).toBe("unexpected");
    expect(error.message).toContain("unexpected format");
    expectNoToken(error);
  });
});

describe("identity lookup: GET /SevUser fallback", () => {
  it("finds the account through the token's users when /SevClient is forbidden", async () => {
    const { identify, fake } = lookup([
      sevdeskErrorResponse(403, "Forbidden"),
      jsonResponse(sevUsers),
    ]);

    const identity = await identify(TEST_TOKEN, new AbortController().signal);

    expect(identity).toEqual({ accountId: "9001" });
    expect(fake.requests[1]?.url.pathname).toBe("/api/v1/SevUser");
    expect(fake.requests[1]?.url.searchParams.get("limit")).toBe("1");
  });

  it.each([
    ["forbidden too", sevdeskErrorResponse(403, "Forbidden"), "unauthorized", "HTTP 403"],
    ["refusing the token", sevdeskErrorResponse(401, "Unauthorized"), "unauthorized", "HTTP 401"],
    ["without a sevClient", envelope([{ id: "2001" }]), "unexpected", "unexpected format"],
    ["empty", envelope([]), "unexpected", "unexpected format"],
  ] as const)("fails when /SevUser is %s", async (_label, reply, kind, text) => {
    const { identify } = lookup([sevdeskErrorResponse(403, "Forbidden"), reply]);

    const error = await failure(identify(TEST_TOKEN, new AbortController().signal));

    expect(error.kind).toBe(kind);
    expect(error.message).toContain(text);
    expectNoToken(error);
  });
});

describe("identity lookup: failures", () => {
  const cases: readonly (readonly [string, FakeReply[], IdentityErrorKind, string])[] = [
    [
      "a rejected token (401)",
      [sevdeskErrorResponse(401, `token ${TEST_TOKEN} invalid`)],
      "unauthorized",
      "sevDesk rejected this API token (HTTP 401).",
    ],
    [
      "a network error (after the client's retries)",
      [{ throws: networkError() }, { throws: networkError() }, { throws: networkError() }],
      "unreachable",
      "Could not reach sevDesk",
    ],
    [
      "a server error (after the client's retries)",
      [
        sevdeskErrorResponse(500, "boom"),
        sevdeskErrorResponse(500, "boom"),
        sevdeskErrorResponse(500, "boom"),
      ],
      "unreachable",
      "Could not reach sevDesk",
    ],
    ["a validation error", [sevdeskErrorResponse(400, "bad")], "unexpected", "unexpected format"],
  ];

  it.each(cases)("maps %s", async (_label, replies, kind, text) => {
    const { identify } = lookup(replies);

    const error = await failure(identify(TEST_TOKEN, new AbortController().signal));

    expect(error).toBeInstanceOf(IdentityError);
    expect(error.name).toBe("IdentityError");
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(text);
    expectNoToken(error);
  });

  it.each([
    ["empty", ""],
    ["with whitespace", "0123456789abcdef 0123456789abcdef"],
    ["with a Bearer prefix", `Bearer ${TEST_TOKEN}`],
    ["the word bearer", "Bearer"],
    ["non-ASCII", "töken"],
    ["too long", "x".repeat(513)],
  ])("refuses a token that is %s without asking sevDesk", async (_label, token) => {
    const { identify, fake } = lookup([]);

    const error = await failure(identify(token, new AbortController().signal));

    expect(error.kind).toBe("unauthorized");
    expect(error.message).toContain("This is not a sevDesk API token.");
    expect(fake.requests).toHaveLength(0);
    // The message names the 'Bearer ' prefix itself; every other value must stay out.
    if (token !== "" && token !== "Bearer") expectNoToken(error, token);
  });

  it("stops when the caller aborts", async () => {
    const { identify } = lookup(["hang"]);
    const controller = new AbortController();

    const pending = failure(identify(TEST_TOKEN, controller.signal));
    controller.abort();
    const error = await pending;

    expect(error.kind).toBe("unreachable");
  });

  it("stops after its time budget (8 s by default)", async () => {
    const budgets: number[] = [];
    const budget = new AbortController();
    const { identify } = lookup(["hang"], {
      timeoutSignal: (ms) => {
        budgets.push(ms);
        return budget.signal;
      },
    });

    const pending = failure(identify(TEST_TOKEN, new AbortController().signal));
    budget.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const error = await pending;

    expect(budgets).toEqual([8_000]);
    expect(error.kind).toBe("unreachable");
  });

  it("uses the configured budget", async () => {
    const budgets: number[] = [];
    const { identify } = lookup([jsonResponse(sevClient)], {
      timeoutMs: 2_000,
      timeoutSignal: (ms) => {
        budgets.push(ms);
        return new AbortController().signal;
      },
    });

    await identify(TEST_TOKEN, new AbortController().signal);

    expect(budgets).toEqual([2_000]);
  });

  it("never logs", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { identify } = lookup([sevdeskErrorResponse(401, "Unauthorized")]);

    await failure(identify(TEST_TOKEN, new AbortController().signal));

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("maps a failure outside the client as unexpected", async () => {
    const { identify } = lookup([
      () => {
        throw new RangeError("odd");
      },
    ]);

    const error = await failure(identify(TEST_TOKEN, new AbortController().signal));

    expect(["unexpected", "unreachable"]).toContain(error.kind);
    expectNoToken(error);
  });
});
