/**
 * The write gate of the script tests' {@link ScriptedClient}: it refuses what the real client
 * refuses, and a refusal a test does not take fails that test (the probe HTTP wrapper would
 * otherwise turn it into a quiet `ok: false`).
 */
import { describe, expect, it } from "vitest";

import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { ScriptedClient } from "./scripted-client.js";

const ok = () => ({ objects: { id: "1" } });

async function blocked(run: () => Promise<unknown>): Promise<SevdeskError> {
  const caught: unknown = await run().catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(SevdeskError);
  if (!(caught instanceof SevdeskError)) throw new Error("not a SevdeskError");
  expect(caught.kind).toBe("blocked");
  return caught;
}

describe("ScriptedClient write gate", () => {
  it("refuses a tier below the endpoint's minimum and keeps the refusal", async () => {
    const client = new ScriptedClient(ok);
    const error = await blocked(() =>
      client.request({ method: "PUT", path: "/Order/7", tier: "write", body: { status: 500 } }),
    );
    expect(error.message).toContain("needs at least the commit tier");
    expect(client.calls).toEqual([]);
    expect(client.takeBlocked()).toEqual([
      { method: "PUT", path: "/Order/7", reason: expect.stringContaining("commit tier") as string },
    ]);
    expect(client.takeBlocked()).toEqual([]);
  });

  it("refuses a write without a tier, like the real client", async () => {
    const client = new ScriptedClient(ok);
    const error = await blocked(() =>
      client.request({ method: "POST", path: "/Contact", body: { name: "x" } }),
    );
    expect(error.message).toContain("did not declare its tier");
    // A GET that changes data (getPdf without preventSendBy=true) needs a tier as well.
    await blocked(() =>
      client.download({ method: "GET", path: "/Invoice/7/getPdf", query: { preventSendBy: 0 } }),
    );
    expect(client.calls).toEqual([]);
    expect(client.takeBlocked()).toHaveLength(2);
  });

  it("refuses a request that declares the read tier", async () => {
    const client = new ScriptedClient(ok);
    const read = "read" as unknown as "write";
    await blocked(() => client.request({ method: "DELETE", path: "/Contact/7", tier: read }));
    expect(client.takeBlocked()).toHaveLength(1);
  });

  it("answers a covered write and reads without a tier", async () => {
    const client = new ScriptedClient(ok);
    await expect(
      client.request({ method: "PUT", path: "/Order/7", tier: "commit", body: { status: 500 } }),
    ).resolves.toEqual({ id: "1" });
    await expect(
      client.request({ method: "POST", path: "/Contact", tier: "write", body: { name: "x" } }),
    ).resolves.toEqual({ id: "1" });
    await expect(client.request({ method: "GET", path: "/Contact/7" })).resolves.toEqual({
      id: "1",
    });
    expect(client.calls.map((call) => `${call.method} ${call.path} ${call.tier ?? "-"}`)).toEqual([
      "PUT /Order/7 commit",
      "POST /Contact write",
      "GET /Contact/7 -",
    ]);
    expect(client.takeBlocked()).toEqual([]);
  });

  // No assertion in the body: the test fails only through the check after each test, so this
  // passes only while that check fails a test with a refusal nobody took.
  it.fails("fails a test whose refusal nobody took", async () => {
    const client = new ScriptedClient(ok);
    await client
      .request({ method: "PUT", path: "/Order/7", tier: "write", body: { status: 500 } })
      .catch(() => undefined);
  });
});
