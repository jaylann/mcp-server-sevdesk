/**
 * A refused contact deletion that arrives as HTTP 200 (spec/deviations.md D-085).
 *
 * `DELETE /Contact/{id}` of a contact that a document references (recorded 2026-11-16: a draft
 * invoice) is refused, but not with the 409 the spec declares: sevDesk answers HTTP 200 with
 * `{objects: null, error: {message: "Cannot delete because of existing necessary references"}}`
 * and deletes nothing. Read as a success, the tool would report a contact as deleted that still
 * exists; shown raw, sevDesk's own text would reach the model unfenced.
 *
 * Guard: the client raises a 2xx body with an `error` member and no `objects` as
 * `unexpected_response` (status 200, sevDesk's text only as `upstreamMessage`);
 * `sevdesk_contact_delete` recognizes the refusal, reads the contact back, and reports
 * `deleted: false` and `stillReferenced: true` with a note in its own words. The DELETE is sent
 * exactly once. This runs through the real HTTP client with a scripted `fetch`.
 */
import { describe, expect, it } from "vitest";

import type { Tier } from "../../src/safety/tiers.js";
import { createSevdeskClient } from "../../src/sevdesk/client.js";
import { contactDeleteTool as tool } from "../../src/tools/contacts/delete.js";
import { loadFixture } from "../helpers/fake-client.js";
import { createFakeClock, createFakeFetch, envelope, jsonResponse } from "../helpers/fake-fetch.js";
import { executeWrite } from "../helpers/write-tools.js";

const PERSON = (loadFixture("contacts/contact-1002.json").body as { objects: unknown[] }).objects;
const REFUSAL = {
  objects: null,
  error: {
    message: "Cannot delete because of existing necessary references",
    code: null,
    data: null,
    exceptionUUID: "4f1c2d3e-0000-4000-8000-000000000085",
  },
};

/** sevDesk as recorded: person 1002 without addresses or communication ways, still referenced. */
function answer(request: { readonly url: URL; readonly method: string }): Response {
  const path = request.url.pathname.replace(/^\/api\/v1/, "");
  if (request.method === "DELETE" && path === "/Contact/1002") return jsonResponse(REFUSAL, 200);
  if (request.method === "GET" && path === "/Contact/1002") return envelope(PERSON);
  // Its addresses, communication ways, custom field values and the contacts stored with it as
  // parent: none.
  if (
    request.method === "GET" &&
    (path === "/ContactAddress" ||
      path === "/CommunicationWay" ||
      path === "/ContactCustomField" ||
      path === "/Contact")
  ) {
    return envelope([], "0");
  }
  throw new Error(`unexpected request: ${request.method} ${path}`);
}

function setup() {
  const fake = createFakeFetch(...Array.from({ length: 10 }, () => answer));
  const clock = createFakeClock();
  const client = createSevdeskClient(
    {
      token: "0123456789abcdef0123456789abcdef",
      baseUrl: "https://my.sevdesk.de/api/v1",
      allowedTiers: new Set<Tier>(["read", "write", "commit"]),
      readOnly: false,
      dryRun: false,
      requestsPerSecond: 1000,
      timeoutMs: 1000,
      userAgent: "test",
    },
    {
      fetch: fake.fetch,
      sleep: clock.sleep,
      now: clock.now,
      monotonicNow: clock.now,
      random: () => 0.5,
    },
  );
  return { client, fake };
}

describe("D-085: a refused contact deletion arrives as HTTP 200", () => {
  it("is reported as a refusal in our words, not as a deletion, and never retried", async () => {
    const { client, fake } = setup();
    const { output } = await executeWrite(tool, { id: 1002 }, client);

    expect(output.data.deleted).toBe(false);
    expect(output.data.stillReferenced).toBe(true);
    expect(output.summary).toBe(
      "sevDesk refused to delete contact 1002: documents still reference it. Nothing was " +
        "deleted. See notes.",
    );
    expect(output.data.notes?.[0]).toMatch(/^sevDesk refused to delete contact 1002: documents/);
    expect(output.affected).toEqual([]);
    // sevDesk's own wording stays out of everything the model reads.
    expect(JSON.stringify(output)).not.toMatch(/necessary references/i);

    const deletes = fake.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.url.pathname)).toEqual(["/api/v1/Contact/1002"]);
    // The read afterwards is what proves the contact is still there.
    expect(fake.requests.at(-1)).toMatchObject({ method: "GET" });
    expect(fake.requests.at(-1)?.url.pathname).toBe("/api/v1/Contact/1002");
  });
});
