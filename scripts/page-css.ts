/**
 * Builds `src/pages/styles.generated.ts`: the stylesheet of the server's pages, compiled with
 * Tailwind from `src/pages/pages.css` on top of the Lanfermann system (`@lanfermann/ui`), and the
 * colour tokens of its two grounds as the pages use them. Written by `pnpm pages:css`
 * (scripts/embed-page-css.ts); a test fails when the module and its sources drift apart, so a new
 * release of the system reaches the pages with a version bump and `pnpm pages:css`.
 *
 * Tailwind scans no source files: the pages' markup uses no utility classes, so only what
 * `pages.css` applies is generated (not the classes of the system's React components). The
 * system's plain CSS for those components is then dropped by {@link prune}, which reads the
 * markup sources for the classes and attributes a page can carry. The system switches grounds
 * with `data-theme` only; the pages follow the browser, so the build adds the system's own Ink
 * declarations under `prefers-color-scheme: dark` for a root without a `data-theme` (the page
 * preview sets one to force a scheme).
 *
 * Nothing here runs in the server: the result is a string constant, like the embedded fonts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile, optimize } from "@tailwindcss/node";
import { type SelectorComponent, transform } from "lightningcss";

const INPUT = new URL("../src/pages/pages.css", import.meta.url);
/** Characters of CSS per source line of the generated module. */
const LINE = 96;

/**
 * The files that write the pages' markup (and the preview, which sets `data-theme` to force a
 * scheme): every class and attribute a page can carry is a word in one of them.
 */
const MARKUP = [
  "../src/pages/components.ts",
  "../src/pages/frame.ts",
  "../src/pages/icons.ts",
  "../src/pages/message.ts",
  "../src/safety/approval-page.ts",
  "../src/http/oauth/consent-page.ts",
  "../src/http/transfer-pages.ts",
  "../scripts/preview-pages.ts",
].map((path) => new URL(path, import.meta.url));

/** The selector of the system's Paper and Ink rules, as the minifier writes them. */
const PAPER =
  /(?:^|[;,}])((?::root|\[data-theme=paper\]|\[data-theme=tint\])(?:,[^{]*)?)\{([^{}]*)\}/g;
const INK = ".dark,[data-theme=ink]{";

/** Every word in the markup sources: a superset of the classes and attributes the pages use. */
function markupWords(): ReadonlySet<string> {
  const words = new Set<string>();
  for (const file of MARKUP) {
    for (const [word] of readFileSync(file, "utf8").matchAll(/[A-Za-z][A-Za-z0-9]*/g))
      words.add(word);
  }
  return words;
}

/**
 * Drops the rules no page can match: those whose every selector names, outside any pseudo-class,
 * a class, an attribute or an attribute value that no markup source contains (the system's
 * components: prose, code blocks, segmented controls, `data-slot` parts, the Tint and Indigo
 * grounds). A selector that names one only inside `:is()`, `:not()` or the like is kept, so
 * nothing that could match is lost. Then the custom properties nothing reads go (code colours,
 * theme scales the pages do not use), until every one left is read somewhere.
 */
function prune(css: string): string {
  const words = markupWords();
  // Class names are also built from parts (`dot-${state}`): a name is known when each part is.
  const word = (name: string): boolean => name.split("-").every((part) => words.has(part));
  const known = (part: SelectorComponent): boolean => {
    if (part.type === "class") return word(part.name);
    if (part.type !== "attribute") return true;
    const value = part.operation?.value;
    return word(part.name) && (value === undefined || word(value));
  };
  const possible = (selector: readonly SelectorComponent[]): boolean => selector.every(known);
  const { code } = transform({
    filename: "pages.css",
    code: Buffer.from(css),
    minify: true,
    visitor: {
      Rule: {
        style(rule) {
          return rule.value.selectors.some(possible) ? undefined : [];
        },
      },
    },
  });
  return optimize(unread(code.toString()), { minify: true }).code;
}

/** `css` without the declarations of custom properties that no `var()` reads. */
function unread(css: string): string {
  let result = css;
  for (;;) {
    const read = new Set([...result.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));
    const next = result
      .replace(/([{;])(--[\w-]+):[^;{}]*(?=[;}])/g, (all, lead: string, name: string) =>
        read.has(name) ? all : lead,
      )
      .replaceAll(/;{2,}/g, ";")
      .replaceAll("{;", "{")
      .replaceAll(";}", "}");
    if (next === result) return result;
    result = next;
  }
}

/** The declarations of every top-level rule whose selector is exactly `selector`, in order. */
function blocks(css: string, selector: string): string[] {
  const found: string[] = [];
  let at = css.indexOf(selector);
  while (at !== -1) {
    const start = at + selector.length;
    const end = css.indexOf("}", start);
    found.push(css.slice(start, end));
    at = css.indexOf(selector, end);
  }
  return found;
}

/** `#abc` → `#aabbcc`, lower case. */
function longHex(value: string): string {
  const hex = value.toLowerCase();
  return hex.length === 4 ? hex.replaceAll(/[0-9a-f]/g, (digit) => digit + digit) : hex;
}

/** The `--lf-*` colours of hex value in `declarations`, later ones winning, without the prefix. */
function tokens(declarations: readonly string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const block of declarations) {
    for (const match of block.matchAll(/--lf-([a-z-]+):(#[0-9a-f]{3}(?:[0-9a-f]{3})?)\b/gi)) {
      const [, name = "", value = ""] = match;
      found[name] = longHex(value);
    }
  }
  return found;
}

/** What `pnpm pages:css` builds. */
export interface PageCss {
  readonly css: string;
  /** The Paper ground's colour tokens (light scheme), by name without `--lf-`. */
  readonly paper: Readonly<Record<string, string>>;
  /** The Ink ground's colour tokens (dark scheme). */
  readonly ink: Readonly<Record<string, string>>;
}

/** Compiles `src/pages/pages.css` with the installed `@lanfermann/ui` and Tailwind. */
export async function buildPageCss(): Promise<PageCss> {
  const source = readFileSync(INPUT, "utf8");
  const compiler = await compile(source, {
    base: fileURLToPath(new URL(".", INPUT)),
    onDependency: () => undefined,
  });
  const built = optimize(compiler.build([]), { minify: true }).code.trim();
  const ink = blocks(built, INK);
  if (ink.length === 0) throw new Error("pages:css: the system's Ink ground was not found");
  const dark = `@media (prefers-color-scheme:dark){:root:not([data-theme]){${ink.join(";")}}}`;
  // The licence line stays; its link goes, as the pages name no URL of another origin.
  const css = prune(`${built}${dark}`).replace(" | https://tailwindcss.com", "").trim();
  const paper = [...built.matchAll(PAPER)]
    .filter(([, selector = ""]) => selector.split(",").includes(":root"))
    .map(([, , body = ""]) => body);
  return { css, paper: tokens(paper), ink: tokens(ink) };
}

/** The source of `src/pages/styles.generated.ts`. */
export async function renderStylesModule(): Promise<string> {
  const { css, paper, ink } = await buildPageCss();
  const lines: string[] = [];
  for (let at = 0; at < css.length; at += LINE) {
    lines.push(`  ${JSON.stringify(css.slice(at, at + LINE))},`);
  }
  const record = (values: Readonly<Record<string, string>>): string[] =>
    Object.entries(values).map(([name, value]) => `  ${JSON.stringify(name)}: "${value}",`);
  return [
    "// Generated by `pnpm pages:css` (scripts/page-css.ts) from src/pages/pages.css and",
    "// @lanfermann/ui. Do not edit.",
    "",
    "/** The stylesheet of the server's pages, minified. */",
    "export const PAGE_STYLES = [",
    ...lines,
    '].join("");',
    "",
    "/** The colour tokens of the Paper ground (light scheme), by name without `--lf-`. */",
    "export const PAPER = {",
    ...record(paper),
    "} as const;",
    "",
    "/** The colour tokens of the Ink ground (dark scheme), by name without `--lf-`. */",
    "export const INK = {",
    ...record(ink),
    "} as const;",
    "",
  ].join("\n");
}
