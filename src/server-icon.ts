/**
 * The server's icon in its MCP identity (`serverInfo.icons`, MCP 2025-11-25 and later), so clients
 * show the sigma mark next to the server instead of a generic one.
 *
 * It is `assets/icon.svg` (embedded for the pages as `EMBEDDED_ASSETS.icon`, kept in step with the
 * file by a test) as a base64 `data:` URI, over every transport:
 *
 * - stdio has no URL to serve a file from;
 * - over HTTP `/assets/` serves the pages' files with `Cross-Origin-Resource-Policy: same-origin`
 *   (`src/pages/assets.ts`), so a client on another origin could not load the icon from there, and
 *   a self-hosted server behind a private network would not be reachable for it anyway.
 *
 * The SVG is trusted (no script, no external reference; a test checks both) and minified: in the
 * 2026-07-28 era the SDK repeats `serverInfo` in the `_meta` of every response, so every byte
 * counts. `sizes: ["any"]` because it scales.
 */
import type { Icon } from "@modelcontextprotocol/server";

import { EMBEDDED_ASSETS } from "./pages/assets.generated.js";

/** `assets/icon.svg` without comments and the whitespace between its tags. */
function minifiedIconSvg(): string {
  return Buffer.from(EMBEDDED_ASSETS.icon.base64, "base64")
    .toString("utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

/** The icons of `SERVER_INFO` (`src/server.ts`): one scalable SVG as a `data:` URI. */
export const SERVER_ICONS: Icon[] = [
  {
    src: `data:image/svg+xml;base64,${Buffer.from(minifiedIconSvg(), "utf8").toString("base64")}`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  },
];
