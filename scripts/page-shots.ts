/**
 * `pnpm pages:shots`: photographs every page of the preview (`scripts/preview-pages.ts`) in
 * English and German, light and dark, on a desktop (1280px) and a phone (390px), into
 * `build/page-shots/<locale>-<scheme>-<page>-<width>.png`, and fails when a page logs an error:
 * a broken page, or anything the page's Content-Security-Policy refused.
 *
 *   pnpm pages:shots                       # every page
 *   pnpm pages:shots --only approval       # pages whose name contains "approval"
 *   pnpm pages:shots --width 390 --locale de --scheme dark
 *
 * It drives the installed Google Chrome through playwright-core (no browser download). Another
 * Chrome or Chromium: `SEVDESK_CHROME=<path to the executable>`. Browsers need more of the system
 * than a sandboxed shell allows, so run it outside such a sandbox.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { type Browser, chromium, type ConsoleMessage, type Page } from "playwright-core";

import { type Locale, LOCALES } from "../src/pages/locale.js";
import { GALLERY } from "../test/helpers/page-gallery.js";
import { type Scheme, SCHEME_NAMES, startPreview } from "./preview-pages.js";

const WIDTHS = [1280, 390] as const;
const OUT_DIR = join("build", "page-shots");

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    width: { type: "string" },
    locale: { type: "string" },
    scheme: { type: "string" },
  },
});

function pick<T extends string | number>(all: readonly T[], wanted: string | undefined): T[] {
  if (wanted === undefined) return [...all];
  const found = all.filter((value) => String(value) === wanted);
  if (found.length === 0)
    throw new Error(`pages:shots: "${wanted}" is not one of ${all.join(", ")}`);
  return found;
}

/** The pages, languages, schemes and widths this run photographs. */
const pages = GALLERY.filter(
  (page) => values.only === undefined || page.name.includes(values.only),
);
const locales: Locale[] = pick(LOCALES, values.locale);
const schemes: Scheme[] = pick(SCHEME_NAMES, values.scheme);
const widths = pick(WIDTHS, values.width);
if (pages.length === 0) throw new Error(`pages:shots: no page matches "${values.only ?? ""}"`);

async function launch(): Promise<Browser> {
  const executablePath = process.env["SEVDESK_CHROME"];
  return executablePath === undefined
    ? chromium.launch({ channel: "chrome" })
    : chromium.launch({ executablePath });
}

/** One photo; returns what the page logged as an error (console errors and uncaught errors). */
async function shoot(page: Page, url: string, file: string): Promise<string[]> {
  const problems: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === "error") problems.push(message.text());
  };
  const onError = (error: Error): void => {
    problems.push(error.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onError);
  try {
    const response = await page.goto(url, { waitUntil: "load" });
    if (response?.ok() !== true) problems.push(`HTTP ${String(response?.status())}`);
    // A string: this project's types have no DOM, and the expression runs in the page anyway.
    await page.evaluate("document.fonts.ready.then(() => undefined)");
    // `caret: "initial"` and `animations: "allow"`: anything else makes Playwright insert a
    // style element, which the page's policy refuses (and logs as an error).
    await page.screenshot({ path: file, fullPage: true, caret: "initial", animations: "allow" });
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onError);
  }
  return problems;
}

const preview = await startPreview(0);
const browser = await launch();
await mkdir(OUT_DIR, { recursive: true });
const failures: string[] = [];
let count = 0;
try {
  for (const width of widths) {
    for (const scheme of schemes) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: scheme,
      });
      const page = await context.newPage();
      for (const locale of locales) {
        for (const { name } of pages) {
          const file = join(OUT_DIR, `${locale}-${scheme}-${name}-${String(width)}.png`);
          const problems = await shoot(page, `${preview.origin}/${locale}/${scheme}/${name}`, file);
          count += 1;
          for (const problem of problems) failures.push(`${file}: ${problem}`);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await preview.close();
}

console.log(`${String(count)} screenshots in ${OUT_DIR}/`);
if (failures.length > 0) {
  console.error(`${String(failures.length)} problem(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
}
