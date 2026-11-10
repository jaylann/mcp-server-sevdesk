/**
 * The `.mcpb` bundle (Claude Desktop extension): the committed manifest, how Claude Desktop turns
 * its settings into the server's environment (with `getMcpConfigForManifest`, the code Claude
 * Desktop uses), and the checks of scripts/lib/mcpb.ts that `pnpm mcpb` runs. The build itself
 * (bundling, packing, the smoke run of the unpacked server) runs in CI's `mcpb` job.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMcpConfigForManifest,
  MANIFEST_SCHEMAS,
  type McpbUserConfigValues,
} from "@anthropic-ai/mcpb/browser";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type BundledPackage,
  bundleOutputProblems,
  licenseProblems,
  type Manifest,
  manifestProblems,
  manifestTools,
  type PackageFiles,
  packageRoots,
  readBundledPackage,
  releaseManifest,
  thirdPartyNotices,
} from "../../../scripts/lib/mcpb.js";
import { loadConfig } from "../../../src/config.js";
import { ALL_TOOLS } from "../../../src/tools/index.js";
import { DEFAULT_TOOLSETS } from "../../../src/tools/toolsets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TOKEN = "f".repeat(32);

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const manifestText = read("mcpb/manifest.json");
const manifest = JSON.parse(manifestText) as Manifest;
const packageJson = z
  .object({ name: z.string(), version: z.string(), license: z.string() })
  .parse(JSON.parse(read("package.json")));

/** The server's command line and environment as Claude Desktop computes them. */
async function asDesktop(userConfig: McpbUserConfigValues, of: Manifest = manifest) {
  return getMcpConfigForManifest({
    manifest: MANIFEST_SCHEMAS["0.3"].parse(of),
    extensionPath: "/ext",
    systemDirs: { HOME: "/home/user" },
    userConfig,
    pathSeparator: "/",
  });
}

function withSetting(key: string, change: (setting: Record<string, unknown>) => void): Manifest {
  const copy = structuredClone(manifest) as {
    user_config: Record<string, Record<string, unknown>>;
  };
  const setting = copy.user_config[key];
  if (setting === undefined) throw new Error(`no setting ${key}`);
  change(setting);
  return copy;
}

describe("mcpb/manifest.json", () => {
  it("is a valid manifest 0.3 for this package and version", () => {
    expect(MANIFEST_SCHEMAS["0.3"].safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
      icon: "icon.png",
      server: { type: "node", entry_point: "server/index.mjs" },
    });
    expect(manifestProblems(manifest)).toEqual([]);
  });

  it("does not list tools (the build generates them) but says the server lists prompts", () => {
    expect(manifest).not.toHaveProperty("tools");
    expect(manifest).toMatchObject({ prompts_generated: true });
    expect(manifest).not.toHaveProperty("prompts");
  });

  // release-please bumps the version with JSON.stringify(…, null, 2) (extra-files), which would
  // reformat any other layout; .prettierignore keeps Prettier from collapsing short arrays.
  it("is laid out exactly as release-please writes it, and release-please bumps it", () => {
    expect(manifestText).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(read(".prettierignore")).toMatch(/^mcpb\/manifest\.json$/m);
    const config = z
      .object({
        packages: z.object({
          ".": z.object({ "extra-files": z.array(z.record(z.string(), z.string())) }),
        }),
      })
      .parse(JSON.parse(read("release-please-config.json")));
    expect(config.packages["."]["extra-files"]).toContainEqual({
      type: "json",
      path: "mcpb/manifest.json",
      jsonpath: "$.version",
    });
  });

  it("ships a 512×512 PNG icon", () => {
    const png = readFileSync(join(ROOT, "mcpb/icon.png"));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });

  it("passes only settings the server reads, with the defaults server.json documents", () => {
    const configSource = read("src/config.ts");
    const server = z
      .object({
        packages: z.array(
          z.object({
            registryType: z.string(),
            environmentVariables: z.array(
              z.object({ name: z.string(), default: z.string().optional() }).loose(),
            ),
          }),
        ),
      })
      .parse(JSON.parse(read("server.json")));
    const documented = new Map(
      server.packages
        .find((entry) => entry.registryType === "npm")
        ?.environmentVariables.map((variable) => [variable.name, variable.default ?? ""]),
    );
    const env = (manifest["server"] as { mcp_config: { env: Record<string, string> } }).mcp_config
      .env;
    const settings = manifest["user_config"] as Record<string, { default?: string | boolean }>;
    for (const [name, value] of Object.entries(env)) {
      expect(configSource, `src/config.ts reads ${name}`).toContain(`"${name}"`);
      expect(documented.has(name), `server.json documents ${name}`).toBe(true);
      const key = /^\$\{user_config\.(\w+)\}$/.exec(value)?.[1] ?? "";
      const fallback = settings[key]?.default;
      // Claude Desktop shows no elicitation dialog (checked 2026-11-10), so the extension
      // confirms in the browser by default; every other client keeps the server's default.
      const expected = name === "SEVDESK_CONFIRM" ? "browser" : documented.get(name);
      if (fallback !== undefined) {
        expect(String(fallback), `default of ${name}`).toBe(expected);
      }
    }
  });
});

describe("settings as Claude Desktop passes them", () => {
  it("passes an empty string for optional settings left empty, which the server treats as unset", async () => {
    const config = await asDesktop({ api_token: TOKEN });
    expect(config?.command).toBe("node");
    expect(config?.args).toEqual(["/ext/server/index.mjs"]);
    expect(config?.env).toEqual({
      SEVDESK_API_TOKEN: TOKEN,
      SEVDESK_ALLOW: "read",
      SEVDESK_READ_ONLY: "false",
      SEVDESK_DRY_RUN: "false",
      SEVDESK_CONFIRM: "browser",
      SEVDESK_TOOLSETS: "",
      SEVDESK_FILE_DIRS: "",
      SEVDESK_OUTPUT_DIR: "",
    });
    const loaded = loadConfig(config?.env ?? {});
    expect(loaded).toMatchObject({
      readOnly: false,
      dryRun: false,
      confirm: "browser",
      fileDirs: [],
      outputDir: undefined,
    });
    expect([...loaded.allowedTiers]).toEqual(["read"]);
    expect([...loaded.toolsets].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
  });

  it("maps every setting to the server's configuration", async () => {
    const config = await asDesktop({
      api_token: TOKEN,
      allow: "write,commit",
      read_only: false,
      dry_run: true,
      confirm: "browser",
      toolsets: "invoices,vouchers",
      file_dir: "/home/user/Belege",
      output_dir: "/home/user/Exports",
    });
    const loaded = loadConfig(config?.env ?? {});
    expect(loaded).toMatchObject({
      token: TOKEN,
      dryRun: true,
      confirm: "browser",
      fileDirs: ["/home/user/Belege"],
      outputDir: "/home/user/Exports",
    });
    expect([...loaded.allowedTiers].sort()).toEqual(["commit", "read", "write"]);
    expect([...loaded.toolsets].sort()).toEqual(["invoices", "meta", "vouchers"]);

    const readOnly = await asDesktop({ api_token: TOKEN, allow: "all", read_only: true });
    expect([...loadConfig(readOnly?.env ?? {}).allowedTiers]).toEqual(["read"]);
  });

  it("cannot switch confirmation off: the server refuses to start", async () => {
    const config = await asDesktop({ api_token: TOKEN, confirm: "off" });
    expect(() => loadConfig(config?.env ?? {})).toThrow("SEVDESK_I_UNDERSTAND_NO_CONFIRM=1");
  });

  it("puts the token only into SEVDESK_API_TOKEN, never on the command line", async () => {
    const config = await asDesktop({ api_token: TOKEN });
    const { SEVDESK_API_TOKEN: token, ...others } = config?.env ?? {};
    expect(token).toBe(TOKEN);
    expect(JSON.stringify([config?.command, config?.args, others])).not.toContain(TOKEN);
  });

  it("does not start the server without a token", async () => {
    expect(await asDesktop({})).toBeUndefined();
    expect(await asDesktop({ api_token: "" })).toBeUndefined();
  });

  it("would pass a literal placeholder for an optional setting without a default", async () => {
    const noDefault = withSetting("toolsets", (setting) => {
      delete setting["default"];
    });
    const config = await asDesktop({ api_token: TOKEN }, noDefault);
    expect(config?.env?.["SEVDESK_TOOLSETS"]).toBe("${user_config.toolsets}");
    expect(manifestProblems(noDefault)).toEqual([
      "user_config.toolsets is optional but has no default: left empty, it would reach the server as the literal text ${user_config.toolsets}.",
    ]);
  });
});

describe("manifestProblems", () => {
  const server = (mcpConfig: Record<string, unknown>): Manifest => ({
    ...manifest,
    server: { type: "node", entry_point: "server/index.mjs", mcp_config: mcpConfig },
  });

  it("needs node with the entry point as the first argument", () => {
    const message =
      'mcp_config must run "node" with "${__dirname}/<entry_point>" as its first argument.';
    const env = (manifest["server"] as { mcp_config: { env: unknown } }).mcp_config.env;
    expect(manifestProblems(server({ command: "node", args: ["server/index.mjs"], env }))).toEqual([
      message,
    ]);
    expect(
      manifestProblems(server({ command: "npx", args: ["${__dirname}/server/index.mjs"], env })),
    ).toEqual([message]);
    expect(manifestProblems({})).toContain(message);
  });

  it("reports undeclared, unused, sensitive-in-args and required-with-default settings", () => {
    const broken = withSetting("api_token", (setting) => {
      setting["default"] = "x";
    });
    const config = {
      command: "node",
      args: ["${__dirname}/server/index.mjs", "--token=${user_config.api_token}"],
      env: { SEVDESK_TOOLSETS: "${user_config.toolsets}", SEVDESK_X: "${user_config.missing}" },
    };
    expect(
      manifestProblems({
        ...broken,
        server: { ...(broken["server"] as object), mcp_config: config },
      }),
    ).toEqual([
      "mcp_config env SEVDESK_X uses ${user_config.missing}, which user_config does not declare.",
      "user_config.api_token is required, so it must not have a default.",
      "user_config.api_token is sensitive, so pass it in env, not in args.",
      "user_config.allow is never passed to the server.",
      "user_config.read_only is never passed to the server.",
      "user_config.dry_run is never passed to the server.",
      "user_config.confirm is never passed to the server.",
      "user_config.file_dir is never passed to the server.",
      "user_config.output_dir is never passed to the server.",
    ]);
  });
});

describe("manifestTools", () => {
  const tools = manifestTools(ALL_TOOLS);

  it("lists every tool a stdio install can offer, sorted, with title and tier", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "sevdesk_account_info",
        "sevdesk_invoice_create_draft",
        "sevdesk_invoice_finalize",
        "sevdesk_document_save",
      ]),
    );
    expect(tools.find((tool) => tool.name === "sevdesk_account_info")?.description).toBe(
      "sevDesk account overview (tier: read)",
    );
    for (const tool of ALL_TOOLS) {
      const listed = names.includes(tool.name);
      // Left out only when the tool itself says it is unavailable (another transport).
      expect(listed || tool.available !== undefined, tool.name).toBe(true);
      expect(tools.find((entry) => entry.name === tool.name)?.description ?? tool.title).toContain(
        tool.title,
      );
    }
  });
});

describe("releaseManifest", () => {
  const tools = [{ name: "sevdesk_account_info", description: "x" }];

  it("adds the tools to a template at the package version", () => {
    expect(releaseManifest(manifest, packageJson.version, tools)).toEqual({ ...manifest, tools });
  });

  it("refuses a version mismatch, listed tools and an empty tool list", () => {
    expect(() => releaseManifest(manifest, "9.9.9", tools)).toThrow(
      `mcpb/manifest.json version is "${packageJson.version}", but package.json is at "9.9.9".`,
    );
    expect(() => releaseManifest({ ...manifest, tools }, packageJson.version, tools)).toThrow(
      "must not list tools",
    );
    expect(() => releaseManifest(manifest, packageJson.version, [])).toThrow("No tools");
  });
});

describe("bundleOutputProblems", () => {
  it("accepts one file importing only Node built-ins", () => {
    expect(
      bundleOutputProblems(
        [{ type: "chunk", fileName: "index.mjs", imports: ["node:fs", "fs"], dynamicImports: [] }],
        "index.mjs",
      ),
    ).toEqual([]);
  });

  it("reports extra files and imports of packages", () => {
    expect(
      bundleOutputProblems(
        [
          { type: "chunk", fileName: "index.mjs", imports: ["zod"], dynamicImports: ["pdf-lib"] },
          { type: "asset", fileName: "index.mjs.map" },
        ],
        "index.mjs",
      ),
    ).toEqual([
      "Expected the bundle to be the single file index.mjs, got index.mjs, index.mjs.map.",
      "index.mjs imports zod, which the bundle does not contain.",
      "index.mjs imports pdf-lib, which the bundle does not contain.",
    ]);
    expect(bundleOutputProblems([], "index.mjs")).toEqual([
      "Expected the bundle to be the single file index.mjs, got nothing.",
    ]);
  });
});

describe("packageRoots", () => {
  it("finds the package directories of bundled modules", () => {
    expect(
      packageRoots([
        "/repo/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib/es/index.js",
        "/repo/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib/es/api/PDFDocument.js",
        "/repo/node_modules/.pnpm/@pdf-lib+upng@1.0.1/node_modules/@pdf-lib/upng/dist/upng.js",
        "/repo/node_modules/a/node_modules/b/lib/x.js?commonjs-proxy",
        String.raw`C:\repo\node_modules\zod\v4\index.js`,
        "/repo/src/index.ts",
        "/repo/package.json",
        "\0rolldown/runtime.js",
        "/repo/node_modules/@scope",
      ]),
    ).toEqual([
      "/repo/node_modules/.pnpm/@pdf-lib+upng@1.0.1/node_modules/@pdf-lib/upng",
      "/repo/node_modules/.pnpm/pdf-lib@1.17.1/node_modules/pdf-lib",
      "/repo/node_modules/a/node_modules/b",
      "C:/repo/node_modules/zod",
    ]);
  });
});

describe("readBundledPackage", () => {
  function fakeFiles(files: Record<string, string>): PackageFiles {
    return {
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT ${path}`);
        return text;
      },
      listFiles: (dir) =>
        Object.keys(files)
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1)),
    };
  }

  it("reads the package's identity and its license, notice and copying files", () => {
    const pkg = readBundledPackage(
      "/p",
      fakeFiles({
        "/p/package.json": JSON.stringify({
          name: "lib",
          version: "1.2.3",
          license: "Apache-2.0",
          author: { name: "Ada" },
          repository: { type: "git", url: "git+https://example.com/lib.git" },
        }),
        "/p/LICENSE.md": " Apache text \n",
        "/p/NOTICE": "notice",
        "/p/COPYING": "copying",
        "/p/LICENSE-MIT": "mit",
        "/p/README.md": "readme",
        "/p/licenses.json": "{}",
      }),
    );
    expect(pkg).toEqual({
      name: "lib",
      version: "1.2.3",
      license: "Apache-2.0",
      author: "Ada",
      repository: "https://example.com/lib.git",
      notices: [
        { file: "COPYING", text: "copying" },
        { file: "LICENSE-MIT", text: "mit" },
        { file: "LICENSE.md", text: "Apache text" },
        { file: "NOTICE", text: "notice" },
      ],
    });
  });

  it("marks a missing license as UNKNOWN", () => {
    const pkg = readBundledPackage(
      "/p",
      fakeFiles({
        "/p/package.json": JSON.stringify({
          name: "lib",
          version: "1.0.0",
          author: "Bob <bob@example.com>",
          repository: "github:bob/lib",
        }),
      }),
    );
    expect(pkg).toMatchObject({
      license: "UNKNOWN",
      author: "Bob <bob@example.com>",
      repository: "github:bob/lib",
      notices: [],
    });
  });

  it("reads a real installed package", () => {
    const entry = createRequire(import.meta.url).resolve("zod");
    const [root] = packageRoots([entry]);
    const zod = readBundledPackage(root ?? "");
    expect(zod).toMatchObject({ name: "zod", license: "MIT" });
    expect(zod.notices.map((notice) => notice.file)).toContain("LICENSE");
    expect(zod.notices[0]?.text).toContain("Permission is hereby granted");
  });
});

describe("licenses", () => {
  const pkg = (name: string, license: string, notices: BundledPackage["notices"] = []) =>
    ({
      name,
      version: "1.0.0",
      license,
      author: undefined,
      repository: undefined,
      notices,
    }) satisfies BundledPackage;

  it("allows permissive licenses only", () => {
    expect(
      licenseProblems([
        pkg("a", "MIT"),
        pkg("b", "(MIT AND Zlib)"),
        pkg("c", "MIT OR GPL-3.0-only"),
        pkg("d", "Apache-2.0"),
        pkg("e", "0BSD"),
      ]),
    ).toEqual([]);
    expect(
      licenseProblems([
        pkg("f", "GPL-3.0-only"),
        pkg("g", "(MIT AND LGPL-2.1)"),
        pkg("h", "UNKNOWN"),
      ]),
    ).toEqual([
      'f@1.0.0 is licensed "GPL-3.0-only", which is not on the bundle\'s allow-list (0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, Zlib).',
      'g@1.0.0 is licensed "(MIT AND LGPL-2.1)", which is not on the bundle\'s allow-list (0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, Zlib).',
      'h@1.0.0 is licensed "UNKNOWN", which is not on the bundle\'s allow-list (0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MIT, Zlib).',
    ]);
  });

  it("renders THIRD_PARTY_LICENSES.txt sorted by name, with every license text", () => {
    const text = thirdPartyNotices(
      [
        pkg("zeta", "MIT", [{ file: "LICENSE", text: "zeta license" }]),
        { ...pkg("alpha", "MIT"), author: "Ann", repository: "https://example.com/alpha" },
        pkg("@scope/beta", "Apache-2.0", [
          { file: "LICENSE", text: "beta license" },
          { file: "NOTICE", text: "beta notice" },
        ]),
      ],
      "1.0.0",
    );
    expect(text).toMatch(/^Third-party software in the mcp-server-sevdesk 1\.0\.0 bundle\n/);
    expect(text).toContain(
      "- @scope/beta 1.0.0: Apache-2.0\n- alpha 1.0.0: MIT\n- zeta 1.0.0: MIT\n",
    );
    expect(text).toContain("LICENSE:\n\nbeta license\n\nNOTICE:\n\nbeta notice");
    expect(text).toContain(
      "alpha 1.0.0\nLicense: MIT\nSource: https://example.com/alpha\n\nThe package ships no license file; its package.json declares the MIT license and the author Ann.",
    );
    expect(text).toContain("zeta 1.0.0\nLicense: MIT\n\nzeta license\n");
    expect(text.endsWith("zeta license\n")).toBe(true);
  });
});
