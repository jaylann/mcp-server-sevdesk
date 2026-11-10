/**
 * HTML building for the server's own pages (`src/pages`, the approval, consent and transfer
 * renderers). The pages have no script, so escaping text and attribute values is the whole
 * injection defence, and it is the default here:
 *
 * - {@link markup} is a template tag. Every interpolated string or number is escaped; only values
 *   that are {@link Html} already (built by `markup` or {@link trusted}) go in as they are.
 * - The static parts of a template are markup written in this repository, and they reach the
 *   page exactly as written, whitespace included (values keep their line breaks on the pages).
 *   That is why the tag is not called `html`: formatters reformat templates with that name.
 * - {@link trusted} wraps markup that is a constant of this repository (an icon, a stylesheet).
 *   Never pass it anything that came from a request, from sevDesk or from a model.
 */

/** Escapes `&`, `<`, `>`, `"` and `'` for HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Markup that is safe to put into a page as it is. Built by {@link markup} and {@link trusted}. */
export class Html {
  readonly #source: string;

  /** @internal Use {@link markup} or {@link trusted}. */
  constructor(source: string) {
    this.#source = source;
  }

  toString(): string {
    return this.#source;
  }
}

/** What a template may interpolate: text (escaped), markup (kept), nothing, or a list of those. */
export type HtmlValue = Html | string | number | false | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value === undefined || value === null || value === false) return "";
  if (value instanceof Html) return value.toString();
  if (typeof value === "string") return escapeHtml(value);
  if (typeof value === "number") return String(value);
  return value.map(render).join("");
}

/**
 * Builds markup: `` markup`<dd>${value}</dd>` ``. Strings and numbers are escaped, {@link Html}
 * values are inserted as they are, `undefined`, `null` and `false` render nothing, and arrays
 * render their items one after another.
 */
export function markup(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  let source = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    source += render(value) + (strings[index + 1] ?? "");
  }
  return new Html(source);
}

/** Markup that is a constant of this repository (an inline SVG, a stylesheet). See the file doc. */
export function trusted(source: string): Html {
  return new Html(source);
}
