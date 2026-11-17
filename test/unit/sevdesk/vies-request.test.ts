import { afterEach, describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import {
  postViesCheck,
  swapViesFetch,
  VIES_ENDPOINT,
  viesTransport,
} from "../../../src/sevdesk/vies-request.js";
import { createFakeFetch, jsonResponse, networkError } from "../../helpers/fake-fetch.js";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function useFetch(...replies: Parameters<typeof createFakeFetch>) {
  const fake = createFakeFetch(...replies);
  restore = swapViesFetch(fake.fetch);
  return fake;
}

describe("postViesCheck: the request", () => {
  it("posts only the prefix and the number to the one fixed URL, without redirects or credentials", async () => {
    const fake = useFetch(jsonResponse({ valid: true }));
    expect(await postViesCheck("AT", "U12345678")).toEqual({
      kind: "answer",
      status: 200,
      body: { valid: true },
    });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.url.href).toBe(VIES_ENDPOINT);
    expect(request?.url.protocol).toBe("https:");
    expect(request?.url.host).toBe("ec.europa.eu");
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("manual");
    expect(JSON.parse(String(request?.body))).toEqual({
      countryCode: "AT",
      vatNumber: "U12345678",
    });
    expect([...(request?.headers.keys() ?? [])].sort()).toEqual(["accept", "content-type"]);
  });
});

describe("postViesCheck: what comes back", () => {
  it("hands over any status with its JSON body, and undefined for a body that is not JSON", async () => {
    useFetch(jsonResponse({ errorWrappers: [{ error: "MS_UNAVAILABLE" }] }, 500));
    expect(await postViesCheck("AT", "U12345678")).toEqual({
      kind: "answer",
      status: 500,
      body: { errorWrappers: [{ error: "MS_UNAVAILABLE" }] },
    });
    restore?.();
    useFetch(new Response("<html>", { status: 200 }));
    expect(await postViesCheck("AT", "U12345678")).toEqual({
      kind: "answer",
      status: 200,
      body: undefined,
    });
  });

  it("never follows a redirect and stops reading at the cap", async () => {
    useFetch(new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }));
    expect(await postViesCheck("AT", "U12345678")).toEqual({ kind: "failed", reason: "redirect" });
    restore?.();
    useFetch(jsonResponse({ valid: true, name: "x".repeat(2_000) }));
    expect(await postViesCheck("AT", "U12345678", { maxBytes: 512 })).toEqual({
      kind: "failed",
      reason: "too_large",
    });
  });

  it("reports a network failure and a timeout, and rethrows the caller's cancellation", async () => {
    useFetch({ throws: networkError() });
    expect(await postViesCheck("AT", "U12345678")).toEqual({ kind: "failed", reason: "network" });
    restore?.();
    useFetch("hang");
    expect(await postViesCheck("AT", "U12345678", { timeoutMs: 20 })).toEqual({
      kind: "failed",
      reason: "timeout",
    });
    restore?.();
    useFetch("hang");
    const controller = new AbortController();
    const pending = postViesCheck("AT", "U12345678", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SevdeskError);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("swapViesFetch restores the previous fetch", () => {
    const original = viesTransport.fetch;
    const undo = swapViesFetch(() => Promise.reject(new Error("fake")));
    expect(viesTransport.fetch).not.toBe(original);
    undo();
    expect(viesTransport.fetch).toBe(original);
  });
});
