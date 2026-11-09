/**
 * Builds the {@link AccountResolver} a server factory serves requests with.
 *
 * - **fixed** (stdio, bearer): one account, one context, whatever the request carries.
 * - **oauth**: one context per grant's account, sevDesk token and tier set, derived from the
 *   process {@link Settings}. Each context has its own frozen {@link Config} object (the domain
 *   caches in `account-settings.ts`, `receipt-guidance.ts` and `accounts-datev.ts` are keyed by
 *   it, the system-version cache by the client), so accounts never see each other's cached data.
 *   File access is off (`fileDirs: []`, no `outputDir`: the server's disk would be shared by every
 *   grant), `confirmOpen` is off (the browser is the user's, not the server's), and the tiers are
 *   those the user granted that `SEVDESK_ALLOW` also allows.
 *
 * Contexts are kept in an LRU (64 entries, dropped after 15 minutes unused) keyed by
 * `accountId:fingerprint(token):tiers`; the fingerprint is an HMAC with a random per-process key,
 * so the key reveals nothing about the token. Clients of one account share one pacer, so tier
 * variants of an account never exceed its request rate together.
 *
 * Invariant: the token of an OAuth context is a non-enumerable property of its config, so it never
 * appears in `JSON.stringify` or `util.inspect` output of the config or the context.
 */
import { createHmac, randomBytes } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/server";

import type { Config, Deployment, Settings } from "../config.js";
import { type Tier, TIERS } from "../safety/tiers.js";
import {
  createClientPacer,
  createSevdeskClient,
  type SevdeskClientDeps,
} from "../sevdesk/client.js";
import type { Pacer } from "../sevdesk/pacing.js";
import type { SevdeskClient } from "../sevdesk/types.js";
import { type AccountContext, type AccountResolver, grantOf, type VerifiedGrant } from "./types.js";

/** Stdio and bearer mode: every request is served with this one account. */
interface FixedAccountOptions {
  readonly mode: "fixed";
  readonly config: Config;
  readonly client: SevdeskClient;
}

/** OAuth mode: every request carries a {@link VerifiedGrant}; contexts are derived from it. */
export interface OAuthAccountOptions {
  readonly mode: "oauth";
  /** What every account shares (`readSettings`). */
  readonly settings: Settings;
  /** The HTTP deployment (`auth: "oauth"`), copied into every account's config. */
  readonly deployment: Deployment;
  /** Collaborators of each account's sevDesk client (the resolver adds the shared pacer). */
  readonly clientDeps?: Omit<SevdeskClientDeps, "pacer">;
  /**
   * Builds the client of a new context (default: `createSevdeskClient(config, {...clientDeps,
   * pacer})`). Tests return fakes per account.
   */
  readonly createClient?: (config: Config, pacer: Pacer) => SevdeskClient;
  /** Epoch milliseconds, for the idle eviction (tests). */
  readonly now?: () => number;
  /** Most contexts kept (default 64); the least recently used is dropped beyond it. */
  readonly maxContexts?: number;
  /** A context unused for this long is dropped (default 15 minutes). */
  readonly idleMs?: number;
}

export type AccountResolverOptions = FixedAccountOptions | OAuthAccountOptions;

const DEFAULT_MAX_CONTEXTS = 64;
const DEFAULT_IDLE_MS = 15 * 60_000;
/** Bytes of the token fingerprint (128 bit). */
const FINGERPRINT_BYTES = 16;

/** Thrown by an OAuth resolver for a request without a {@link VerifiedGrant}. */
export class MissingGrantError extends Error {
  constructor() {
    super(
      "An MCP request reached the OAuth server without a verified grant; it should have been " +
        "refused by authentication.",
    );
    this.name = "MissingGrantError";
  }
}

export function createAccountResolver(options: AccountResolverOptions): AccountResolver {
  return options.mode === "fixed" ? fixedResolver(options) : oauthResolver(options);
}

function fixedResolver(options: FixedAccountOptions): AccountResolver {
  const context: AccountContext = Object.freeze({
    key: "fixed",
    config: options.config,
    client: options.client,
  });
  return {
    resolve: () => context,
    close: () => undefined,
  };
}

interface Entry {
  readonly context: AccountContext;
  readonly accountId: string;
  lastUsed: number;
}

function oauthResolver(options: OAuthAccountOptions): AccountResolver {
  const { settings, deployment } = options;
  const now = options.now ?? Date.now;
  const maxContexts = Math.max(1, options.maxContexts ?? DEFAULT_MAX_CONTEXTS);
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const createClient =
    options.createClient ??
    ((config: Config, pacer: Pacer) =>
      createSevdeskClient(config, { ...options.clientDeps, pacer }));
  const fingerprintKey = randomBytes(32);
  /** By context key, least recently used first. */
  const entries = new Map<string, Entry>();
  /** One pacer per account with at least one cached context. */
  const pacers = new Map<string, Pacer>();

  function fingerprint(token: string): string {
    return createHmac("sha256", fingerprintKey)
      .update(token, "utf8")
      .digest()
      .subarray(0, FINGERPRINT_BYTES)
      .toString("base64url");
  }

  function drop(key: string, entry: Entry): void {
    entries.delete(key);
    for (const other of entries.values()) {
      if (other.accountId === entry.accountId) return;
    }
    pacers.delete(entry.accountId);
  }

  function evict(at: number): void {
    for (const [key, entry] of entries) {
      if (at - entry.lastUsed < idleMs) break;
      drop(key, entry);
    }
    while (entries.size >= maxContexts) {
      const oldest = entries.entries().next().value;
      if (oldest === undefined) break;
      drop(oldest[0], oldest[1]);
    }
  }

  function create(grant: VerifiedGrant, tiers: ReadonlySet<Tier>, key: string): AccountContext {
    const config = accountConfig(settings, deployment, grant, tiers);
    let pacer = pacers.get(grant.accountId);
    if (pacer === undefined) {
      pacer = createClientPacer(settings, options.clientDeps);
      pacers.set(grant.accountId, pacer);
    }
    return Object.freeze({ key, config, client: createClient(config, pacer) });
  }

  return {
    resolve(authInfo: AuthInfo | undefined) {
      const grant = grantOf(authInfo);
      if (grant === undefined) throw new MissingGrantError();
      const at = now();
      const tiers = new Set(
        TIERS.filter((tier) => grant.tiers.has(tier) && settings.allowedTiers.has(tier)),
      );
      const key = `${grant.accountId}:${fingerprint(grant.token())}:${tierKey(tiers)}`;
      const hit = entries.get(key);
      if (hit !== undefined && at - hit.lastUsed < idleMs) {
        entries.delete(key);
        hit.lastUsed = at;
        entries.set(key, hit);
        return hit.context;
      }
      if (hit !== undefined) drop(key, hit);
      evict(at);
      const context = create(grant, tiers, key);
      entries.set(key, { context, accountId: grant.accountId, lastUsed: at });
      return context;
    },
    close() {
      entries.clear();
      pacers.clear();
    },
  };
}

/** `read+write`: the tiers in {@link TIERS} order. */
export function tierKey(tiers: ReadonlySet<Tier>): string {
  return TIERS.filter((tier) => tiers.has(tier)).join("+");
}

/** The frozen per-account config of an OAuth context (see the module comment). */
function accountConfig(
  settings: Settings,
  deployment: Deployment,
  grant: VerifiedGrant,
  tiers: ReadonlySet<Tier>,
): Config {
  const config = {
    baseUrl: settings.baseUrl,
    allowedTiers: tiers,
    readOnly: settings.readOnly,
    dryRun: settings.dryRun,
    confirm: settings.confirm,
    confirmOpen: false,
    toolsets: settings.toolsets,
    structuredOutput: settings.structuredOutput,
    requestsPerSecond: settings.requestsPerSecond,
    timeoutMs: settings.timeoutMs,
    auditLogPath: settings.auditLogPath,
    outputDir: undefined,
    fileDirs: Object.freeze([]) as readonly string[],
    userAgent: settings.userAgent,
    account: Object.freeze({ id: grant.accountId }),
    deployment,
  };
  // Readable as `config.token`, but left out of JSON.stringify, inspect and spreads.
  Object.defineProperty(config, "token", { value: grant.token(), enumerable: false });
  return Object.freeze(config) as Config;
}
