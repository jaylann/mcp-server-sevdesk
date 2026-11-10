# ADR 0010: The server's pages: one design, two languages, previews in German

- **Status:** Proposed
- **Date:** 2026-11-10
- **Amends:** [ADR 0003](0003-tiers-and-human-confirmation.md) (the confirmation preview exists in
  English and German, and the preview hash covers both), and the pages of
  [ADR 0003](0003-tiers-and-human-confirmation.md),
  [ADR 0007](0007-approval-inbox-over-http.md) and [ADR 0008](0008-file-transfer-over-http.md)
  (their look, their language and their Content-Security-Policy)

## Context

The server shows a human ten page layouts: the approval page (the local one and the inbox's),
the inbox, the sign-in, the two consent steps, the upload page and its receipt, and the pages
that report a result or an error. They were unstyled system-font pages with two near-duplicate
stylesheets, in English only, and had nothing in common with how the project presents itself
(`sevdeskmcp.lanfermann.dev`).

That matters more than it would for an admin page:

- These pages are where a human decides on legally binding bookkeeping. sevDesk's customers are
  German businesses, and the person who approves is often not the person who set up the server.
  A reader who has to translate "enshrine" or "partial booking" in their head approves less
  carefully.
- A page that looks unfinished next to the product it acts for invites the wrong reflex: either
  distrust of a legitimate request, or approving quickly to get rid of it.
- The preview a human approves is trusted text the tools write in English, for the model
  ([ADR 0003](0003-tiers-and-human-confirmation.md)). A German page around an English preview
  translates everything except the part that counts.

The constraints of the earlier decisions stay: no script, every value escaped, no framing, forms
that post only to the server, nothing fetched from anyone else, pages never cached.

## Decision

**One page layer.** `src/pages/` holds what every page shares: a template tag that escapes every
interpolated value (`markup`), the colour and type tokens of the website's design system (paper
and ink, depth from layered shadows, Archivo and Martian Mono), one stylesheet, one frame, the
components and the icons (inline SVG). The renderers stay where they were
(`src/safety/approval-page.ts`, `src/http/oauth/consent-page.ts`, `src/http/transfer-pages.ts`)
and build on it. Stamp violet is reserved for the one thing a model can never do: the Approve
button and the stamp on the page after a decision. Light and dark follow the browser.

Still no script. What script would usually do is done with CSS: the server writes the seconds a
request has left into the page's style block, a bar drains over that time, and at zero a
keyframe hides the buttons and shows that the request has expired. The absolute expiry time
stays on the page for browsers that do none of this.

**Fonts and the icon come from the server itself.** They are embedded in the build
(`pnpm pages:assets` writes `src/pages/assets.generated.ts`, checked for drift by a test) and
served by both servers under `GET /assets/<name>.<hash>.<ext>`: immutable, `nosniff`,
`Cross-Origin-Resource-Policy: same-origin`, 404 for any other name. The pages' policy gains
exactly that:

```
default-src 'none'; style-src 'nonce-…'; font-src <origin>/assets/; img-src <origin>/assets/;
form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

The sources are scoped to the path, not `'self'`: a same-origin GET is not always harmless here
(`GET /files/<id>` counts a download), and the pages need nothing outside `/assets/`.

**German and English, chosen by the browser.** Each response picks the language from
`Accept-Language` (the first supported one; English when there is none) and says so
(`<html lang>`, `Content-Language`, `Vary: Accept-Language`). The texts are in
`src/pages/text/en.ts` and `de.ts`; the German catalog has the type of the English one, so a
missing text does not compile. There is no language switch and no cookie.

**Every tool a human confirms writes its preview in German too.** A `commit` or `external` tool
returns `previewDe` next to `preview`; the type of `defineWriteTool` requires it. Both are built
from the same data in the same place (`src/domain/preview-text.ts`: helpers take the language,
and a sentence that a check produces carries both wordings), with German amounts and dates in
German notation by string operations only. Before anyone is asked, the write flow checks the
pair: each a complete preview, as many facts and warnings in one as in the other, the same
`irreversible`. A pair that differs fails the call; nothing is shown as if it were complete.

The preview hash covers both texts, so an approval is bound to what either reader saw, and a
change to either wording asks again. The approval pages show the German preview to a German
reader. The model, dry runs, the audit log and a client's own confirmation prompt (elicitation)
keep the English text: there is no browser language to go by, and they are read by models.

## Consequences

- Good: the page a human decides on reads like the product it belongs to and speaks the reader's
  language, including the sentence that says what will happen and the warnings.
- Good: the safety properties are unchanged or tighter. Escaping is now the default of the
  template tag rather than a call each renderer must remember; one test renders every page in
  every state and both languages and checks it against what the policy would block.
- Good: an approval still covers the complete text (ADR 0003), now in both languages.
- Bad: every confirmed tool has two wordings to keep true. The pair check guarantees the same
  shape, not the same meaning: a German sentence can be wrong while the structure is right. What
  holds it together is that both wordings stand next to each other in the code, that
  `test/integration/write-previews-de.test.ts` snapshots the German preview of every confirmed
  tool in one reviewable file, and that `pnpm pages:preview` lists every page text in both
  languages side by side.
- Bad: the German reader and the model see the same request in different words and notation
  (`1.190,00 EUR` and `1190.00 EUR`). The reference code is how the two are matched, as before.
- Bad: the build grows by about 290 KB (three font files and the icon, base64). The fonts are
  under the SIL Open Font License; their texts ship in `licenses/` with the package, the image
  and the extension.
- Neutral: German sentences run about a third longer, so the display cap of a warning went from
  500 to 900 characters. A test checks that no preview of a shipped tool reaches a cap in either
  language.
- Neutral: tool titles exist in English only. The German page names the tool
  (`sevdesk_invoice_finalize`) without its title.
- Neutral: the countdown and the expiry swap need a current browser. Without them the page still
  shows when the request expires, and the server refuses a late decision either way.
- Neutral: the preview hash of confirmed tools changed. Pending approvals live in memory and do
  not survive the restart of an upgrade anyway.

## Alternatives considered

- **Fonts from a font service or CDN.** The approval page would then tell a third party each time
  someone is about to approve something. Rejected.
- **`font-src 'self'; img-src 'self'`.** Simpler to read, wider than needed (see above).
- **Fonts as `data:` URIs in the style block.** No route, but 290 KB in every page load, nothing
  cached, and `font-src data:` in the policy. Rejected.
- **A little script for the countdown and a language switch.** One script is the end of "these
  pages run no code"; the CSS covers the countdown and the browser already knows the language.
- **Translate the preview where it is shown** (a dictionary on the page, or a model). What a
  human approves must be exactly what the tool wrote and what the hash covers. Rejected.
- **Hash the English preview only.** An approval given on the German page would then not be
  bound to the text that was read: a change to the German wording alone would not ask again.
  Rejected.
- **Previews as message ids with parameters, rendered per language.** The cleaner shape if a
  third language is ever added. Today it would rewrite every preview and every test that reads
  one; two wordings side by side reach the same result with far less change, and can be turned
  into that shape later without changing what a page shows.
- **German for the elicitation prompt and dry runs as well.** Nothing tells the server which
  language the person at an MCP client reads, and those texts are read by the model too. Left as
  it is.
