/**
 * `pnpm pages:preview`: every page of the server, in every state, language and colour scheme, on
 * `http://127.0.0.1:4173` (or `PORT`). For looking at the pages while changing them; nothing here
 * runs in the server. `pnpm pages:watch` starts it again whenever a file it imports changes
 * (reload the tab), and `pnpm pages:shots` (`scripts/page-shots.ts`) photographs it.
 *
 * The pages are rendered by the real renderers from the made-up content in
 * `test/helpers/page-gallery.ts` and answered with the real page headers (`htmlResponse`), so the
 * browser applies the same Content-Security-Policy as in production: a font, an image or a
 * style the policy blocks is blocked here too (the console says so). Forms post nowhere useful:
 * every POST is answered with a note.
 *
 * `/texts` lists every page text in English and German side by side, for proofreading. A page
 * with `?phone` shows the narrow-screen layout in a 375px column.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { assetHeaders, pageAsset } from "../src/pages/assets.js";
import { pageContext, type RenderContext } from "../src/pages/context.js";
import { renderFrame } from "../src/pages/frame.js";
import { markup } from "../src/pages/html.js";
import { type Locale, LOCALES } from "../src/pages/locale.js";
import { renderMessagePage } from "../src/pages/message.js";
import { pageTexts } from "../src/pages/text/index.js";
import { NARROW } from "../src/pages/theme.js";
import { htmlResponse, styleNonce } from "../src/safety/web.js";
import { GALLERY } from "../test/helpers/page-gallery.js";
import { flattenTexts } from "../test/helpers/page-texts.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env["PORT"] ?? "4173");

/** The system's ground for each scheme. */
const SCHEMES = { light: "paper", dark: "ink" } as const;
export type Scheme = keyof typeof SCHEMES;
export const SCHEME_NAMES = Object.keys(SCHEMES) as Scheme[];

function context(locale: Locale, origin: string): RenderContext {
  return { ...pageContext(locale, origin), nonce: styleNonce() };
}

/**
 * Applies one colour scheme whatever the desktop prefers: the system's ground on the root
 * (`data-theme`), which the stylesheet's scheme rule leaves alone.
 */
function forceScheme(page: string, scheme: Scheme): string {
  return page.replace("<html ", `<html data-theme="${SCHEMES[scheme]}" `);
}

/**
 * The page as a phone lays it out, in a wide window: the stylesheet's narrow-screen rules always
 * on, in a column 375px wide. For browsers whose window cannot be made narrow.
 */
function forcePhone(page: string): string {
  return page
    .replaceAll(`@media (max-width:${NARROW})`, "@media all")
    .replace("</style>", ".page,.wide .page{max-width:375px}</style>");
}

function send(response: ServerResponse, status: number, page: string, ctx: RenderContext): void {
  const built = htmlResponse(page, { status, nonce: ctx.nonce, page: ctx });
  response.writeHead(status, Object.fromEntries(built.headers));
  response.end(page);
}

const INDEX_CSS = `
.gallery li{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem 1.5rem;
  flex-wrap:wrap;padding:.75rem 0;border-top:1px solid var(--lf-hairline)}
.gallery li:first-child{border-top:0}
.gallery span{display:flex;gap:.875rem;font-size:.9375rem}
.texts{width:100%;border-collapse:collapse;font-size:.875rem;line-height:1.5}
.texts th,.texts td{padding:.5rem .75rem .5rem 0;border-top:1px solid var(--lf-hairline);text-align:left;
  vertical-align:top;overflow-wrap:anywhere}
.texts th{font-weight:500;color:var(--lf-text-muted)}
.texts td:first-child{width:22%;font-family:"JetBrains Mono",monospace;font-size:.75rem;
  color:var(--lf-text-muted)}
`;

function index(ctx: RenderContext): string {
  const rows = GALLERY.map((page) => {
    const links = LOCALES.flatMap((locale) =>
      SCHEME_NAMES.map((scheme) => {
        const href = `/${locale}/${scheme}/${page.name}`;
        return markup`<a href="${href}">${locale.toUpperCase()} ${scheme}</a>`;
      }),
    );
    const phone = markup`<a href="/en/light/${page.name}?phone">phone</a>`;
    return markup`<li>${page.title}<span>${links}${phone}</span></li>`;
  });
  const body = markup`<h1>Pages of the server</h1>
<p class="lead">Every state with made-up content, under the real page headers. <a href="/texts">All texts in English and German</a>.</p>
<section class="card"><ul class="gallery">${rows}</ul></section>`;
  return renderFrame({ title: "Page preview", body, wide: true, css: INDEX_CSS }, ctx);
}

function texts(ctx: RenderContext): string {
  const english = flattenTexts(pageTexts("en"));
  const german = flattenTexts(pageTexts("de"));
  const rows = [...english].map(([path, text]) => {
    const translated = german.get(path) ?? "";
    return markup`<tr><td>${path}</td><td lang="en">${text}</td><td lang="de">${translated}</td></tr>`;
  });
  const body = markup`<h1>Page texts</h1>
<p class="lead">${String(english.size)} texts. <a href="/">Back to the pages</a>.</p>
<section class="card"><table class="texts">
<thead><tr><th>Text</th><th>English</th><th>Deutsch</th></tr></thead>
<tbody>${rows}</tbody>
</table></section>`;
  return renderFrame({ title: "Page texts", body, wide: true, css: INDEX_CSS }, ctx);
}

/** A running preview: where it listens, and how to stop it. */
export interface Preview {
  readonly origin: string;
  close(): Promise<void>;
}

/** Starts the preview on `port` of 127.0.0.1 (0: any free port). */
export async function startPreview(port: number = PORT): Promise<Preview> {
  let origin = `http://${HOST}:${String(port)}`;
  const server = createServer((request, response) => {
    handle(origin, request.method, request.url, response);
    request.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      resolve();
    });
  });
  origin = `http://${HOST}:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function handle(
  origin: string,
  method: string | undefined,
  url: string | undefined,
  response: ServerResponse,
): void {
  const [path = "/", query] = (url ?? "/").split("?");
  const ctx = context("en", origin);
  if (method !== "GET") {
    const note = {
      title: "Preview only",
      message: "Forms post nowhere in the preview. Open the result pages from the index.",
    };
    const page = renderMessagePage(note, ctx, { link: { href: "/", label: "Back to the pages" } });
    send(response, 200, page, ctx);
    return;
  }
  const asset = pageAsset(path);
  if (asset !== undefined) {
    response.writeHead(200, assetHeaders(asset));
    response.end(asset.bytes);
    return;
  }
  if (path === "/") {
    send(response, 200, index(ctx), ctx);
    return;
  }
  if (path === "/texts") {
    send(response, 200, texts(ctx), ctx);
    return;
  }
  // Nothing from the URL goes into a page: its parts only pick one of the known values.
  const parts = path.split("/");
  const locale = LOCALES.find((candidate) => candidate === parts[1]);
  const scheme = SCHEME_NAMES.find((candidate) => candidate === parts[2]);
  const page = GALLERY.find((candidate) => candidate.name === parts[3]);
  if (page === undefined || locale === undefined || scheme === undefined) {
    const missing = { title: "No such preview", message: "Pick a page from the index." };
    send(response, 404, renderMessagePage(missing, ctx, { tone: "info" }), ctx);
    return;
  }
  const pageCtx = context(locale, origin);
  const rendered = forceScheme(page.render(pageCtx), scheme);
  send(response, 200, query === "phone" ? forcePhone(rendered) : rendered, pageCtx);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await startPreview();
  console.log(`Page preview: ${preview.origin}/  (Ctrl+C to stop)`);
}
