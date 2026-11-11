/**
 * The static assets of the server's own pages: two fonts (Archivo, Martian Mono) and the icon.
 * They are embedded in the bundle (`assets.generated.ts`) and served under `/assets/<name>` by
 * both servers that show pages: the HTTP server (`src/http/asset-route.ts`) and the local approval
 * page (`src/safety/approval-local.ts`).
 *
 * The pages' Content-Security-Policy allows fonts and images from this path of the server's own
 * origin only ({@link assetSource}); everything else stays blocked. Names carry a content hash,
 * so an asset never changes under its URL and may be cached forever. Nothing here depends on the
 * request: no cookies are read, and unknown names are simply not found.
 */
import { EMBEDDED_ASSETS } from "./assets.generated.js";

/** Prefix of the asset URLs, `/assets/<name>`. */
export const ASSETS_PREFIX = "/assets/";

type PageAssetKey = keyof typeof EMBEDDED_ASSETS;

interface PageAsset {
  /** Media type, e.g. `font/woff2`. */
  readonly type: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** The path a page loads asset `key` from, e.g. `/assets/icon.3a35095f2530.svg`. */
export function assetPath(key: PageAssetKey): string {
  return `${ASSETS_PREFIX}${EMBEDDED_ASSETS[key].name}`;
}

/**
 * The CSP source that covers the assets of the server at `origin` and nothing else on it:
 * `https://mcp.example.com/assets/` (a path ending in `/` matches everything below it).
 */
export function assetSource(origin: string): string {
  return new URL(ASSETS_PREFIX, origin).href;
}

const decoded = new Map<string, PageAsset>();

/** The asset served at `pathname` (`/assets/<name>`), if there is one. Decoded once. */
export function pageAsset(pathname: string): PageAsset | undefined {
  if (!pathname.startsWith(ASSETS_PREFIX)) return undefined;
  const name = pathname.slice(ASSETS_PREFIX.length);
  const known = decoded.get(name);
  if (known !== undefined) return known;
  const embedded = Object.values(EMBEDDED_ASSETS).find((candidate) => candidate.name === name);
  if (embedded === undefined) return undefined;
  const bytes = new Uint8Array(Buffer.from(embedded.base64, "base64"));
  const asset: PageAsset = { type: embedded.type, bytes };
  decoded.set(name, asset);
  return asset;
}

/**
 * The headers an asset is served with: cacheable forever (the name carries a content hash), for
 * this origin's pages only, never sniffed, and inert when opened by itself.
 */
export function assetHeaders(asset: PageAsset): Record<string, string> {
  return {
    "Content-Type": asset.type,
    "Content-Length": String(asset.bytes.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}
