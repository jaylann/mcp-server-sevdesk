/**
 * A {@link SevdeskClient} for script tests whose answers come from one handler function, so a
 * test can simulate a whole account (lists, by-id reads, writes, refusals) without a route per
 * request. Records every call with its tier and body.
 *
 * Like the real client, it refuses a request that changes data unless it declares a write tier
 * that covers the endpoint's minimum (`writeBlockReason` with every tier enabled, and
 * `minimumWriteTier`), before recording or answering it: a probe that would be blocked on the
 * live account is blocked here too. The probe HTTP wrapper turns that refusal into a quiet
 * `ok: false`, so the client also keeps it, and after each test every refusal of every
 * `ScriptedClient` of the file fails that test. A test that means to provoke one takes it with
 * {@link ScriptedClient.takeBlocked}.
 */
import { afterEach, expect } from "vitest";

import { TIERS } from "../../../src/safety/tiers.js";
import { writeBlockReason } from "../../../src/sevdesk/client.js";
import { SevdeskError } from "../../../src/sevdesk/errors.js";
import { minimumWriteTier } from "../../../src/sevdesk/paths.js";
import { changesData } from "../../../src/sevdesk/scoped-client.js";
import type { SevdeskClient, SevdeskRequest } from "../../../src/sevdesk/types.js";

export interface ScriptedCall {
  readonly operation: "request" | "download" | "list";
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  /** Multipart body of a request (e.g. `uploadTempFile`). */
  readonly form?: FormData;
  readonly tier?: string;
  /** A download sent as a side-effect GET (e.g. an export job). */
  readonly sideEffect?: boolean;
}

/** A request the client refused before answering it, and why (the real client's wording). */
export interface BlockedCall {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

/**
 * Return a full response body (`{objects: …}`), or throw a `SevdeskError` to refuse. A download
 * may also answer raw bytes: a `Uint8Array` (served as a PDF) or a {@link RawAnswer}.
 */
export type ScriptedHandler = (call: ScriptedCall) => unknown;

/** A raw download body with its content type (CSV, ZIP, XML, …). */
export class RawAnswer {
  constructor(
    readonly body: Uint8Array,
    readonly contentType: string | undefined,
  ) {}
}

/** The real client's write gate with every tier enabled: only the request's own tier counts. */
const EVERY_TIER = { allowedTiers: new Set(TIERS), readOnly: false, dryRun: false };

/** Every `ScriptedClient` of the running test file. */
const clients = new Set<ScriptedClient>();

afterEach(() => {
  const blocked = [...clients].flatMap((client) => client.takeBlocked());
  expect(blocked, "requests the real client would refuse before sending them").toEqual([]);
});

export class ScriptedClient implements SevdeskClient {
  readonly calls: ScriptedCall[] = [];
  private blocked: BlockedCall[] = [];

  constructor(private readonly handler: ScriptedHandler) {
    clients.add(this);
  }

  /** The requests refused since the last call; taking them keeps them from failing the test. */
  takeBlocked(): BlockedCall[] {
    const taken = this.blocked;
    this.blocked = [];
    return taken;
  }

  private answer(call: ScriptedCall): unknown {
    this.calls.push(call);
    return this.handler(call);
  }

  /** The real client's write gate: a declared write tier that covers the request's minimum. */
  private gate(request: SevdeskRequest): void {
    if (!changesData(request)) return;
    const required = minimumWriteTier(request.path, request.query, request.body, request.form);
    const reason = writeBlockReason(EVERY_TIER, request.tier, required);
    if (reason === undefined) return;
    this.blocked.push({ method: request.method, path: request.path, reason });
    throw new SevdeskError({
      kind: "blocked",
      message:
        `Blocked before sending: ${request.method} ${request.path} changes data in sevDesk, ` +
        `but ${reason}. Nothing was sent.`,
      method: request.method,
      path: request.path,
    });
  }

  request(request: SevdeskRequest): Promise<unknown> {
    return Promise.resolve().then(() => {
      this.gate(request);
      const body = this.answer({
        operation: "request",
        method: request.method,
        path: request.path,
        query: request.query ?? {},
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.form === undefined ? {} : { form: request.form }),
        ...(request.tier === undefined ? {} : { tier: request.tier }),
      }) as { objects?: unknown } | undefined;
      return body?.objects;
    });
  }

  download(
    request: SevdeskRequest,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    return Promise.resolve().then(() => {
      this.gate(request);
      const body = this.answer({
        operation: "download",
        method: request.method,
        path: request.path,
        query: request.query ?? {},
        ...(request.tier === undefined ? {} : { tier: request.tier }),
        ...(request.sideEffect === undefined ? {} : { sideEffect: request.sideEffect }),
      });
      if (body instanceof RawAnswer) return { body: body.body, contentType: body.contentType };
      if (body instanceof Uint8Array) return { body, contentType: "application/pdf" };
      return {
        body: new TextEncoder().encode(JSON.stringify(body)),
        contentType: "application/json",
      };
    });
  }

  list(
    path: string,
    query?: Readonly<Record<string, unknown>>,
    options: { limit?: number; offset?: number } = {},
  ) {
    return Promise.resolve().then(() => {
      const body = this.answer({
        operation: "list",
        method: "GET",
        path,
        query: { ...query, limit: options.limit ?? 100, offset: options.offset ?? 0 },
      }) as { objects?: unknown[]; total?: string };
      const items = body.objects ?? [];
      return { items, total: body.total === undefined ? items.length : Number(body.total) };
    });
  }

  listAll(): never {
    throw new Error("ScriptedClient.listAll is not used by the scripts");
  }

  /** Calls that change data. */
  writes(): ScriptedCall[] {
    return this.calls.filter((call) => call.method !== "GET");
  }
}
