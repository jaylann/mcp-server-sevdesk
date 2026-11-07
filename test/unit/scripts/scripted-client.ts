/**
 * A {@link SevdeskClient} for script tests whose answers come from one handler function, so a
 * test can simulate a whole account (lists, by-id reads, writes, refusals) without a route per
 * request. Records every call with its tier and body.
 */
import type { SevdeskClient, SevdeskRequest } from "../../../src/sevdesk/types.js";

export interface ScriptedCall {
  readonly operation: "request" | "download" | "list";
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly tier?: string;
}

/** Return a full response body (`{objects: …}`), or throw a `SevdeskError` to refuse. */
export type ScriptedHandler = (call: ScriptedCall) => unknown;

export class ScriptedClient implements SevdeskClient {
  readonly calls: ScriptedCall[] = [];

  constructor(private readonly handler: ScriptedHandler) {}

  private answer(call: ScriptedCall): unknown {
    this.calls.push(call);
    return this.handler(call);
  }

  request(request: SevdeskRequest): Promise<unknown> {
    return Promise.resolve().then(() => {
      const body = this.answer({
        operation: "request",
        method: request.method,
        path: request.path,
        query: request.query ?? {},
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.tier === undefined ? {} : { tier: request.tier }),
      }) as { objects?: unknown } | undefined;
      return body?.objects;
    });
  }

  download(
    request: SevdeskRequest,
  ): Promise<{ body: Uint8Array; contentType: string | undefined }> {
    return Promise.resolve().then(() => {
      const body = this.answer({
        operation: "download",
        method: request.method,
        path: request.path,
        query: request.query ?? {},
      });
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
