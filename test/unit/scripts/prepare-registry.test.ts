import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv } from "ajv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  failureMessage,
  main,
  RegistryInputError,
  registryWithBundle,
} from "../../../scripts/prepare-registry.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });

const source = z
  .object({
    $schema: z.string(),
    version: z.string(),
    packages: z.array(z.record(z.string(), z.unknown())),
  })
  .loose()
  .parse(JSON.parse(fs.readFileSync(new URL("../../../server.json", import.meta.url), "utf8")));
const schema = z
  .object({ $id: z.string() })
  .loose()
  .parse(
    JSON.parse(
      fs.readFileSync(
        new URL("../../../spec/mcp-registry/server.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
/** The Desktop extension's icon, read before any test mocks `node:fs`. */
const png = fs.readFileSync(new URL("../../../mcpb/icon.png", import.meta.url));
// The upstream schema uses OpenAPI annotation keywords as well as JSON Schema draft-07.
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uri", (value: string) => URL.canParse(value));
const validate = ajv.compile(schema);
const manifest = { name: "mcp-server-sevdesk", version: source.version };
const bundle = Buffer.from("abc");
const tag = `v${source.version}`;
const failurePrefix =
  "Could not prepare the registry manifest. Check the version, tag, bundle and output path.";
const untrustedMarker = "UNTRUSTED_BUNDLE_CONTENT";
const RAW_FILES = "https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk";
/** The icons of the source, from `main`. */
const sourceIcons = z.array(z.record(z.string(), z.unknown())).parse(source["icons"]);

/** The source's icons as a release `ref` serves them. */
function iconsAt(ref: string): Record<string, unknown>[] {
  return sourceIcons.map((icon) => ({
    ...icon,
    src: String(icon["src"]).replace(`${RAW_FILES}/main/`, `${RAW_FILES}/${ref}/`),
  }));
}

function reportedFailure(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryInputError);
    return failureMessage(error);
  }
  throw new Error("Expected registry preparation to fail.");
}

describe("registry failure messages", () => {
  it("prints fixed input diagnostics without printing their cause", () => {
    const error = new RegistryInputError("The bundle is empty.", {
      cause: new Error(untrustedMarker),
    });
    expect(failureMessage(error)).toBe(`${failurePrefix} The bundle is empty.`);
  });

  it.each([
    new SyntaxError(`Unexpected token in ${untrustedMarker}`),
    Object.assign(new Error(`Command failed: unzip -p /${untrustedMarker}/bundle.mcpb`), {
      stderr: Buffer.from(untrustedMarker),
    }),
    Object.assign(new Error(`ENOENT: no such file or directory, open '/${untrustedMarker}'`), {
      code: "ENOENT",
    }),
    new TypeError(untrustedMarker),
  ])("reports only the error name for an unexpected $name", (error) => {
    const message = failureMessage(error);
    expect(message).toBe(`${failurePrefix} Unexpected error (${error.name}).`);
    expect(message).not.toContain(untrustedMarker);
  });

  it.each([undefined, null, untrustedMarker, { message: untrustedMarker }])(
    "does not stringify a non-Error value (%j)",
    (error) => {
      expect(failureMessage(error)).toBe(`${failurePrefix} Unexpected error.`);
    },
  );

  // Older supported Node versions cannot run .ts files without enabling type stripping.
  it.skipIf(!process.features.typescript)(
    "prints the diagnostic to stderr and exits with status 1 through the plain-Node entry point",
    () => {
      const script = fileURLToPath(
        new URL("../../../scripts/prepare-registry.ts", import.meta.url),
      );
      const result = childProcess.spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `${failurePrefix} usage: prepare-registry.ts <version> <tag> <bundle> <output>\n`,
      );
    },
  );
});

describe("registry preparation steps", () => {
  const argv = [
    source.version,
    tag,
    `mcp-server-sevdesk-${source.version}.mcpb`,
    "out/server.json",
  ];

  beforeEach(() => {
    vi.spyOn(fs, "readFileSync")
      .mockReturnValueOnce(bundle)
      .mockReturnValueOnce(JSON.stringify(source));
    vi.spyOn(childProcess, "execFileSync").mockReturnValue(JSON.stringify(manifest));
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "writeFileSync").mockReturnValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it.each([
    ["bundle read", "The bundle file is not readable."],
    ["unzip", "unzip could not read manifest.json from the bundle."],
    ["manifest JSON", "The bundle's manifest is not valid JSON."],
    ["server read", "server.json is not readable."],
    ["server JSON", "server.json is not valid JSON."],
    ["output directory", "Could not write the prepared registry manifest."],
    ["output write", "Could not write the prepared registry manifest."],
  ])("reports a fixed diagnostic for %s failures", (step, detail) => {
    const fail = () => {
      throw Object.assign(new Error(`Command or path: ${untrustedMarker}`), {
        stderr: Buffer.from(untrustedMarker),
      });
    };
    switch (step) {
      case "bundle read":
        vi.mocked(fs.readFileSync).mockReset().mockImplementationOnce(fail);
        break;
      case "unzip":
        vi.mocked(childProcess.execFileSync).mockImplementationOnce(fail);
        break;
      case "manifest JSON":
        vi.mocked(childProcess.execFileSync).mockReturnValueOnce(untrustedMarker);
        break;
      case "server read":
        vi.mocked(fs.readFileSync)
          .mockReset()
          .mockReturnValueOnce(bundle)
          .mockImplementationOnce(fail);
        break;
      case "server JSON":
        vi.mocked(fs.readFileSync)
          .mockReset()
          .mockReturnValueOnce(bundle)
          .mockReturnValueOnce(untrustedMarker);
        break;
      case "output directory":
        vi.mocked(fs.mkdirSync).mockImplementationOnce(fail);
        break;
      case "output write":
        vi.mocked(fs.writeFileSync).mockImplementationOnce(fail);
        break;
      default:
        throw new Error("Unknown test step.");
    }

    const message = reportedFailure(() => {
      main(argv);
    });
    expect(message).toBe(`${failurePrefix} ${detail}`);
    expect(message).not.toContain(untrustedMarker);
    expect(console.log).not.toHaveBeenCalled();
    if (step !== "output write") expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("reports usage and filename checks before accessing files", () => {
    expect(
      reportedFailure(() => {
        main([]);
      }),
    ).toBe(`${failurePrefix} usage: prepare-registry.ts <version> <tag> <bundle> <output>`);
    expect(
      reportedFailure(() => {
        main([source.version, tag, "wrong.mcpb", "out.json"]);
      }),
    ).toBe(`${failurePrefix} The bundle filename must match the release version.`);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it("writes the prepared document when all steps succeed", () => {
    main(argv);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "out/server.json",
      `${JSON.stringify(registryWithBundle(source, manifest, bundle, source.version, tag), null, 2)}\n`,
    );
    expect(console.log).toHaveBeenCalledOnce();
  });
});

describe("registry manifest for a release bundle", () => {
  it("preserves the source and adds a package accepted by the official pinned schema", () => {
    const before = structuredClone(source);
    const result = registryWithBundle(source, manifest, bundle, source.version, tag);
    expect(result).toEqual({
      ...source,
      icons: iconsAt(tag),
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
      icons: iconsAt(`v${next}`),
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

  it("declares the extension's icon over HTTPS, as the registry schema requires", () => {
    const { icons } = z.object({ icons: z.array(z.record(z.string(), z.unknown())) }).parse(source);

    expect(icons).toEqual([
      {
        src: "https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/main/mcpb/icon.png",
        mimeType: "image/png",
        sizes: [`${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`],
      },
    ]);
    expect(validate(source), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...source, icons: [{ src: "not a uri" }] })).toBe(false);
  });

  it("pins the icon to the release tag, so the registry keeps the released icon", () => {
    const result = registryWithBundle(source, manifest, bundle, source.version, tag);

    expect(result["icons"]).toEqual([
      {
        src: `https://raw.githubusercontent.com/jaylann/mcp-server-sevdesk/v${source.version}/mcpb/icon.png`,
        mimeType: "image/png",
        sizes: sourceIcons[0]?.["sizes"],
      },
    ]);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(source.icons).toEqual(sourceIcons);
  });

  it("keeps icons from elsewhere and a source without icons as they are", () => {
    const elsewhere = { src: "https://example.com/icon.svg", mimeType: "image/svg+xml" };
    const result = registryWithBundle(
      { ...source, icons: [...sourceIcons, elsewhere] },
      manifest,
      bundle,
      source.version,
      tag,
    );
    expect(result["icons"]).toEqual([...iconsAt(tag), elsewhere]);

    const { icons: _icons, ...withoutIcons } = source;
    expect(
      registryWithBundle(withoutIcons, manifest, bundle, source.version, tag),
    ).not.toHaveProperty("icons");
  });

  it("refuses an icon of this repository already pinned to a ref, and malformed icons", () => {
    const prepared = registryWithBundle(source, manifest, bundle, source.version, tag);
    const { packages: _packages, ...pinned } = prepared;
    expect(() =>
      registryWithBundle(
        { ...pinned, packages: source.packages },
        manifest,
        bundle,
        source.version,
        tag,
      ),
    ).toThrow("icons from this repository must point at main");
    for (const icons of [{}, "icon.png"]) {
      expect(() =>
        registryWithBundle({ ...source, icons }, manifest, bundle, source.version, tag),
      ).toThrow("icons must be a list");
    }
    expect(() =>
      registryWithBundle({ ...source, icons: ["icon.png"] }, manifest, bundle, source.version, tag),
    ).toThrow("JSON object");
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
