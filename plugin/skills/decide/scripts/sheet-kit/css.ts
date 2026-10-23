/**
 * Stylesheet fragments of the sheet kit: the reading system every sheet
 * genre shares. A genre composes its stylesheet from these fragments and its
 * own rules, in cascade order. A fragment is exact text: the decision
 * sheet's document template is rebuilt from them byte for byte, so a change
 * here changes every genre at once.
 *
 * The frame is three columns: a hanging label column (`--lab`), a reading
 * column (`--m`, at most 80 characters) and a margin beside it. Citations and
 * asides sit in the margin. The top bar is sticky and the section labels
 * stick under it.
 *
 * Colours are named constants, not literals, so each genre's contrast test
 * can hold every pair it draws to WCAG AA (the Web Content Accessibility
 * Guidelines' minimum contrast level). The kit defines its own neutral
 * palette: `PALETTE` in `html.ts` for structure, the tints below for tiles
 * and highlights, and darker inks for text drawn on a tint.
 */
import { PALETTE } from "./html.ts";

/** Light and mid tints for highlights and outcome tiles. */
export const TOKEN_TINTS = {
  blueLight: "oklch(0.94 0.03 255)",
  blueMid: "oklch(0.64 0.1 255)",
  emeraldLight: "oklch(0.94 0.05 150)",
  amberLight: "oklch(0.94 0.05 85)",
} as const;

/**
 * Inks drawn for text on a tint. Each is dark enough to reach 4.5:1 on its
 * own tint; the mid-lightness steps a chart would use for the same hue do
 * not. Risk red `#b42318`: about 6.5:1 on white and 5:1 on its tint.
 */
export const OUTCOME_INK = {
  emerald: "oklch(0.44 0.11 150)",
  amber: "oklch(0.47 0.1 70)",
  red: "#b42318",
  redLight: "oklch(0.93 0.04 25)",
} as const;

/** The text-on-background pairs the kit fragments draw, for a genre's contrast test. Each is [foreground, background, where]. */
export const KIT_TEXT_PAIRS: readonly [string, string, string][] = [
  [PALETTE.ink, PALETTE.surface, "body text"],
  [PALETTE.muted, PALETTE.surface, "secondary text"],
  [PALETTE.accent, PALETTE.surface, "links"],
  [PALETTE.ink, TOKEN_TINTS.blueLight, "a traced item or term"],
  [PALETTE.muted, PALETTE.bg, "secondary text on the page"],
  [PALETTE.surface, PALETTE.accent, "a traced reference"],
  [PALETTE.surface, PALETTE.ink, "a term tip"],
];

/** Custom properties, every colour the genres use, the measures and the font stacks. No web font: the system stack. */
const root = `:root{--bg:${PALETTE.bg};--surface:${PALETTE.surface};--ink:${PALETTE.ink};--sec:${PALETTE.muted};--rule:${PALETTE.hair};--hair:${PALETTE.hairLight};
--blue:${PALETTE.accent};--blue-l:${TOKEN_TINTS.blueLight};--blue-m:${TOKEN_TINTS.blueMid};
--em-ink:${OUTCOME_INK.emerald};--em-l:${TOKEN_TINTS.emeraldLight};
--am-ink:${OUTCOME_INK.amber};--am-l:${TOKEN_TINTS.amberLight};
--red:${OUTCOME_INK.red};--red-l:${OUTCOME_INK.redLight};
--m:33rem;--lab:10.5rem;--gap:2.5rem;--bar-h:49px;
--sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}`;

/** Resets, type and the visually-hidden helper. */
const base = `*{box-sizing:border-box}[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:calc(var(--bar-h) + 16px)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--blue);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{color:var(--ink)}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:2px}
p{margin:0 0 .7em}p:last-child{margin-bottom:0}
h1,h2,h3,h4{margin:0;font-weight:600;text-wrap:balance}
ul,ol{margin:0;padding:0}
code{font:.875em/1.4 var(--mono)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`;

/** The sheet and its labelled sections. */
const frame = `.sheet{max-width:1320px;margin:8px auto 64px;background:var(--surface);border:1px solid var(--hair);padding:24px 40px 56px}
.sec{display:grid;grid-template-columns:var(--lab) minmax(0,1fr);column-gap:var(--gap);padding:24px 0;border-top:1px solid var(--hair)}`;

/** A section label sticks under the top bar while its section scrolls. */
const secLab = `.sec>.lab{position:sticky;top:calc(var(--bar-h) + 16px);align-self:start}`;

/** The heavy rule, the label type, the reading column and its margin, the title block. */
const reading = `.heavy{border-top:2px solid var(--ink);margin-top:40px}
.lab{font-size:13px;line-height:1.4;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--sec);padding-top:3px}
.body{min-width:0}
.pair{display:grid;grid-template-columns:minmax(0,var(--m)) minmax(0,1fr);column-gap:var(--gap)}
.main{max-width:var(--m)}
.side .blk+.blk{margin-top:20px}
.side .lab{display:block;margin-bottom:6px}
.side p{font-size:16px}
.mast{border-top:0;padding-top:0}.mast>.lab{position:static}
.mast-id{display:flex;flex-direction:column;gap:2px;padding-top:9px}
.mast-id a{font-weight:600}
h1{font-size:28px;line-height:1.25;letter-spacing:-.01em;max-width:44rem}
.meta{display:grid;grid-template-columns:repeat(4,max-content);gap:12px 48px;margin:16px 0 0;padding-top:12px;border-top:1px solid var(--rule)}
.meta dt{font-size:13px;color:var(--sec);margin-bottom:1px}
.meta dd{margin:0;font-weight:500;display:flex;flex-wrap:wrap;gap:0 10px}
.meta .rev{grid-column:1/-1;max-width:var(--m)}
.meta .rev dd{font-size:17px;line-height:1.45;display:block}
.mono{font-family:var(--mono);font-size:14px}`;

/** Cited claims: the claim in the reading column, its citation in the margin. */
const claims = `.claims{list-style:none}
.claims li{padding:7px 0}
.claims li+li{border-top:1px solid var(--hair)}
.src{color:var(--sec);word-break:break-word;padding-top:2px}
.src code{font-size:13px;line-height:1.5}`;

/** Terms: the list, and a term in the text with its meaning in a tooltip. */
const terms = `.terms{display:grid;grid-template-columns:max-content minmax(0,var(--m));gap:8px 28px;margin:0}
.terms dt{font-weight:600}.terms dd{margin:0}
.terms dt:target,.terms dt:target+dd{background:var(--blue-l)}
.tw{position:relative}
.term{color:inherit;text-decoration:underline dotted var(--blue-m);text-decoration-thickness:1.5px;text-underline-offset:3px}
.term:hover{color:inherit}
.tip{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:20;width:max-content;max-width:20rem;padding:8px 10px;background:var(--ink);color:#fff;font-size:14px;line-height:1.45;font-weight:400;border-radius:3px;text-transform:none;letter-spacing:0;white-space:normal;text-align:left}
.tw:hover .tip,.tw:focus-within .tip{display:block}
.notip .tip{display:none!important}`;

/** The top bar and its contents. */
const bar = `.bar{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.97);border-bottom:1px solid var(--hair)}
.bar-in{max-width:1320px;margin:0 auto;padding:0 40px;display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;min-height:48px;font-size:14px}
.bar-id{font-weight:700;color:var(--ink);text-decoration:none;white-space:nowrap}
.bar nav{flex:1 1 24rem;min-width:0}
.bar ol{list-style:none;display:flex;flex-wrap:wrap;align-items:center}
.bar li{white-space:nowrap}
.bar nav a{display:inline-flex;gap:5px;align-items:baseline;padding:13px 8px;color:var(--sec);text-decoration:none}
.bar nav a:hover{color:var(--ink)}
.bar nav a[aria-current]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--ink)}
.bar .sep{width:1px;height:18px;background:var(--hair);margin:0 8px;flex:none}`;

/** The time left, hidden on narrower screens. */
const barLeft = `.bar-left{color:var(--sec);white-space:nowrap;font-variant-numeric:tabular-nums}
@media (max-width:1279px){.bar-left{display:none}}`;

/** The reading-progress rule under the bar. */
const prog = `.prog{position:absolute;left:0;right:0;bottom:-1px;height:2px;pointer-events:none}
.prog i{display:block;height:100%;width:0;background:var(--blue)}`;

/** An in-text reference (`.ref`, a genre's own token) and an issue link (`.ref-x`). */
const refs = `.ref,.ref-x{color:var(--blue);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;border-radius:2px}`;

/** A reference while its target is traced. */
const refHl = `.ref.hl{background:var(--blue);color:#fff;text-decoration:none;box-shadow:0 0 0 2px var(--blue)}`;

/** Below 1180px the margin drops under the reading column. */
const at1180 = `@media (max-width:1180px){.pair{grid-template-columns:minmax(0,1fr)}.side{margin-top:20px;max-width:var(--m)}.src{padding-top:0}}`;

/** Rules inside a genre's `@media (max-width:1100px)` block. */
const at1100 = {
  sheet: `.sheet{margin:0 auto;border:0;padding:28px 32px}`,
  bar: `.bar-in{padding:0 24px}.bar-left{display:none}`,
  meta: `.meta{grid-template-columns:repeat(2,max-content)}`,
};

/** Rules inside a genre's `@media (max-width:720px)` block: one column, labels above. */
const at720 = {
  reading: `.sheet{padding:18px 16px 40px}
.sec{display:block;padding:20px 0}
.sec>.lab{position:static;display:block;margin-bottom:10px}
.mast-id{flex-direction:row;gap:12px;padding-top:0;margin-bottom:8px}
h1{font-size:23px}
.meta{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px}.meta dd{overflow-wrap:anywhere}.meta .st{white-space:normal}
.meta .rev dd{font-size:16px}`,
  terms: `.terms{grid-template-columns:1fr;gap:2px}.terms dd{margin-bottom:10px}`,
  bar: `.bar-in{padding:0 8px 0 14px;gap:0 8px}.bar nav a{padding:13px 7px}`,
  tip: `.tip{max-width:calc(100vw - 48px)}`,
};

/** Rules inside a genre's `@media print` block: no chrome, one column, citations kept. */
const print = {
  meta: `.meta{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8pt 16pt}.meta dd{word-break:break-word}.mono{font-size:9pt}`,
  page: `@page{margin:16mm 14mm}
body{background:#fff;font-size:10pt;line-height:1.45}
.tip{display:none!important}
.sheet{border:0;margin:0;padding:0;max-width:none}
.sec{--lab:7.5rem;--gap:1.25rem;padding:14pt 0}
.pair{grid-template-columns:minmax(0,1fr)}.side{margin-top:10pt}`,
  h1: `h1{font-size:18pt}`,
  term: `.term{text-decoration:none}`,
  lab: `.lab,h2,h3{break-after:avoid}`,
  ext: `a.ext::after{content:" (" attr(href) ")";font-size:.85em;color:var(--sec);word-break:break-all}`,
};

export const KIT_CSS = {
  root,
  base,
  frame,
  secLab,
  reading,
  claims,
  terms,
  bar,
  barLeft,
  prog,
  refs,
  refHl,
  at1180,
  at1100,
  at720,
  print,
} as const;
