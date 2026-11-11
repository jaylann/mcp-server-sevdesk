/**
 * The look of the server's own pages: the website's "Beleg & Stempel" system (paper, ink, ledger
 * rules, and one loud element, the violet stamp ink of a human approval) as plain CSS for pages
 * without script.
 *
 * - Colours are role tokens ({@link LIGHT_TOKENS}, {@link DARK_TOKENS}); the stylesheet never
 *   names a raw colour, so the dark scheme only swaps the tokens. A test checks the contrast of
 *   every text/background pair the pages use.
 * - Violet (`approve`) appears only where a human approves a bookkeeping action. Ink (`action`)
 *   is the default action, ledger green (`ok`) is positive and focus, storno red (`danger`) is
 *   irreversible or refused, carbon blue (`info`) is the write tier.
 * - Outlines are 1px shadows, not borders, and depth comes from layered ink-tinted shadows.
 * - The one stylesheet serves every page. It is inserted into the page's single style block,
 *   which the response's CSP allows by nonce; nothing here may depend on a `style=""` attribute
 *   (the CSP blocks them).
 */
import { assetPath } from "./assets.js";

/** Role tokens of the light scheme: the website's palette (`sevdesk-web/app/globals.css`). */
export const LIGHT_TOKENS = {
  bg: "#f9f9f6",
  "bg-2": "#f1f2ee",
  surface: "#ffffff",
  text: "#1b2233",
  "text-2": "#3a4257",
  "text-3": "#6b7286",
  line: "#dadde4",
  "line-2": "#eceef2",
  "line-3": "#b9becb",
  // The outline of a form field: 3:1 against the sheet and against a tinted fill, so the field
  // is found without its label.
  field: "#848a9b",
  action: "#1b2233",
  "action-hover": "#283044",
  "on-action": "#f9f9f6",
  approve: "#5a3fc0",
  "approve-hover": "#4a31a6",
  "on-approve": "#ffffff",
  "approve-text": "#4a31a6",
  "approve-tint": "#f2effb",
  "approve-line": "#e4def7",
  ok: "#146c4a",
  "ok-text": "#0f5a3d",
  "ok-tint": "#f1f5ef",
  "ok-line": "#c9dcc4",
  info: "#2f55c8",
  "info-tint": "#eef2fc",
  "info-line": "#dce4f8",
  danger: "#c2362b",
  "danger-tint": "#fbefee",
  "danger-line": "#f6dbd8",
  focus: "#146c4a",
  "stamp-ink": "#5a3fc0",
  "stamp-plain": "#3a4257",
} as const;

export type TokenName = keyof typeof LIGHT_TOKENS;

/** The dark scheme: the website's ink tones as surfaces, the signal colours lightened for text. */
export const DARK_TOKENS: Readonly<Record<TokenName, string>> = {
  bg: "#10141d",
  "bg-2": "#161b27",
  surface: "#1b2233",
  text: "#eef0f4",
  "text-2": "#c9ced9",
  "text-3": "#9aa1b2",
  line: "#343d54",
  "line-2": "#272f43",
  "line-3": "#4a546e",
  field: "#7d87a0",
  action: "#eef0f4",
  "action-hover": "#ffffff",
  "on-action": "#1b2233",
  approve: "#6b50d6",
  "approve-hover": "#7b62e0",
  "on-approve": "#ffffff",
  "approve-text": "#b9abf7",
  "approve-tint": "#262446",
  "approve-line": "#3d3672",
  ok: "#62c59a",
  "ok-text": "#84d6b1",
  "ok-tint": "#17302b",
  "ok-line": "#25503f",
  info: "#8fa9f5",
  "info-tint": "#1c2748",
  "info-line": "#2d3d70",
  danger: "#f28b80",
  "danger-tint": "#381f23",
  "danger-line": "#5e2d2f",
  focus: "#62c59a",
  "stamp-ink": "#b9abf7",
  "stamp-plain": "#c9ced9",
};

/** Depth, per scheme: ink-tinted layers on paper, a hairline and black on ink. */
const LIGHT_SHADOWS = {
  "shadow-sheet":
    "0 0 0 1px rgb(27 34 51/.06),0 1px 1px rgb(27 34 51/.04),0 4px 8px -2px rgb(27 34 51/.06)," +
    "0 18px 36px -12px rgb(27 34 51/.16)",
  "shadow-bevel":
    "inset 0 1px 0 rgb(255 255 255/.14),0 1px 2px rgb(27 34 51/.28)," +
    "0 6px 14px -6px rgb(27 34 51/.4)",
  "shadow-press": "inset 0 1px 2px rgb(27 34 51/.14)",
  "shadow-lift": "0 1px 2px rgb(27 34 51/.06)",
  "shadow-inset": "inset 0 1px 2px rgb(27 34 51/.05)",
  "stamp-blend": "multiply",
} as const;

const DARK_SHADOWS: Readonly<Record<keyof typeof LIGHT_SHADOWS, string>> = {
  "shadow-sheet": "0 0 0 1px rgb(255 255 255/.07),0 18px 36px -12px rgb(0 0 0/.55)",
  "shadow-bevel":
    "inset 0 1px 0 rgb(255 255 255/.16),0 1px 2px rgb(0 0 0/.4),0 6px 14px -6px rgb(0 0 0/.5)",
  "shadow-press": "inset 0 1px 2px rgb(0 0 0/.35)",
  "shadow-lift": "0 1px 2px rgb(0 0 0/.3)",
  "shadow-inset": "inset 0 1px 2px rgb(0 0 0/.25)",
  // Multiplying ink onto a dark sheet would make it vanish.
  "stamp-blend": "normal",
};

/** Below this viewport width the pages use their narrow layout (stacked rows and buttons). */
export const NARROW = "30rem";

function declarations(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");
}

/**
 * The custom properties of each scheme, as the body of a rule. The stylesheet applies the light
 * ones to `:root` and the dark ones under `prefers-color-scheme: dark`; the page preview
 * (`scripts/preview-pages.ts`) applies one of them directly, to show both schemes on any desktop.
 */
export const LIGHT_SCHEME = declarations({ ...LIGHT_TOKENS, ...LIGHT_SHADOWS });
export const DARK_SCHEME = declarations({ ...DARK_TOKENS, ...DARK_SHADOWS });

/**
 * The fonts: the two files Google Fonts serves for Archivo (basic Latin with the German umlauts,
 * and Latin Extended for other European names; the browser fetches the second only when a page
 * needs it) and Martian Mono for code. The `unicode-range`s are Google's. The fallback face
 * gives Arial the metrics of Archivo, so text does not move when the font arrives.
 */
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329," +
  "U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329," +
  "U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F," +
  "U+A720-A7FF";

const FONTS = `
@font-face{font-family:"Archivo";font-style:normal;font-weight:100 900;font-stretch:62% 125%;font-display:swap;src:url(${assetPath("archivoLatin")}) format("woff2");unicode-range:${LATIN}}
@font-face{font-family:"Archivo";font-style:normal;font-weight:100 900;font-stretch:62% 125%;font-display:swap;src:url(${assetPath("archivoLatinExt")}) format("woff2");unicode-range:${LATIN_EXT}}
@font-face{font-family:"Martian Mono";font-style:normal;font-weight:100 800;font-stretch:75% 112.5%;font-display:swap;src:url(${assetPath("martianMonoLatin")}) format("woff2");unicode-range:${LATIN}}
@font-face{font-family:"Archivo Fallback";src:local("Arial");ascent-override:88.96%;descent-override:21.28%;line-gap-override:0%;size-adjust:98.7%}
`;

const BASE = `
:root{color-scheme:light dark;${LIGHT_SCHEME};
  --sans:"Archivo","Archivo Fallback",ui-sans-serif,system-ui,sans-serif;
  --mono:"Martian Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --ease:cubic-bezier(.22,1,.36,1)}
@media (prefers-color-scheme:dark){:root{${DARK_SCHEME}}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}
body{margin:0;background:var(--bg);color:var(--text);font:400 1.0625rem/1.6 var(--sans);
  font-feature-settings:"ss01" off;-webkit-font-smoothing:antialiased}
::selection{background:color-mix(in oklab,var(--approve) 22%,transparent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
h1,h2{margin:0;font-weight:620;text-wrap:balance}
h1{font-size:clamp(1.625rem,1.35rem + 1.2vw,2.125rem);line-height:1.1;letter-spacing:-.028em}
h2{font-size:1.3125rem;line-height:1.25;letter-spacing:-.015em;text-wrap:pretty}
p,ul,ol,dl,form,fieldset{margin:0}
p{text-wrap:pretty}
ul,ol{padding:0;list-style:none}
strong{font-weight:620}
a{color:var(--ok);font-weight:500;text-decoration:underline;text-decoration-color:var(--ok-line);
  text-decoration-thickness:.09em;text-underline-offset:.2em}
a:hover{text-decoration-color:var(--ok)}
code{font-family:var(--mono);font-stretch:87.5%;font-size:.8em;padding:.125rem .375rem;
  border-radius:6px;background:var(--line-2);color:var(--text-2);overflow-wrap:anywhere}
svg{flex:none}
.ink{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round}
.ink-accent{stroke:var(--stamp-ink)}
.dot{fill:currentColor;stroke:none}

.page{display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;max-width:38rem;
  margin:0 auto;padding:clamp(1.25rem,5vw,3rem) 1rem 2rem}
.wide .page{max-width:46rem}
.top{margin-bottom:clamp(1.75rem,7vw,3.25rem)}
.wordmark{display:inline-flex;align-items:center;gap:.625rem;font-weight:620;font-size:1.0625rem;
  line-height:1;letter-spacing:-.02em}
.wordmark svg{width:2rem;height:2rem;transform:rotate(-12deg)}
main{flex:1}
.foot{margin-top:3rem;font-size:.8125rem;line-height:1.45;color:var(--text-3)}

.eyebrow{display:flex;align-items:center;gap:.5rem;margin-bottom:.625rem;font-size:.8125rem;
  line-height:1.45;font-weight:500;color:var(--approve-text)}
.eyebrow svg{width:1.125rem;height:1.125rem}
.lead{margin-top:.75rem;color:var(--text-2)}
.small{font-size:.9375rem;line-height:1.5;color:var(--text-2)}
.fine{font-size:.8125rem;line-height:1.45;color:var(--text-3)}
.after{margin-top:1.25rem}
.nb{white-space:nowrap}

.sheet{margin-top:1.75rem;padding:1.5rem;border-radius:14px;background:var(--surface);
  box-shadow:var(--shadow-sheet)}
main > .sheet:first-child{margin-top:0}
.sheet h1{font-size:clamp(1.5rem,1.3rem + .8vw,1.75rem);letter-spacing:-.02em}
.sheet-head{display:flex;align-items:center;justify-content:space-between;gap:.75rem;
  flex-wrap:wrap;margin-bottom:1rem}
.meta{margin-top:.375rem;font-size:.9375rem;line-height:1.5;color:var(--text-3)}

.badge{display:inline-flex;align-items:center;gap:.375rem;min-height:1.5rem;padding:.125rem .625rem;
  border-radius:999px;font-size:.8125rem;line-height:1.25;font-weight:500;background:var(--line-2);
  color:var(--text-2)}
.badge svg{width:.875rem;height:.875rem}
.badge-approve{background:var(--approve-tint);color:var(--approve-text);
  box-shadow:inset 0 0 0 1px var(--approve-line)}
.badge-ok{background:var(--ok-tint);color:var(--ok-text);box-shadow:inset 0 0 0 1px var(--ok-line)}
.badge-info{background:var(--info-tint);color:var(--info);
  box-shadow:inset 0 0 0 1px var(--info-line)}
.badge-danger{background:var(--danger-tint);color:var(--danger);
  box-shadow:inset 0 0 0 1px var(--danger-line)}
.tier-dot{width:.5rem;height:.5rem;border-radius:50%;background:currentColor}

.ref{display:inline-block;padding:.1875rem .5rem;border-radius:6px;background:var(--bg-2);
  box-shadow:inset 0 0 0 1px var(--line);font-family:var(--mono);font-stretch:87.5%;
  font-size:.8125rem;line-height:1.4;font-weight:500;letter-spacing:.1em;color:var(--text)}

.callout{display:grid;grid-template-columns:auto 1fr;gap:.625rem;align-items:start;
  margin-top:.75rem;padding:.75rem .875rem;border-radius:10px;background:var(--surface);
  box-shadow:inset 3px 0 0 var(--text),0 0 0 1px var(--line);font-size:.9375rem;line-height:1.5;
  color:var(--text-2)}
.callout svg{width:1.125rem;height:1.125rem;margin-top:.125rem;color:var(--text)}
.callout-danger{background:var(--danger-tint);color:var(--text);
  box-shadow:inset 3px 0 0 var(--danger),0 0 0 1px var(--danger-line)}
.callout-danger svg{color:var(--danger)}
.callout-note{background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line)}
.callout-note svg{color:var(--text-3)}
.callouts{margin-top:1rem}
.callouts li + li{margin-top:.5rem}
.callouts .callout{margin-top:0}

.facts{display:grid;grid-template-columns:minmax(7rem,34%) 1fr;margin-top:1.25rem}
.facts dt,.facts dd{margin:0;padding:.625rem 0;border-top:1px solid var(--line-2)}
.facts dt{padding-right:1.25rem;font-size:.9375rem;line-height:1.7;color:var(--text-3)}
.facts dd{min-width:0;overflow-wrap:anywhere;white-space: pre-wrap;
  font-variant-numeric:tabular-nums lining-nums}
.facts dt:first-child,.facts dt:first-child + dd{border-top:0;padding-top:0}
.facts dt.long{grid-column:1/-1;padding-bottom:0}
.facts dt.long + dd{grid-column:1/-1;margin:.375rem 0 .625rem;padding:.75rem .875rem;border-top:0;
  border-radius:8px;background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line-2);
  font-size:.9375rem;line-height:1.55}
.facts-plain{margin-top:0}

.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
  min-height:2.75rem;padding:0 1.125rem;border:0;border-radius:10px;background:var(--line-2);
  color:var(--text);font:500 .9375rem/1.2 var(--sans);text-decoration:none;white-space:nowrap;
  cursor:pointer;-webkit-tap-highlight-color:transparent;
  transition:background-color .2s var(--ease),box-shadow .2s var(--ease),transform .2s var(--ease)}
.btn:hover{background:var(--line)}
.btn:active{transform:translateY(1px);box-shadow:var(--shadow-press)}
.btn svg{width:1rem;height:1rem}
.btn-ink{background:var(--action);color:var(--on-action);box-shadow:var(--shadow-bevel)}
.btn-ink:hover{background:var(--action-hover)}
.btn-approve{background:var(--approve);color:var(--on-approve);box-shadow:var(--shadow-bevel)}
.btn-approve:hover{background:var(--approve-hover)}
.btn-approve .ink-accent{stroke:currentColor}
.btn-outline{background:var(--surface);box-shadow:0 0 0 1px var(--line-3),var(--shadow-lift)}
.btn-outline:hover{background:var(--surface);box-shadow:0 0 0 1px var(--field),var(--shadow-lift)}
.btn-ghost{background:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--line-2);color:var(--text)}
.btn-sm{min-height:2.25rem;padding:0 .875rem;border-radius:8px;font-size:.875rem}
@media (pointer:coarse){.btn-sm{min-height:2.75rem}}
.actions{display:flex;flex-wrap:wrap;gap:.5rem}

.field{display:block;margin-bottom:.4rem;font-size:.9375rem;line-height:1.5;font-weight:500}
input[type="password"]{display:block;width:100%;min-height:2.75rem;padding:0 .875rem;border:0;
  border-radius:10px;background:var(--surface);color:var(--text);font:inherit;
  box-shadow:inset 0 0 0 1px var(--field),var(--shadow-inset);
  transition:box-shadow .2s var(--ease)}
input[type="password"]:hover{box-shadow:inset 0 0 0 1px var(--text-3),var(--shadow-inset)}
input[type="password"]:focus-visible{outline:0;
  box-shadow:inset 0 0 0 1.5px var(--focus),0 0 0 4px color-mix(in oklab,var(--focus) 14%,transparent)}
.hint{margin-top:.5rem;font-size:.8125rem;line-height:1.5;color:var(--text-3)}

.strip{display:flex;align-items:center;justify-content:space-between;gap:.75rem 1.25rem;
  flex-wrap:wrap;margin:1.5rem -1.5rem -1.5rem;padding:1rem 1.5rem 1.125rem;
  border-top:1px dashed var(--line-3);border-radius:0 0 14px 14px;background:var(--bg-2)}
.strip p{flex:1 1 12rem;font-size:.9375rem;line-height:1.5;color:var(--text-2)}

.notice{margin-top:1.25rem}
.notice .callout{margin-top:0}
.sheet > .callout:first-child{margin:0 0 1.25rem}
.ref-line{display:inline-flex;align-items:center;gap:.5rem}
.ref strong{font-weight:inherit}

.strip .late{flex:0 0 0;height:0;overflow:hidden;visibility:hidden;color:var(--text);font-weight:500;
  animation:arrive 1ms linear var(--ttl) forwards}
.live{animation:expire 1ms linear var(--ttl) forwards}
@keyframes arrive{to{flex:1 1 100%;height:auto;overflow:visible;visibility:visible}}
@keyframes expire{to{flex:0 0 0;height:0;min-height:0;overflow:hidden;visibility:hidden}}
.expiry{margin-top:1.25rem}
.meter{height:3px;margin-bottom:.625rem;border-radius:999px;background:var(--line);overflow:hidden}
.meter i{display:block;height:100%;border-radius:inherit;background:var(--stamp-ink);
  transform-origin:left center;transform:scaleX(var(--part));
  animation:drain var(--ttl) linear forwards}
@keyframes drain{to{transform:scaleX(0)}}
.clock-line{display:none}
@property --t{syntax:"<integer>";inherits:true;initial-value:0}
@supports (width:calc(1px*round(down,1.5,1))) and (color:rgb(from red r g b)){
  .clock-line{display:inline}
  .clock{font-weight:500;font-variant-numeric:tabular-nums;color:var(--text);
    counter-reset:m calc(round(down,var(--t)/60,1)) s calc(mod(var(--t),60));
    animation:tick var(--ttl) linear forwards}
  .clock::after{content:counter(m) ":" counter(s,decimal-leading-zero)}
  @keyframes tick{from{--t:var(--secs)}to{--t:0}}
}

.stamp{display:block;width:max-content;max-width:100%;margin:.25rem 0 1.25rem -.125rem;
  color:var(--stamp-ink);opacity:.93;mix-blend-mode:var(--stamp-blend);transform:rotate(-7deg);
  transform-origin:40% 60%;pointer-events:none;user-select:none;-webkit-user-select:none;
  animation:land .5s cubic-bezier(.34,1.56,.64,1) both}
.stamp-plain{color:var(--stamp-plain)}
.stamp svg{display:block;max-width:100%;height:auto}
.stamp-word{font-family:var(--sans);font-stretch:125%;font-weight:900;letter-spacing:.06em}
@keyframes land{from{opacity:0;transform:translateY(-28px) scale(1.9) rotate(-17deg)}20%{opacity:.93}}
.struck{animation:shake .32s ease-out .26s both}
@keyframes shake{25%{transform:translate(-2.5px,2.5px) rotate(-.25deg)}
  50%{transform:translate(2px,-1px) rotate(.15deg)}75%{transform:translate(-1px,.5px)}}

.title-row{display:flex;align-items:center;justify-content:space-between;gap:.75rem 1rem;
  flex-wrap:wrap}
.row{position:relative;display:flex;align-items:center;justify-content:space-between;
  gap:.75rem 1.25rem;flex-wrap:wrap;margin-top:.625rem;padding:1rem;border-radius:10px;
  background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line-2);
  transition:box-shadow .2s var(--ease)}
.row:first-child{margin-top:0}
.row:hover{box-shadow:inset 0 0 0 1px var(--line-3)}
.row-pending,.row-pending:hover{background:var(--surface);
  box-shadow:0 0 0 1px var(--approve-line),
    0 14px 30px -18px color-mix(in oklab,var(--approve) 50%,transparent)}
.row-main{flex:1 1 16rem;min-width:0}
.row-title{font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.row-title a{color:inherit;text-decoration:none}
.row-title a::after{content:"";position:absolute;inset:0;border-radius:inherit}
.row-title a:focus-visible{outline:0}
.row-title a:focus-visible::after{outline:2px solid var(--focus);outline-offset:2px}
.row-meta{margin-top:.25rem;font-size:.9375rem;line-height:1.6;color:var(--text-2)}
.row .fine{color:var(--text-2)}
.row-meta .ref{margin-left:.125rem}
.row-meta code{padding:0;background:none}
.row-status{display:flex;align-items:center;gap:.375rem .625rem;flex-wrap:wrap;margin-top:.5rem}
.row .btn{pointer-events:none}
.row:hover .btn-outline{box-shadow:0 0 0 1px var(--field),var(--shadow-lift)}
.empty{display:grid;justify-items:center;gap:.5rem;padding:1.5rem 0 1rem;text-align:center}
.empty > svg{width:3rem;height:3rem;margin-bottom:.25rem;color:var(--text-2)}
.empty p{max-width:26rem;font-size:.9375rem;line-height:1.5;color:var(--text-2)}
.empty .btn{margin-top:.75rem}

.address{display:flex;align-items:center;gap:.5rem;width:fit-content;max-width:100%;
  margin-bottom:.75rem;padding:.375rem .875rem .375rem .75rem;
  border-radius:999px;background:var(--bg-2);box-shadow:inset 0 0 0 1px var(--line);
  font-family:var(--mono);font-stretch:87.5%;font-size:.8125rem;line-height:1.5;color:var(--text);
  overflow-wrap:anywhere}
.address svg{width:1rem;height:1rem;color:var(--ok)}
form.login{margin-top:1.25rem}
form.login label{display:block;margin-bottom:.4rem;font-size:.9375rem;line-height:1.5;font-weight:500}
form.login .btn{width:100%;margin-top:1.25rem}

.steps{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;margin-bottom:1.5rem;font-size:.875rem;
  line-height:1.4;color:var(--text-3)}
.step{display:flex;align-items:center;gap:.5rem}
.step-mark{display:grid;place-items:center;width:1.5rem;height:1.5rem;border-radius:50%;
  box-shadow:inset 0 0 0 1px var(--line-3);font-size:.8125rem;font-weight:500;
  font-variant-numeric:tabular-nums}
.step-mark svg{width:.875rem;height:.875rem}
.step-now{font-weight:500;color:var(--text)}
.step-now .step-mark{background:var(--action);color:var(--on-action);box-shadow:none}
.step-done .step-mark{background:var(--ok-tint);color:var(--ok);
  box-shadow:inset 0 0 0 1px var(--ok-line)}
.app p + p{margin-top:.375rem}
.app strong{overflow-wrap:anywhere}
.tiers{padding:0;border:0;min-width:0}
.tiers legend,.may{padding:0;margin-bottom:.625rem;font-size:.9375rem;line-height:1.5;
  font-weight:500}
.tier{display:grid;grid-template-columns:auto 1fr;gap:.75rem;align-items:start;margin-top:.5rem;
  padding:.75rem .875rem;border-radius:10px;background:var(--surface);
  box-shadow:inset 0 0 0 1px var(--line);cursor:pointer;transition:box-shadow .2s var(--ease)}
.tier:hover{box-shadow:inset 0 0 0 1px var(--line-3)}
.tier:has(input:checked){background:var(--bg-2);box-shadow:inset 0 0 0 1.5px var(--text)}
.tier:has(input:disabled){cursor:default}
.tier:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:3px}
.tier input{width:1.125rem;height:1.125rem;margin:.1875rem 0 0;accent-color:var(--action)}
.tier input:focus-visible{outline:0}
.tier-words{display:grid;gap:.375rem;justify-items:start}
.tier-words strong{font-weight:500}
.tiers .hint{margin-bottom:1.5rem}
.granted li + li{margin-top:.875rem}
.may{margin-top:1.25rem}
.form-actions{margin-top:1.5rem}
.form-actions .btn-ink{flex:1 1 auto}
form.sheet > .callout{margin-top:1rem}

form.upload{margin-top:1.5rem}
input[type="file"]{display:block;width:100%;padding:1.25rem 1rem;border:1.5px dashed var(--field);
  border-radius:10px;background:var(--bg-2);color:var(--text-2);font:inherit;font-size:.9375rem;
  cursor:pointer;transition:border-color .2s var(--ease)}
input[type="file"]:hover{border-color:var(--text-3)}
input[type="file"]::file-selector-button{min-height:2.25rem;margin-right:.875rem;padding:0 .875rem;
  border:0;border-radius:8px;background:var(--surface);color:var(--text);
  box-shadow:0 0 0 1px var(--line-3),var(--shadow-lift);font:500 .875rem/1.2 var(--sans);
  cursor:pointer}
form.upload .btn{width:100%;margin-top:1.25rem}

@media (prefers-reduced-motion:reduce){.stamp,.struck,.meter i{animation:none}}
.result-icon{display:grid;place-items:center;width:2.75rem;height:2.75rem;margin-bottom:1rem;
  border-radius:50%;background:var(--line-2);color:var(--text-2)}
.result-icon svg{width:1.375rem;height:1.375rem}
.result-ok{background:var(--ok-tint);color:var(--ok)}
.result-danger{background:var(--danger-tint);color:var(--danger)}
.message{margin-top:.625rem;color:var(--text-2)}
.next{margin-top:1.25rem}

@media (max-width:${NARROW}){
  .sheet{padding:1.25rem}
  .strip{margin:1.25rem -1.25rem -1.25rem;padding:1rem 1.25rem 1.25rem}
  .strip .actions{flex:1 1 100%;flex-direction:column-reverse}
  .strip .btn{width:100%}
  .facts{grid-template-columns:1fr}
  .facts dt{padding-bottom:0}
  .facts dd{border-top:0;padding-top:.125rem}
  .facts dt.long + dd{margin-top:.375rem}
}
`;

/** The stylesheet of every page of the server (fonts, tokens, components). */
export const PAGE_CSS = `${FONTS}${BASE}`;
