import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderAssetsModule } from "../../../scripts/page-assets.js";
import { EMBEDDED_ASSETS } from "../../../src/pages/assets.generated.js";
import {
  assetHeaders,
  assetPath,
  ASSETS_PREFIX,
  assetSource,
  pageAsset,
} from "../../../src/pages/assets.js";

const GENERATED = new URL("../../../src/pages/assets.generated.ts", import.meta.url);

describe("embedded page assets", () => {
  it("match the files in assets/ (run `pnpm pages:assets` after changing one)", () => {
    expect(readFileSync(GENERATED, "utf8")).toBe(renderAssetsModule());
  });

  it("are served under names that carry the start of their SHA-256", () => {
    for (const embedded of Object.values(EMBEDDED_ASSETS)) {
      const bytes = Buffer.from(embedded.base64, "base64");
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      expect(embedded.name).toMatch(/^[a-z-]+\.[0-9a-f]{12}\.(?:woff2|svg)$/);
      expect(embedded.name).toContain(`.${hash}.`);
    }
  });

  it("are three WOFF2 fonts and an SVG icon without script or external references", () => {
    const fonts = [
      EMBEDDED_ASSETS.archivoLatin,
      EMBEDDED_ASSETS.archivoLatinExt,
      EMBEDDED_ASSETS.martianMonoLatin,
    ];
    for (const font of fonts) {
      expect(font.type).toBe("font/woff2");
      expect(Buffer.from(font.base64, "base64").subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
    const icon = Buffer.from(EMBEDDED_ASSETS.icon.base64, "base64").toString("utf8");
    expect(EMBEDDED_ASSETS.icon.type).toBe("image/svg+xml");
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(icon).not.toMatch(/<script|href=|url\(|style=|<style|on[a-z]+=/i);
  });
});

describe("pageAsset", () => {
  it("finds each asset by its path, with its bytes", () => {
    for (const key of Object.keys(EMBEDDED_ASSETS) as (keyof typeof EMBEDDED_ASSETS)[]) {
      const asset = pageAsset(assetPath(key));
      expect(asset?.type).toBe(EMBEDDED_ASSETS[key].type);
      expect(Buffer.from(asset?.bytes ?? []).toString("base64")).toBe(EMBEDDED_ASSETS[key].base64);
      // Decoded once.
      expect(pageAsset(assetPath(key))).toBe(asset);
    }
    expect(assetPath("icon")).toBe(`/assets/${EMBEDDED_ASSETS.icon.name}`);
  });

  it("knows nothing else", () => {
    const name = EMBEDDED_ASSETS.icon.name;
    for (const path of [
      "/assets/",
      "/assets/icon.svg",
      `/assets/${name}/`,
      `/assets/x/${name}`,
      `/assets/../assets/${name}`,
      `/assets/${name.toUpperCase()}`,
      `/${name}`,
      `/files/${name}`,
      "/assets/constructor",
      "/assets/__proto__",
    ]) {
      expect(pageAsset(path), path).toBeUndefined();
    }
  });
});

describe("asset headers and source", () => {
  it("lets browsers cache an asset forever, for this origin only", () => {
    const asset = pageAsset(assetPath("archivoLatin"));
    if (asset === undefined) throw new Error("no font");
    expect(assetHeaders(asset)).toEqual({
      "Content-Type": "font/woff2",
      "Content-Length": String(asset.bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("names the assets path of an origin as the CSP source", () => {
    expect(ASSETS_PREFIX).toBe("/assets/");
    expect(assetSource("https://mcp.example.com")).toBe("https://mcp.example.com/assets/");
    expect(assetSource("http://127.0.0.1:53111")).toBe("http://127.0.0.1:53111/assets/");
  });
});
