import { describe, expect, it } from "vitest";

import {
  authorizationServerMetadata,
  metadataRoutes,
  protectedResourceMetadata,
} from "../../../../src/http/oauth/metadata.js";
import { captureLog, createTestRouter, ORIGIN, RESOURCE } from "../../../helpers/oauth-browser.js";

const options = {
  origin: ORIGIN,
  resource: RESOURCE,
  allowedTiers: new Set(["read", "commit"] as const),
};

describe("OAuth metadata", () => {
  it("advertises CIMD, public clients, S256 only, iss and revocation; no registration", () => {
    const metadata = authorizationServerMetadata(options);
    expect(metadata).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      revocation_endpoint: `${ORIGIN}/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["sevdesk:read", "sevdesk:commit", "offline_access"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://sevdesk-mcp.lanfermann.dev/docs/en/remote",
    });
    expect(metadata).not.toHaveProperty("registration_endpoint");
  });

  it("names the issuer as the only authorization server of the resource", () => {
    expect(protectedResourceMetadata(options)).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["sevdesk:read", "sevdesk:commit"],
      resource_name: "sevDesk (mcp-server-sevdesk)",
    });
  });

  it("serves the documents with CORS * at the path-aware and the root well-known paths", async () => {
    const fetch = createTestRouter(metadataRoutes(options), { log: captureLog() });
    const pathAware = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const root = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(pathAware.status).toBe(200);
    expect(pathAware.headers.get("access-control-allow-origin")).toBe("*");
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect(await root.json()).toEqual(await pathAware.json());
    const as = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(((await as.json()) as { issuer: string }).issuer).toBe(ORIGIN);

    const head = await fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`, { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const preflight = await fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "OPTIONS",
          headers: { "Access-Control-Request-Headers": "mcp-protocol-version" },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toBe("mcp-protocol-version");
    }
    const plain = await fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`, { method: "OPTIONS" }),
    );
    expect(plain.headers.get("access-control-allow-headers")).toBeNull();
    expect(
      (
        await fetch(
          new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, { method: "POST" }),
        )
      ).status,
    ).toBe(405);
  });

  it("allows an http issuer only as configured for loopback", () => {
    const origin = "http://[::1]:8080";
    expect(
      protectedResourceMetadata({ ...options, origin, resource: `${origin}/mcp` }).resource,
    ).toBe(`${origin}/mcp`);
  });
});
