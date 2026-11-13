import { readFileSync } from "node:fs";

import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { registryWithBundle } from "../../../scripts/prepare-registry.js";

const source = z
  .object({
    $schema: z.string(),
    version: z.string(),
    packages: z.array(z.record(z.string(), z.unknown())),
  })
  .loose()
  .parse(JSON.parse(readFileSync(new URL("../../../server.json", import.meta.url), "utf8")));
const schema = z
  .object({ $id: z.string() })
  .loose()
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../spec/mcp-registry/server.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
// The upstream schema uses OpenAPI annotation keywords as well as JSON Schema draft-07.
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uri", (value: string) => URL.canParse(value));
const validate = ajv.compile(schema);
const manifest = { name: "mcp-server-sevdesk", version: source.version };
const bundle = Buffer.from("abc");
const tag = `v${source.version}`;

describe("registry manifest for a release bundle", () => {
  it("preserves the source and adds a package accepted by the official pinned schema", () => {
    const before = structuredClone(source);
    const result = registryWithBundle(source, manifest, bundle, source.version, tag);
    expect(result).toEqual({
      ...source,
      packages: [
        ...source.packages,
        {
          registryType: "mcpb",
          identifier: `https://github.com/jaylann/mcp-server-sevdesk/releases/download/${tag}/mcp-server-sevdesk-${source.version}.mcpb`,
          // SHA-256 test vector for "abc", independent of the generator's hash implementation.
          fileSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          transport: { type: "stdio" },
        },
      ],
    });
    expect(source).toEqual(before);
    expect(schema.$id).toBe(source.$schema);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });

  it("recomputes the URL and checksum for the next release and for replaced asset bytes", () => {
    const next = "9.8.7-rc.1";
    const updated = {
      ...source,
      version: next,
      packages: source.packages.map((entry) =>
        entry["registryType"] === "npm"
          ? { ...entry, version: next }
          : { ...entry, identifier: `ghcr.io/jaylann/mcp-server-sevdesk:${next}` },
      ),
    };
    const result = registryWithBundle(
      updated,
      { ...manifest, version: next },
      Buffer.from("changed release asset"),
      next,
      `v${next}`,
    );
    expect(result).toMatchObject({
      packages: [
        ...updated.packages,
        {
          identifier: `https://github.com/jaylann/mcp-server-sevdesk/releases/download/v${next}/mcp-server-sevdesk-${next}.mcpb`,
        },
      ],
    });
    const packages = z.array(z.record(z.string(), z.unknown())).parse(result["packages"]);
    expect(packages.at(-1)?.["fileSha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("ba7816bf8f01cfea414140de5dae2223b0");
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(["", "latest", "../1.0.0", "1.0.0/asset"])("refuses invalid version %j", (version) => {
    expect(() => registryWithBundle(source, manifest, bundle, version, `v${version}`)).toThrow(
      "release version",
    );
  });

  it("refuses a mismatched tag, source version, identity or bundle manifest", () => {
    expect(() => registryWithBundle(source, manifest, bundle, source.version, "v0.0.1")).toThrow(
      "v-prefixed tag",
    );
    for (const change of [
      { version: "0.0.1" },
      { name: "io.github.other/server" },
      { repository: { url: "https://github.com/other/server" } },
    ]) {
      expect(() =>
        registryWithBundle({ ...source, ...change }, manifest, bundle, source.version, tag),
      ).toThrow("server.json must identify");
    }
    for (const change of [{ version: "0.0.1" }, { name: "other-server" }]) {
      expect(() =>
        registryWithBundle(source, { ...manifest, ...change }, bundle, source.version, tag),
      ).toThrow("bundle manifest must identify");
    }
  });

  it("refuses empty bytes, malformed inputs and stale template entries", () => {
    expect(() =>
      registryWithBundle(source, manifest, new Uint8Array(), source.version, tag),
    ).toThrow("bundle is empty");
    for (const malformed of [null, [], "text", 0]) {
      expect(() => registryWithBundle(malformed, manifest, bundle, source.version, tag)).toThrow(
        "JSON object",
      );
      expect(() => registryWithBundle(source, malformed, bundle, source.version, tag)).toThrow(
        "JSON object",
      );
    }
    for (const packages of [undefined, [], {}]) {
      expect(() =>
        registryWithBundle({ ...source, packages }, manifest, bundle, source.version, tag),
      ).toThrow("existing registry packages");
    }
    const prepared = registryWithBundle(source, manifest, bundle, source.version, tag);
    expect(() => registryWithBundle(prepared, manifest, bundle, source.version, tag)).toThrow(
      "precomputed MCPB entry",
    );
  });

  it("has a schema validator that rejects invalid checksums and missing transports", () => {
    const result = registryWithBundle(source, manifest, bundle, source.version, tag);
    for (const entry of [
      { registryType: "mcpb", identifier: "https://example.com/server.mcpb" },
      {
        registryType: "mcpb",
        identifier: "https://example.com/server.mcpb",
        fileSha256: "wrong",
        transport: { type: "stdio" },
      },
    ]) {
      expect(validate({ ...result, packages: [...source.packages, entry] })).toBe(false);
    }
  });
});
