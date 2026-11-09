/**
 * scripts/pin-plugin-version.ts pins the image tag in server.json and checks every file that
 * carries the release version; the repository's own files pass that check. The deploy templates
 * and the Dockerfile are checked here too: their image tags are bumped by release-please
 * (`x-release-please-version` markers, registered as generic extra-files), so a missing marker or
 * registration would leave a template on an old release. `pinPackageArgument` is tested with the
 * plugin (test/unit/plugin/plugin.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  pinImageTag,
  type ReleaseFiles,
  releaseVersionProblems,
} from "../../../scripts/pin-plugin-version.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGE = "ghcr.io/jaylann/mcp-server-sevdesk";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const packageJson = z
  .object({ name: z.string(), version: z.string(), mcpName: z.string() })
  .parse(JSON.parse(read("package.json")));

/** A consistent set of release files at `version`, with `edit` applied to server.json. */
function releaseFiles(
  version: string,
  edit: (server: {
    [key: string]: unknown;
    packages: Record<string, unknown>[];
  }) => void = () => {},
): ReleaseFiles {
  const server = {
    name: "io.github.jaylann/mcp-server-sevdesk",
    version,
    packages: [
      { registryType: "npm", identifier: "mcp-server-sevdesk", version },
      { registryType: "oci", identifier: `${IMAGE}:${version}` },
    ] as Record<string, unknown>[],
  };
  edit(server);
  return {
    packageJson: JSON.stringify({
      name: "mcp-server-sevdesk",
      version,
      mcpName: "io.github.jaylann/mcp-server-sevdesk",
    }),
    serverJson: JSON.stringify(server),
    pluginJson: JSON.stringify({ name: "sevdesk", version }),
    mcpJson: JSON.stringify({
      mcpServers: { sevdesk: { command: "npx", args: ["-y", `mcp-server-sevdesk@${version}`] } },
    }),
    mcpbManifest: JSON.stringify({
      manifest_version: "0.3",
      name: "mcp-server-sevdesk",
      version,
    }),
  };
}

describe("pinImageTag", () => {
  const text = `{
  "packages": [
    { "registryType": "npm", "identifier": "mcp-server-sevdesk", "version": "0.3.1" },
    { "registryType": "oci", "identifier": "${IMAGE}:0.3.1" }
  ]
}
`;

  it("rewrites the OCI tag and keeps every other byte", () => {
    expect(pinImageTag(text, "0.4.0")).toBe(text.replace(`${IMAGE}:0.3.1`, `${IMAGE}:0.4.0`));
    expect(pinImageTag(text, "1.0.0-rc.1")).toContain(`"${IMAGE}:1.0.0-rc.1"`);
    expect(pinImageTag(text, "0.3.1")).toBe(text);
  });

  it("refuses a malformed version", () => {
    expect(() => pinImageTag(text, "latest")).toThrow('Unexpected version "latest".');
    expect(() => pinImageTag(text, '1.0.0"]')).toThrow("Unexpected version");
  });

  it("needs exactly one OCI package with a registry/path:tag identifier", () => {
    expect(() => pinImageTag('{"packages": []}', "0.4.0")).toThrow(
      "Expected exactly one OCI package with an identifier in server.json, found 0.",
    );
    const twice = JSON.stringify({
      packages: [
        { registryType: "oci", identifier: `${IMAGE}:1.0.0` },
        { registryType: "oci", identifier: `${IMAGE}:1.0.0` },
      ],
    });
    expect(() => pinImageTag(twice, "0.4.0")).toThrow("found 2");
    for (const identifier of [`${IMAGE}@sha256:${"a".repeat(64)}`, "mcp-server-sevdesk:1.0.0"]) {
      const server = JSON.stringify({ packages: [{ registryType: "oci", identifier }] });
      expect(() => pinImageTag(server, "0.4.0")).toThrow("is not registry/path:tag");
    }
  });

  it("refuses to guess when the identifier also appears elsewhere", () => {
    const server = JSON.stringify({
      packages: [{ registryType: "oci", identifier: `${IMAGE}:0.1.0` }],
      _meta: { image: `${IMAGE}:0.1.0` },
    });
    expect(() => pinImageTag(server, "0.4.0")).toThrow(
      `Expected "${IMAGE}:…" exactly once in server.json, found 2.`,
    );
  });
});

describe("releaseVersionProblems", () => {
  it("accepts files that all carry the version", () => {
    expect(releaseVersionProblems(releaseFiles("0.4.0"), "0.4.0", IMAGE)).toEqual([]);
    expect(releaseVersionProblems(releaseFiles("0.4.0"), "0.4.0")).toEqual([]);
  });

  it("names every file that lags behind", () => {
    expect(releaseVersionProblems(releaseFiles("0.3.1"), "0.4.0")).toEqual([
      'package.json version is "0.3.1", expected "0.4.0".',
      'server.json version is "0.3.1", expected "0.4.0".',
      'plugin/.claude-plugin/plugin.json version is "0.3.1", expected "0.4.0".',
      'mcpb/manifest.json version is "0.3.1", expected "0.4.0".',
      'server.json npm package version is "0.3.1", expected "0.4.0".',
      'server.json OCI image tag is "0.3.1", expected "0.4.0".',
      'plugin/.mcp.json pin is "0.3.1", expected "0.4.0".',
    ]);
  });

  it("checks the OCI package's form and repository", () => {
    const files = releaseFiles("0.4.0", (server) => {
      server.packages[1] = {
        registryType: "oci",
        identifier: `ghcr.io/someone/else:0.4.0`,
        version: "0.4.0",
        registryBaseUrl: "https://ghcr.io",
      };
    });
    expect(releaseVersionProblems(files, "0.4.0", IMAGE)).toEqual([
      `server.json OCI image is "ghcr.io/someone/else", expected "${IMAGE}".`,
      'server.json OCI package must not have "version" (the tag is the version).',
      'server.json OCI package must not have "registryBaseUrl" (the tag is the version).',
    ]);
    const digest = releaseFiles("0.4.0", (server) => {
      server.packages[1] = { registryType: "oci", identifier: `${IMAGE}@sha256:${"a".repeat(64)}` };
    });
    expect(releaseVersionProblems(digest, "0.4.0")).toEqual([
      `server.json OCI identifier "${IMAGE}@sha256:${"a".repeat(64)}" is not registry/path:tag.`,
    ]);
  });

  it("needs exactly one npm and one OCI package, and the package's mcpName", () => {
    const files = releaseFiles("0.4.0", (server) => {
      server["name"] = "io.github.someone/else";
      server.packages = [
        { registryType: "npm", identifier: "other-package", version: "0.4.0" },
        { registryType: "oci", identifier: `${IMAGE}:0.4.0` },
        { registryType: "oci", identifier: `${IMAGE}:0.4.0` },
      ];
    });
    expect(releaseVersionProblems(files, "0.4.0")).toEqual([
      'server.json name "io.github.someone/else" differs from package.json mcpName "io.github.jaylann/mcp-server-sevdesk".',
      'server.json npm package is "other-package", expected "mcp-server-sevdesk".',
      "server.json must list exactly one OCI package.",
    ]);
    const none = releaseFiles("0.4.0", (server) => {
      server.packages = [];
    });
    expect(releaseVersionProblems(none, "0.4.0")).toEqual([
      "server.json must list exactly one npm package.",
      "server.json must list exactly one OCI package.",
    ]);
  });

  it("reports a missing plugin pin", () => {
    const files = { ...releaseFiles("0.4.0"), mcpJson: '{"mcpServers": {}}' };
    expect(releaseVersionProblems(files, "0.4.0")).toEqual([
      'plugin/.mcp.json pin is undefined, expected "0.4.0".',
    ]);
  });

  it("reports a .mcpb manifest on another version or without one", () => {
    const lagging = { ...releaseFiles("0.4.0"), mcpbManifest: '{"version": "0.3.1"}' };
    expect(releaseVersionProblems(lagging, "0.4.0")).toEqual([
      'mcpb/manifest.json version is "0.3.1", expected "0.4.0".',
    ]);
    const missing = { ...releaseFiles("0.4.0"), mcpbManifest: "{}" };
    expect(releaseVersionProblems(missing, "0.4.0")).toEqual([
      'mcpb/manifest.json version is undefined, expected "0.4.0".',
    ]);
  });

  it("passes for this repository's files", () => {
    const files: ReleaseFiles = {
      packageJson: read("package.json"),
      serverJson: read("server.json"),
      pluginJson: read("plugin/.claude-plugin/plugin.json"),
      mcpJson: read("plugin/.mcp.json"),
      mcpbManifest: read("mcpb/manifest.json"),
    };
    expect(releaseVersionProblems(files, packageJson.version, IMAGE)).toEqual([]);
    expect(pinImageTag(files.serverJson, packageJson.version)).toBe(files.serverJson);
  });
});

describe("server.json OCI package", () => {
  const environment = z.array(z.object({ name: z.string() }).loose());
  const server = z
    .object({
      packages: z.array(
        z
          .object({
            registryType: z.string(),
            environmentVariables: environment,
            packageArguments: z.array(z.unknown()).optional(),
          })
          .loose(),
      ),
    })
    .parse(JSON.parse(read("server.json")));
  const npm = server.packages.find((entry) => entry.registryType === "npm");
  const oci = server.packages.find((entry) => entry.registryType === "oci");

  it("runs the image over stdio with the npm package's settings", () => {
    expect(server.packages.map((entry) => entry.registryType)).toEqual(["npm", "oci"]);
    expect(oci).toMatchObject({ runtimeHint: "docker", transport: { type: "stdio" } });
    // The image's default command is --http; registry clients start it over stdio.
    expect(oci?.packageArguments).toEqual([
      expect.objectContaining({ type: "positional", value: "--stdio" }),
    ]);
    expect(oci?.environmentVariables.map((variable) => variable.name)).toEqual(
      npm?.environmentVariables.map((variable) => variable.name),
    );
  });
});

describe("deploy templates and the Dockerfile", () => {
  const releaseConfig = z
    .object({
      packages: z.object({
        ".": z.object({
          "extra-files": z.array(z.object({ type: z.string(), path: z.string() }).loose()),
        }),
      }),
    })
    .parse(JSON.parse(read("release-please-config.json")));
  const generic = releaseConfig.packages["."]["extra-files"]
    .filter((file) => file.type === "generic")
    .map((file) => file.path);
  const deployFiles = readdirSync(join(ROOT, "deploy"), { recursive: true, encoding: "utf8" })
    .map((entry) => join(ROOT, "deploy", entry))
    .filter((path) => statSync(path).isFile())
    .map((path) => relative(ROOT, path).split("\\").join("/"));
  const PINNED_TAG = new RegExp(
    `${IMAGE.replaceAll(".", String.raw`\.`)}:(\\d+\\.\\d+\\.\\d+[\\w.+-]*)`,
  );

  it("pin the image to this version on lines release-please updates", () => {
    const pinned = new Set<string>();
    for (const path of deployFiles) {
      for (const line of read(path).split("\n")) {
        const tag = PINNED_TAG.exec(line)?.[1];
        if (tag === undefined) continue;
        pinned.add(path);
        expect(tag, `${path}: ${line.trim()}`).toBe(packageJson.version);
        expect(line, `${path} needs an x-release-please-version marker`).toContain(
          "x-release-please-version",
        );
      }
    }
    expect([...pinned].sort()).toEqual([
      "deploy/README.md",
      "deploy/compose/compose.yaml",
      "deploy/fly/fly.toml",
      "deploy/render/render.yaml",
    ]);
    for (const path of pinned) {
      expect(
        generic,
        `${path} must be a generic extra-file in release-please-config.json`,
      ).toContain(path);
    }
    for (const path of generic) {
      expect(read(path), path).toContain("x-release-please-version");
    }
  });

  it("pin every third-party image by digest", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1@sha256:[0-9a-f]{64}$/m);
    const bases = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map((m) => m[1]);
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      if (base === "base") continue; // an earlier stage
      expect(base, `FROM ${base ?? ""}`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    const composeImages = [
      ...read("deploy/compose/compose.yaml").matchAll(/^\s+image: (\S+)/gm),
    ].map((m) => m[1] ?? "");
    for (const image of composeImages.filter((name) => !name.startsWith(`${IMAGE}:`))) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("labels the image with the registry name and runs it as the non-root user", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain(`io.modelcontextprotocol.server.name="${packageJson.mcpName}"`);
    expect(dockerfile).toMatch(/^USER 65532:65532$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/nodejs\/bin\/node", "\/app\/dist\/index\.js"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["--http"\]$/m);
  });
});
