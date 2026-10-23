/**
 * The stylesheet of the explainer sheet: the sheet kit's reading
 * system, plus the explainer's own regions: the lead, the scope beside the
 * summary, the numbered flow, the figures and the open questions.
 */
import {
  KIT_CSS as K,
  KIT_TEXT_PAIRS,
} from "../../../decide/scripts/sheet-kit/css.ts";
import { PALETTE } from "../../../decide/scripts/sheet-kit/html.ts";

/** Every text-on-background pair the stylesheet draws, for the contrast test. Each is [foreground, background, where]. */
export const TEXT_PAIRS: readonly [string, string, string][] = [
  ...KIT_TEXT_PAIRS,
  [PALETTE.accent, PALETTE.surface, "a step number"],
];

export const EXPLAINER_CSS = `
${K.root}
${K.base}
${K.frame}
${K.secLab}
${K.reading}
${K.claims}
${K.terms}
${K.bar}
${K.barLeft}
${K.prog}
${K.refs}
${K.refHl}
.lead{max-width:var(--m);font-size:17px;line-height:1.5;margin-bottom:10px}
.scope h3{margin-top:14px}.scope h3:first-child{margin-top:0}
.scope ul{padding-left:1.1em}
.scope li{margin-bottom:.3em}
.scope li::marker{color:var(--sec)}
.steps{list-style:none}
.step{padding:10px 0;border-radius:2px}
.step+.step{border-top:1px solid var(--hair)}
.step h3{display:flex;gap:10px;align-items:baseline;font-size:17px;line-height:1.4;margin-bottom:4px}
.sn{display:inline-grid;place-items:center;min-width:1.6em;height:1.6em;padding:0 .3em;border:1px solid var(--blue-m);border-radius:999px;color:var(--blue);font-size:.85em;font-weight:600;font-variant-numeric:tabular-nums;flex:none;text-decoration:none}
.step.hl .sn,.sn:hover{background:var(--blue);border-color:var(--blue);color:#fff}
.step.hl{background:var(--blue-l);box-shadow:0 0 0 8px var(--blue-l)}
.step>.main>p{padding-left:calc(1.6em + 10px)}
.fig{margin:0}
.fig svg{display:block;width:100%;height:auto;max-width:980px}
.fig figcaption{max-width:var(--m);margin-top:12px;color:var(--sec);font-size:15px;line-height:1.45}
.fig figcaption b{color:var(--ink)}
.fig figcaption code{font-size:13px}
.oq{padding-left:1.4em;max-width:var(--m)}
.oq li{margin-bottom:.5em}
.oq li::marker{color:var(--am-ink);font-weight:600}
.rel{list-style:none;display:flex;flex-direction:column;gap:4px;max-width:var(--m)}
${K.at1180}
@media (max-width:1100px){${K.at1100.sheet}.sec{--lab:9rem;--gap:1.75rem}${K.at1100.bar}
${K.at1100.meta}}
@media (max-width:720px){
${K.at720.reading}
${K.at720.terms}
${K.at720.bar}
${K.at720.tip}
.step>.main>p{padding-left:0}
}
@media print{
${K.print.meta}
.bar,[data-js]{display:none!important}
.sec>.lab{position:static}
${K.print.page}
${K.print.h1}.lead{font-size:11pt}
${K.print.term}
.sn{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.step,.claims li,.fig,.oq li{break-inside:avoid}
${K.print.lab}
${K.print.ext}
.hl{outline:0!important;box-shadow:none!important;background:none!important}
}`;
