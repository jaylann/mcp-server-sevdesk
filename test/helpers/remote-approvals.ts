/**
 * Test doubles for the remote approval inbox (`src/http/approval-routes.ts`):
 * - in-memory {@link SessionStore} and {@link ApprovalStore} implementing the contracts (until the
 *   real grant store and approval store are wired, and as small, inspectable stand-ins after);
 * - a request context with real token buckets on a fake clock and a captured log;
 * - a minimal router (path and method matching only: Host, origin policy, body caps and route
 *   rate limits belong to the real router), so the handlers' own checks are what is tested;
 * - {@link RemoteBrowser}, a fake browser with a cookie jar that submits the pages' forms the way
 *   a browser does (`Origin`, `Sec-Fetch-Site`, form encoding) and can be told to send what a
 *   browser would not.
 */
import { randomBytes } from "node:crypto";

import type { RequestPrincipal } from "../../src/accounts/types.js";
import type {
  HttpLog,
  HttpRequestContext,
  HttpRoute,
  LogFields,
  RateRule,
  SessionRecord,
  SessionStore,
} from "../../src/http/types.js";
import {
  type ApprovalBinding,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalStore,
  type ApprovalTicket,
  type ApprovalView,
  type DecideOutcome,
} from "../../src/safety/approval-types.js";

export const ORIGIN = "https://mcp.example.com";
/** 2026-11-09T12:00:00Z */
const START_MS = Date.UTC(2026, 10, 9, 12, 0, 0);

/** A clock tests move by hand. */
export interface FakeClock {
  readonly now: () => number;
  advance(ms: number): void;
}

export function fakeClock(start = START_MS): FakeClock {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
  };
}

function seconds(clock: () => number): number {
  return Math.floor(clock() / 1000);
}

/** In-memory sessions; `revokeGrant` plays the grant store revoking a grant with its sessions. */
export interface MemorySessionStore extends SessionStore {
  readonly records: Map<string, SessionRecord>;
  revokeGrant(gid: string): void;
}

export function createMemorySessionStore(now: () => number): MemorySessionStore {
  const records = new Map<string, SessionRecord>();
  const revokedGrants = new Set<string>();
  return {
    records,
    createSession(input) {
      const createdAt = seconds(now);
      const record: SessionRecord = {
        sid: randomBytes(16).toString("base64url"),
        accountId: input.accountId,
        gid: input.gid,
        via: input.via,
        createdAt,
        expiresAt: createdAt + input.ttlSeconds,
      };
      records.set(record.sid, record);
      return Promise.resolve(record);
    },
    getSession(sid) {
      const record = records.get(sid);
      if (record === undefined || record.expiresAt <= seconds(now)) return undefined;
      if (record.gid !== undefined && revokedGrants.has(record.gid)) return undefined;
      return record;
    },
    revokeSession(sid) {
      records.delete(sid);
      return Promise.resolve();
    },
    sync() {
      return Promise.resolve();
    },
    revokeGrant(gid) {
      revokedGrants.add(gid);
    },
  };
}

interface MemoryRecord {
  readonly id: string;
  readonly reference: string;
  readonly owner: RequestPrincipal;
  readonly binding: ApprovalBinding;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  status: ApprovalView["status"];
  opened: boolean;
}

/** In-memory approvals with owner scoping; {@link MemoryApprovalStore.add} skips the channel. */
export interface MemoryApprovalStore extends ApprovalStore {
  readonly decisions: ApprovalDecision[];
  add(owner: RequestPrincipal, binding?: Partial<ApprovalBinding>): ApprovalView;
}

export function createMemoryApprovalStore(
  now: () => number,
  options: { readonly channel?: ApprovalChannel; readonly ttlMs?: number } = {},
): MemoryApprovalStore {
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const records = new Map<string, MemoryRecord>();
  const decisions: ApprovalDecision[] = [];
  let counter = 0;

  function live(record: MemoryRecord | undefined): MemoryRecord | undefined {
    return record !== undefined && record.expiresAtMs > now() ? record : undefined;
  }

  function view(record: MemoryRecord): ApprovalView {
    return {
      id: record.id,
      reference: record.reference,
      owner: record.owner,
      binding: record.binding,
      status: record.status,
      createdAt: new Date(record.createdAtMs).toISOString(),
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  function ticket(record: MemoryRecord): ApprovalTicket {
    return {
      id: record.id,
      reference: record.reference,
      opened: record.opened,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      status: record.status,
      previewHash: record.binding.previewHash,
      callId: record.binding.callId,
    };
  }

  function insert(owner: RequestPrincipal, overrides: Partial<ApprovalBinding>): MemoryRecord {
    counter += 1;
    const record: MemoryRecord = {
      id: randomBytes(32).toString("base64url"),
      reference: `REF${String(counter).padStart(3, "0")}`,
      owner,
      binding: testBinding(overrides),
      // Strictly increasing, so "newest first" is well defined under a frozen clock.
      createdAtMs: now() + counter,
      expiresAtMs: now() + ttlMs,
      status: "pending",
      opened: false,
    };
    records.set(record.id, record);
    return record;
  }

  const store: MemoryApprovalStore = {
    decisions,
    add(owner, binding = {}) {
      return view(insert(owner, binding));
    },
    current(owner, toolName, argsHash) {
      for (const record of records.values()) {
        if (
          live(record) !== undefined &&
          record.owner.grantKey === owner.grantKey &&
          record.binding.toolName === toolName &&
          record.binding.argsHash === argsHash
        ) {
          return ticket(record);
        }
      }
      return undefined;
    },
    async create(owner, binding) {
      const record = insert(owner, binding);
      if (options.channel !== undefined) {
        record.opened = (await options.channel.present(view(record))).opened;
      }
      return ticket(record);
    },
    take(owner, id) {
      const record = live(records.get(id));
      if (record === undefined || record.owner.grantKey !== owner.grantKey) return undefined;
      records.delete(id);
      return ticket(record);
    },
    list(accountScope) {
      return [...records.values()]
        .filter(
          (record) => live(record) !== undefined && record.owner.accountScope === accountScope,
        )
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map(view);
    },
    get(id) {
      const record = live(records.get(id));
      return record === undefined ? undefined : view(record);
    },
    decide(id, decision): DecideOutcome {
      const record = records.get(id);
      if (record === undefined) return "unknown";
      if (live(record) === undefined) return "expired";
      if (record.status !== "pending") return "already_decided";
      record.status = decision;
      decisions.push({
        owner: record.owner,
        binding: record.binding,
        reference: record.reference,
        decision,
      });
      return "decided";
    },
    close() {
      records.clear();
      return options.channel?.close() ?? Promise.resolve();
    },
  };
  options.channel?.attach(store);
  return store;
}

/** A binding for tests; preview texts are distinctive so tests can look for leaks. */
export function testBinding(overrides: Partial<ApprovalBinding> = {}): ApprovalBinding {
  return {
    toolName: "sevdesk_invoice_finalize",
    toolTitle: "Finalize invoice",
    tier: "commit",
    argsHash: "a".repeat(64),
    previewHash: "p".repeat(64),
    preview: {
      action: "Finalize invoice RE-1042.",
      facts: [{ label: "Customer", value: "Muster GmbH" }],
      warnings: ["The invoice becomes legally binding."],
      irreversible: false,
    },
    callId: "call-1",
    ...overrides,
  };
}

/** Log lines as `event {fields}` strings. */
export interface CapturedLog extends HttpLog {
  readonly lines: string[];
}

export function captureLog(): CapturedLog {
  const lines: string[] = [];
  const write = (level: string, event: string, fields?: LogFields): void => {
    lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
  };
  return {
    lines,
    info(event, fields) {
      write("info", event, fields);
    },
    warn(event, fields) {
      write("warn", event, fields);
    },
  };
}

/** Token buckets on `now`, as the real limiter keeps them (family + key). */
function createLimiter(now: () => number): (rule: RateRule, key: string) => boolean {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (rule, key) => {
    const burst = rule.burst ?? rule.perMinute;
    const id = `${rule.name}|${key}`;
    const at = now();
    const bucket = buckets.get(id) ?? { tokens: burst, at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 60_000) * rule.perMinute);
    bucket.at = at;
    buckets.set(id, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

export interface ContextOptions {
  readonly now: () => number;
  readonly log?: HttpLog;
  readonly clientIp?: string;
  readonly origin?: string;
  readonly signal?: AbortSignal;
}

/** A request context with a shared limiter (one per test, like the router's). */
export function contextFactory(
  options: ContextOptions,
): (overrides?: Partial<HttpRequestContext>) => HttpRequestContext {
  const limit = createLimiter(options.now);
  const log = options.log ?? captureLog();
  return (overrides = {}) => ({
    clientIp: options.clientIp ?? "203.0.113.7",
    origin: options.origin ?? ORIGIN,
    signal: options.signal ?? new AbortController().signal,
    log,
    limit,
    ...overrides,
  });
}

/**
 * Matches `request` against `routes` (exact paths first, then prefixes) and runs the handler;
 * 404 and 405 like the real router. Nothing else of the router is played here.
 */
export async function dispatch(
  routes: readonly HttpRoute[],
  request: Request,
  ctx: HttpRequestContext,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const route =
    routes.find(
      (candidate) => (candidate.match ?? "exact") === "exact" && candidate.path === path,
    ) ??
    routes.find((candidate) => candidate.match === "prefix" && path.startsWith(candidate.path));
  if (route === undefined) return new Response("not found", { status: 404 });
  if (!route.methods.includes(request.method)) {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: route.methods.join(", ") },
    });
  }
  return (await route.handle(request, ctx)) ?? new Response("not found", { status: 404 });
}

/** What the fake browser got back. */
export interface BrowserResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export type Send = (request: Request) => Promise<Response>;

/**
 * A browser for the inbox: keeps cookies (by name, honoring `Max-Age=0`), sends them with every
 * request, and submits forms with the headers a browser sets for a same-origin form POST.
 * `headers` overrides replace (or with `undefined` remove) those headers.
 */
export class RemoteBrowser {
  readonly jar = new Map<string, string>();
  readonly responses: BrowserResponse[] = [];
  /** The `Accept-Language` the browser sends; none by default (the pages then answer in English). */
  language: string | undefined;

  constructor(
    private readonly send: Send,
    readonly origin = ORIGIN,
  ) {}

  async get(path: string): Promise<BrowserResponse> {
    return this.request(new Request(`${this.origin}${path}`, { headers: this.baseHeaders() }));
  }

  async post(
    path: string,
    fields: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string | undefined>> = {},
  ): Promise<BrowserResponse> {
    const sent: Record<string, string | undefined> = {
      Origin: this.origin,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Content-Type": "application/x-www-form-urlencoded",
      ...this.baseHeaders(),
      ...headers,
    };
    const finalHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(sent)) {
      if (value !== undefined) finalHeaders[name] = value;
    }
    return this.request(
      new Request(`${this.origin}${path}`, {
        method: "POST",
        headers: finalHeaders,
        body: new URLSearchParams(fields).toString(),
      }),
    );
  }

  /** Signs in with `token` on the inbox's form. */
  signIn(token: string): Promise<BrowserResponse> {
    return this.post("/approvals/login", { token });
  }

  /** Opens `path` and submits its form with `decision` and the page's CSRF tag. */
  async decide(path: string, decision: string): Promise<BrowserResponse> {
    const page = await this.get(path);
    return this.post(path, { csrf: csrfOf(page.body) ?? "", decision });
  }

  /** Sets a cookie from a `Set-Cookie` value, as the browser would on a response. */
  accept(setCookie: string): void {
    const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (attributes.some((attribute) => attribute.toLowerCase() === "max-age=0")) {
      this.jar.delete(name);
    } else {
      this.jar.set(name, value);
    }
  }

  private baseHeaders(): Record<string, string> {
    return {
      ...(this.language === undefined ? {} : { "Accept-Language": this.language }),
      ...(this.jar.size === 0
        ? {}
        : { Cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ") }),
    };
  }

  private async request(request: Request): Promise<BrowserResponse> {
    const response = await this.send(request);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) this.accept(setCookie);
    const result = {
      status: response.status,
      headers: response.headers,
      body: await response.text(),
    };
    this.responses.push(result);
    return result;
  }
}

/** The CSRF tag of the page's form, if any. */
export function csrfOf(html: string): string | undefined {
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1];
}

/** The detail-page links of the inbox list. */
export function inboxLinks(html: string): string[] {
  return [...html.matchAll(/<a href="(\/approvals\/[A-Za-z0-9_-]+)">/g)].map(
    (match) => match[1] ?? "",
  );
}
