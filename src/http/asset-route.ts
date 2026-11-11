/**
 * `GET /assets/<name>`: the fonts and the icon of the server's own pages (`src/pages/assets.ts`).
 * Public by design, like the pages' markup: the files are the same for everyone, carry no
 * account data, and are served from memory under names with a content hash. Unknown names get the
 * router's 404.
 */
import { assetHeaders, ASSETS_PREFIX, pageAsset } from "../pages/assets.js";
import type { HttpRoute, RateRule } from "./types.js";

/** Asset requests per client IP (IPv6 by /64): a first page view loads three, then caches them. */
export const ASSET_RATE: RateRule = { name: "assets", perMinute: 240 };

/** The asset route, mounted whenever the server shows pages. */
export function assetRoute(): HttpRoute {
  return {
    path: ASSETS_PREFIX,
    match: "prefix",
    methods: ["GET"],
    maxBodyBytes: 0,
    origin: "none",
    rateLimit: ASSET_RATE,
    handle: (request) => {
      const asset = pageAsset(new URL(request.url).pathname);
      return Promise.resolve(
        asset === undefined
          ? undefined
          : new Response(asset.bytes, { status: 200, headers: assetHeaders(asset) }),
      );
    },
  };
}
