/**
 * The discovery documents of OAuth mode, served without authentication and with CORS `*`:
 * - RFC 9728 protected resource metadata at `/.well-known/oauth-protected-resource/mcp` (the
 *   path-aware form, via the SDK) and at `/.well-known/oauth-protected-resource` (the root form
 *   some clients probe);
 * - RFC 8414 authorization server metadata at `/.well-known/oauth-authorization-server`.
 *
 * The authorization server metadata is what makes claude.ai use CIMD instead of registration:
 * `client_id_metadata_document_supported: true` and `"none"` as the token endpoint auth method.
 * It also advertises S256 only, `iss` in authorization responses (RFC 9207), revocation, and no
 * registration endpoint.
 */
import {
  buildOAuthProtectedResourceMetadata,
  type OAuthMetadata,
  oauthMetadataResponse,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

import type { Tier } from "../../safety/tiers.js";
import type { HttpRoute } from "../types.js";
import { OFFLINE_ACCESS, scopeOf } from "./tokens.js";

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
const DOCUMENTATION_URL = "https://sevdesk-mcp.lanfermann.dev/docs/en/remote";

export interface MetadataOptions {
  /** The public origin, which is also the issuer. */
  readonly origin: string;
  /** The MCP endpoint, `<origin>/mcp`. */
  readonly resource: string;
  /** Tiers this server may grant (`SEVDESK_ALLOW`). */
  readonly allowedTiers: ReadonlySet<Tier>;
}

/** The RFC 8414 document. */
export function authorizationServerMetadata(options: MetadataOptions): OAuthMetadata {
  const scopes = scopeOf(options.allowedTiers).split(" ");
  return {
    issuer: options.origin,
    authorization_endpoint: `${options.origin}/authorize`,
    token_endpoint: `${options.origin}/token`,
    revocation_endpoint: `${options.origin}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...scopes, OFFLINE_ACCESS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: DOCUMENTATION_URL,
  };
}

function sdkOptions(options: MetadataOptions) {
  return {
    oauthMetadata: authorizationServerMetadata(options),
    resourceServerUrl: new URL(options.resource),
    scopesSupported: scopeOf(options.allowedTiers).split(" "),
    resourceName: "sevDesk (mcp-server-sevdesk)",
    serviceDocumentationUrl: new URL(DOCUMENTATION_URL),
    // http is only possible on a loopback origin (the configuration refuses anything else).
    dangerouslyAllowInsecureIssuerUrl: options.origin.startsWith("http://"),
  };
}

/** The RFC 9728 document. */
export function protectedResourceMetadata(
  options: MetadataOptions,
): OAuthProtectedResourceMetadata {
  return buildOAuthProtectedResourceMetadata(sdkOptions(options));
}

const CORS_METHODS = "GET, HEAD, OPTIONS";

/** The root-path copy of the protected resource document (same answers as the SDK's). */
function rootDocument(request: Request, document: OAuthProtectedResourceMetadata): Response {
  if (request.method === "OPTIONS") {
    const requested = request.headers.get("access-control-request-headers");
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": CORS_METHODS,
        ...(requested === null
          ? {}
          : { "Access-Control-Allow-Headers": requested, Vary: "Access-Control-Request-Headers" }),
      },
    });
  }
  const response = Response.json(document, { headers: { "Access-Control-Allow-Origin": "*" } });
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

/** The three metadata routes. */
export function metadataRoutes(options: MetadataOptions): HttpRoute[] {
  const sdk = sdkOptions(options);
  // Built once at startup, so a misconfigured issuer fails before the first request.
  const document = buildOAuthProtectedResourceMetadata(sdk);
  const resourcePath = new URL(options.resource).pathname;
  const common = {
    methods: ["GET", "HEAD", "OPTIONS"],
    maxBodyBytes: 1024,
    origin: "none",
    rateLimit: { name: "oauth-metadata", perMinute: 120 },
  } as const;
  return [
    {
      ...common,
      path: `${PROTECTED_RESOURCE_PATH}${resourcePath}`,
      handle: (request) => Promise.resolve(oauthMetadataResponse(request, sdk)),
    },
    {
      ...common,
      path: PROTECTED_RESOURCE_PATH,
      handle: (request) => Promise.resolve(rootDocument(request, document)),
    },
    {
      ...common,
      path: AUTHORIZATION_SERVER_PATH,
      handle: (request) => Promise.resolve(oauthMetadataResponse(request, sdk)),
    },
  ];
}
