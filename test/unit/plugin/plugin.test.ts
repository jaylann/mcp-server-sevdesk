/**
 * The Claude Code plugin (plugin/) and its marketplace (.claude-plugin/marketplace.json): the
 * manifests follow the documented format, the MCP server config passes settings through without
 * ever holding a token, the skill's frontmatter meets the Agent Skills limits, and every tool name
 * the skill mentions exists, so the docs cannot drift from the server.
 *
 * Formats: https://code.claude.com/docs/en/plugins-reference,
 * https://code.claude.com/docs/en/plugins/marketplace-reference,
 * https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ALL_TOOLS } from "../../../src/tools/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGIN_DIR = join(ROOT, "plugin");
const SKILL_DIR = join(PLUGIN_DIR, "skills", "sevdesk-bookkeeping");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every file under `dir`, dotfiles included, as absolute paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

const packageJson = z
  .object({
    name: z.string(),
    version: z.string(),
    license: z.string(),
    homepage: z.string(),
    repository: z.object({ url: z.string() }),
  })
  .parse(readJson(join(ROOT, "package.json")));

/** Letters, digits, ".", "_", "-", starting alphanumeric (a part of a `plugin@marketplace` id). */
const PLUGIN_ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("marketplace.json", () => {
  const marketplace = z
    .strictObject({
      name: z.string(),
      description: z.string().min(1),
      owner: z.strictObject({ name: z.string().min(1), url: z.url().optional() }),
      plugins: z
        .array(
          z.strictObject({
            name: z.string(),
            source: z.string(),
            description: z.string().min(1),
            category: z.string().optional(),
            tags: z.array(z.string()).optional(),
          }),
        )
        .min(1),
    })
    .parse(readJson(join(ROOT, ".claude-plugin", "marketplace.json")));

  it("has a usable, non-reserved name", () => {
    expect(marketplace.name).toMatch(PLUGIN_ID_PART);
    expect(marketplace.name).not.toContain("..");
    expect(marketplace.name.toLowerCase()).not.toMatch(/claude|anthropic|official/);
  });

  it("lists the plugin by a relative ./ path inside the repository", () => {
    expect(marketplace.plugins.map((plugin) => plugin.name)).toEqual(["sevdesk"]);
    for (const plugin of marketplace.plugins) {
      expect(plugin.name).toMatch(PLUGIN_ID_PART);
      expect(plugin.source).toMatch(/^\.\/[^\\]+$/);
      expect(plugin.source).not.toContain("..");
      expect(existsSync(join(ROOT, plugin.source, ".claude-plugin", "plugin.json"))).toBe(true);
    }
  });
});

describe("plugin.json", () => {
  const raw = readJson(join(PLUGIN_DIR, ".claude-plugin", "plugin.json"));
  const manifest = z
    .strictObject({
      name: z.string(),
      displayName: z.string().min(1),
      version: z.string(),
      description: z.string().min(1),
      author: z.strictObject({
        name: z.string().min(1),
        email: z.string().optional(),
        url: z.url().optional(),
      }),
      homepage: z.url(),
      repository: z.url(),
      license: z.string(),
      keywords: z.array(z.string().min(1)).min(1),
    })
    .parse(raw);

  it("names the plugin in kebab-case without a reserved prefix", () => {
    expect(manifest.name).toBe("sevdesk");
    expect(manifest.name).toMatch(KEBAB);
    expect(manifest.name).not.toMatch(/claude|anthropic/);
  });

  it("matches the package's version, license and links", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.license).toBe(packageJson.license);
    expect(manifest.homepage).toBe(packageJson.homepage);
    expect(manifest.repository).toBe(
      packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
    );
  });

  it("keeps every other file outside .claude-plugin/", () => {
    expect(readdirSync(join(PLUGIN_DIR, ".claude-plugin"))).toEqual(["plugin.json"]);
  });
});

describe(".mcp.json", () => {
  const config = z
    .strictObject({
      mcpServers: z.record(
        z.string(),
        z.strictObject({
          command: z.string(),
          args: z.array(z.string()),
          env: z.record(z.string(), z.string()),
        }),
      ),
    })
    .parse(readJson(join(PLUGIN_DIR, ".mcp.json")));
  const server = config.mcpServers["sevdesk"];
  /** `SEVDESK_*` variables the server reads (src/config.ts), from its source text. */
  const serverVariables = new Set(
    [...readFileSync(join(ROOT, "src", "config.ts"), "utf8").matchAll(/"(SEVDESK_[A-Z_]+)"/g)].map(
      (match) => match[1],
    ),
  );

  it("starts the published package with npx", () => {
    expect(Object.keys(config.mcpServers)).toEqual(["sevdesk"]);
    expect(server?.command).toBe("npx");
    expect(server?.args).toEqual(["-y", packageJson.name]);
  });

  it("only passes variables through from the user's environment, read-only by default", () => {
    const env = server?.env ?? {};
    for (const [name, value] of Object.entries(env)) {
      const match = /^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(value);
      expect(match?.[1], `${name} must be "\${${name}:-…}"`).toBe(name);
      expect(
        match?.[2],
        `${name} needs a default, or an unset variable arrives as literal text`,
      ).toBeDefined();
    }
    expect(env["SEVDESK_ALLOW"]).toBe("${SEVDESK_ALLOW:-read}");
    expect(env["SEVDESK_API_TOKEN"]).toBe("${SEVDESK_API_TOKEN:-}");
    expect(env["SEVDESK_API_TOKEN_FILE"]).toBe("${SEVDESK_API_TOKEN_FILE:-}");
  });

  it("passes every server setting except the no-confirmation opt-out", () => {
    const passed = Object.keys(server?.env ?? {}).sort();
    const expected = [...serverVariables]
      .filter((name) => name !== "SEVDESK_I_UNDERSTAND_NO_CONFIRM")
      .sort();
    expect(passed).toEqual(expected);
  });

  it("never contains a token value", () => {
    const text = readFileSync(join(PLUGIN_DIR, ".mcp.json"), "utf8");
    expect(text).not.toMatch(/[0-9a-f]{32}/i);
    expect(text).not.toMatch(/bearer/i);
  });
});

describe("SKILL.md", () => {
  const text = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const fields = new Map(
    (frontmatter?.[1] ?? "").split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
    }),
  );

  it("has YAML frontmatter with exactly name and description", () => {
    expect(frontmatter).not.toBeNull();
    expect([...fields.keys()]).toEqual(["name", "description"]);
  });

  it("names the skill like its folder, within the Agent Skills limits", () => {
    const name = fields.get("name") ?? "";
    expect(name).toBe("sevdesk-bookkeeping");
    expect(name).toMatch(KEBAB);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/anthropic|claude/);
  });

  it("describes what it does and when to use it, within the limits", () => {
    const description = fields.get("description") ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);
    // A plain YAML scalar: no quoting needed, nothing that YAML would read differently.
    expect(description).not.toMatch(/^["'|>]|: | #/);
    expect(description).toMatch(/\bUse when\b/);
  });

  it("stays short (details live in references/)", () => {
    expect(text.split("\n").length).toBeLessThan(500);
  });
});

describe("plugin files", () => {
  const files = filesUnder(PLUGIN_DIR);
  const markdown = files.filter((path) => path.endsWith(".md"));
  const toolNames = new Set(ALL_TOOLS.map((tool) => tool.name));

  it("mention only tools the server has", () => {
    const unknown = new Set<string>();
    for (const path of files) {
      for (const match of readFileSync(path, "utf8").matchAll(/\bsevdesk_[a-z0-9_]+/g)) {
        if (!toolNames.has(match[0])) {
          unknown.add(`${match[0]} (${relative(ROOT, path)})`);
        }
      }
    }
    expect([...unknown].sort()).toEqual([]);
  });

  it("link only to files that exist", () => {
    for (const path of markdown) {
      for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] ?? "";
        if (/^[a-z]+:/i.test(target)) {
          continue;
        }
        expect(
          existsSync(resolve(dirname(path), target)),
          `${relative(ROOT, path)} → ${target}`,
        ).toBe(true);
      }
    }
  });

  it("cite their sources and carry the disclaimer (references)", () => {
    const references = markdown.filter((path) => path.includes(`${sep}references${sep}`));
    expect(references.length).toBeGreaterThanOrEqual(5);
    for (const path of references) {
      const text = readFileSync(path, "utf8");
      expect(text, relative(ROOT, path)).toMatch(/^## Sources$/m);
      expect(text, relative(ROOT, path)).toMatch(/\]\(https:\/\//);
      expect(text, relative(ROOT, path)).toMatch(/not tax advice/i);
    }
  });

  it("are UTF-8 without a BOM, CRs or hidden characters", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index);
    const forbidden = new Set([
      ...range(0x00, 0x08), // control characters except tab and line feed …
      ...range(0x0b, 0x1f), // … (carriage return included)
      0x7f,
      0x00ad, // soft hyphen
      ...range(0x200b, 0x200f), // zero-width characters, LRM, RLM
      ...range(0x202a, 0x202e), // bidi embeddings and overrides
      0x2060, // word joiner
      ...range(0x2066, 0x2069), // bidi isolates
      0xfeff, // BOM / zero-width no-break space
    ]);
    for (const path of [...files, join(ROOT, ".claude-plugin", "marketplace.json")]) {
      const text = decoder.decode(readFileSync(path));
      const found: string[] = [];
      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (forbidden.has(code)) {
          found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
        }
      }
      expect(found, relative(ROOT, path)).toEqual([]);
    }
  });
});
