/**
 * The stylesheet of the audit sheet: the sheet kit's reading system, plus
 * the audit's own regions: the counts beside the summary, the maturity map,
 * the recommendation cards with their choices, the criterion lists, the
 * configuration findings and the decisions tray.
 *
 * The ladder rungs have one colour each, used for a criterion's square in the
 * map and for its score chip, so the map's legend reads the whole sheet.
 * Colours are named constants, so the contrast test can hold every pair of
 * text and background to WCAG AA.
 */
import {
  KIT_CSS as K,
  KIT_TEXT_PAIRS,
  OUTCOME_INK,
  TOKEN_TINTS,
} from "../../../decide/scripts/sheet-kit/css.ts";
import { PALETTE } from "../../../decide/scripts/sheet-kit/html.ts";

/**
 * A criterion not there yet: a neutral grey, not a warning colour. Whether
 * it matters depends on the profile, so the gap within the target is marked
 * separately (an amber ring) and nothing beyond it is.
 */
const ABSENT_FILL = "#eef1f4";

/** The fill of each rung, weakest to strongest, and of a criterion the shape rules out. */
export const RUNG_FILL = {
  absent: ABSENT_FILL,
  convention: "oklch(0.88 0.05 255)",
  advisory: "oklch(0.7 0.1 255)",
  mechanical: PALETTE.accent,
  "expected-absent": PALETTE.hairLight,
} as const;

/** The text drawn on each rung's fill, in a score chip. */
export const RUNG_INK = {
  absent: PALETTE.ink,
  convention: PALETTE.ink,
  advisory: PALETTE.ink,
  mechanical: PALETTE.surface,
  "expected-absent": PALETTE.muted,
} as const;

/** Every text-on-background pair the stylesheet draws, for the contrast test. Each is [foreground, background, where]. */
export const TEXT_PAIRS: readonly [string, string, string][] = [
  ...KIT_TEXT_PAIRS,
  ...Object.entries(RUNG_INK).map(([rung, ink]): [string, string, string] => [
    ink,
    RUNG_FILL[rung as keyof typeof RUNG_FILL],
    `a ${rung} score chip`,
  ]),
  [PALETTE.ink, PALETTE.bg, "a level, the copy preview, the tray"],
  [PALETTE.muted, PALETTE.bg, "a criterion's evidence"],
  [OUTCOME_INK.emerald, PALETTE.surface, "at target, fixed"],
  [OUTCOME_INK.amber, PALETTE.surface, "to go, a warning"],
  [OUTCOME_INK.red, PALETTE.surface, "an error, a regression"],
  [
    OUTCOME_INK.emerald,
    TOKEN_TINTS.emeraldLight,
    "a declared profile, a quick win",
  ],
  [OUTCOME_INK.amber, TOKEN_TINTS.amberLight, "a suggested profile"],
  [PALETTE.accent, TOKEN_TINTS.blueLight, "a recommendation id"],
  [PALETTE.surface, OUTCOME_INK.emerald, "Accept, chosen"],
  [PALETTE.surface, PALETTE.accent, "Refine, chosen; the copy button"],
  [PALETTE.surface, OUTCOME_INK.amber, "Decline, chosen"],
  [PALETTE.surface, OUTCOME_INK.red, "This is wrong, chosen"],
  [PALETTE.ink, PALETTE.surface, "a choice not chosen"],
];

/** The counts beside the summary. */
const inShort = `.lead{max-width:var(--m);font-size:18px;line-height:1.55}
.stats{list-style:none;display:grid;gap:16px}
.stats li{border-left:3px solid var(--rule);padding:2px 0 2px 14px;font-size:15px;line-height:1.4;color:var(--sec)}
.stats .big{display:block;font-size:30px;line-height:1.15;font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin-bottom:2px}
.stats .big small{font-size:17px;font-weight:500;color:var(--sec);letter-spacing:0}
.stats .met{border-left-color:var(--blue)}
.pchip{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:1px 7px;border-radius:999px;vertical-align:.1em}
.p-declared{color:var(--em-ink);background:var(--em-l)}
.p-suggested{color:var(--am-ink);background:var(--am-l)}
.why{max-width:var(--m);margin-top:10px;color:var(--sec);font-size:15px}`;

/** The maturity map: a row per module, a square per criterion. */
const map = `.intro{max-width:var(--m);color:var(--sec);margin-bottom:16px}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:var(--sec);margin-bottom:18px}
.legend li{display:flex;align-items:center;gap:7px}
.legend b{font-weight:600;color:var(--ink)}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) 10.5rem minmax(0,15rem);column-gap:28px;align-items:start}
.mhead{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--sec);padding-bottom:8px;border-bottom:1px solid var(--rule)}
.mmap{list-style:none}
.mrow{padding:12px 0;border-bottom:1px solid var(--hair)}
.mname{font-weight:600;margin:0}
.mname code{font:inherit;color:var(--sec);margin-right:6px;font-variant-numeric:tabular-nums}
.mpur{font-size:14px;line-height:1.45;color:var(--sec);margin:2px 0 0}
.mlev{display:flex;flex-direction:column;gap:1px;font-size:14px;line-height:1.4}
.lv{display:inline-block;align-self:flex-start;font-weight:650;font-size:14px;padding:1px 8px;border-radius:3px;background:var(--bg);color:var(--ink)}
.lv-none{color:var(--sec);font-weight:500}
.tgt{color:var(--sec)}
.ok{color:var(--em-ink);font-weight:600}
.go{color:var(--am-ink);font-weight:600}
.cells{display:flex;flex-wrap:wrap;gap:4px 10px;padding-top:4px}
.grp{display:flex;gap:3px;padding-bottom:5px;border-bottom:2px solid transparent}
.grp.in{border-bottom-color:var(--ink)}
.grp.grow{border-bottom:2px dashed var(--sec)}
.c{display:inline-block;width:14px;height:14px;border-radius:2px;box-shadow:inset 0 0 0 1px rgba(31,41,51,.14);flex:none}
.c-absent{background:${RUNG_FILL.absent}}
.c-convention{background:${RUNG_FILL.convention}}
.c-advisory{background:${RUNG_FILL.advisory}}
.c-mechanical{background:${RUNG_FILL.mechanical};box-shadow:none}
.c-expected-absent{background:repeating-linear-gradient(135deg,${RUNG_FILL["expected-absent"]} 0 3px,var(--surface) 3px 6px)}
.c-unscored{background:var(--surface);box-shadow:inset 0 0 0 1px var(--sec);outline:1px dashed var(--rule)}
.c.gap{box-shadow:inset 0 0 0 2px var(--am-ink)}
.bracket{display:inline-block;width:18px;border-bottom:2px solid var(--ink);height:8px}
.bracket.grow{border-bottom-style:dashed;border-bottom-color:var(--sec)}
.hd{font-style:italic}
.mrow.na .mname,.mrow.na .mpur{color:var(--sec)}
.mrow.na .mname code{color:var(--sec)}
.na-why{font-size:14px;line-height:1.45;color:var(--sec);font-style:italic}
.psel{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px;font-size:14px;color:var(--sec)}
.psel select{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:4px 8px}`;

/** Recommendation cards, in Start here and in the full list. */
const cards = `.top{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:16px}
.sc{display:flex;flex-direction:column;gap:8px;height:100%;padding:16px 18px;border:1px solid var(--rule);border-top:3px solid var(--blue);border-radius:4px;background:var(--surface)}
.sc h4{font-size:17px;line-height:1.35}
.sc h4 a{color:var(--ink);text-decoration:none}
.sc h4 a:hover{text-decoration:underline}
.sc p{font-size:15px;line-height:1.5;color:var(--sec)}
.sc .tags{margin-top:auto}
.sub{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--sec);margin:26px 0 10px}
.sub:first-child{margin-top:0}
.qw{list-style:none;max-width:calc(var(--m) + 8rem)}
.qw li{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-top:1px solid var(--hair)}
.qw li:first-child{border-top:0}
.rid{display:inline-flex;align-items:center;justify-content:center;min-width:2.2em;padding:1px 6px;border-radius:3px;background:var(--blue-l);color:var(--blue);font-weight:650;font-size:13px;font-variant-numeric:tabular-nums;text-decoration:none;flex:none}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:inline-block;font-size:13px;line-height:1.4;padding:0 7px;border:1px solid var(--rule);border-radius:3px;color:var(--sec);white-space:nowrap}
.tag b{font-weight:600;color:var(--ink)}
.tag-qw{border-color:transparent;background:var(--em-l);color:var(--em-ink);font-weight:600}
.later{margin-top:36px;border-top:1px solid var(--rule);padding-top:16px}
.later summary{cursor:pointer;font-size:20px;font-weight:600;list-style-position:outside}
.later summary::marker{color:var(--sec)}
.later-n{color:var(--sec);font-weight:500}
.later>.intro{margin:8px 0 18px}
.grp-h{margin:34px 0 4px;font-size:19px}
.grp-h:first-child{margin-top:0}
.grp-p{max-width:var(--m);color:var(--sec);font-size:15px;margin-bottom:12px}
.recs{list-style:none;display:flex;flex-direction:column;gap:16px}
.rec{max-width:52rem;border:1px solid var(--rule);border-left:4px solid var(--rule);border-radius:4px;padding:18px 22px;background:var(--surface)}
.rec[data-choice=accept]{border-left-color:var(--em-ink)}
.rec[data-choice=refine]{border-left-color:var(--blue)}
.rec[data-choice=decline]{border-left-color:var(--am-ink)}
.rec[data-choice=wrong]{border-left-color:var(--red)}
.rec-h{display:flex;gap:12px;align-items:baseline;margin-bottom:6px}
.rec-h h4{font-size:18px;line-height:1.35}
.rec .tags{margin-bottom:12px}
.fields{display:grid;grid-template-columns:8rem minmax(0,1fr);gap:8px 18px;margin:0}
.fields dt{font-size:14px;font-weight:600;color:var(--sec);padding-top:1px}
.fields dd{margin:0;min-width:0}
.ev{list-style:none;display:flex;flex-direction:column;gap:2px}
.ev code{font-size:13px;overflow-wrap:anywhere;color:var(--sec)}
.mv{list-style:none;display:flex;flex-direction:column;gap:4px}
.mv li{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}
.mv code{font-size:13px;overflow-wrap:anywhere}
.mv .tgt{font-size:13px;color:var(--sec)}
.sch{display:inline-block;font-size:12px;font-weight:600;line-height:1.5;padding:0 7px;border-radius:3px;white-space:nowrap}
.s-absent{background:${RUNG_FILL.absent};color:${RUNG_INK.absent}}
.s-convention{background:${RUNG_FILL.convention};color:${RUNG_INK.convention}}
.s-advisory{background:${RUNG_FILL.advisory};color:${RUNG_INK.advisory}}
.s-mechanical{background:${RUNG_FILL.mechanical};color:${RUNG_INK.mechanical}}
.s-expected-absent{background:${RUNG_FILL["expected-absent"]};color:${RUNG_INK["expected-absent"]}}
.s-unscored{background:var(--surface);color:var(--sec);box-shadow:inset 0 0 0 1px var(--rule)}`;

/** The choices of a card, and the fields a choice opens. */
const choices = `.choose{margin:16px 0 0;padding:14px 0 0;border:0;border-top:1px solid var(--hair);min-width:0}
.choose legend{float:left;width:100%;font-size:14px;font-weight:600;color:var(--sec);margin-bottom:8px;padding:0}
.opts{clear:both;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ch{position:relative;display:inline-flex}
.ch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.ch span{display:inline-block;font-size:14px;font-weight:600;line-height:1.3;padding:6px 14px;border:1px solid var(--rule);border-radius:999px;color:var(--ink);background:var(--surface);cursor:pointer;user-select:none}
.ch span:hover{border-color:var(--ink)}
.ch input:focus-visible+span{outline:2px solid var(--blue);outline-offset:2px}
.ch-accept input:checked+span{background:var(--em-ink);border-color:var(--em-ink);color:#fff}
.ch-refine input:checked+span{background:var(--blue);border-color:var(--blue);color:#fff}
.ch-decline input:checked+span{background:var(--am-ink);border-color:var(--am-ink);color:#fff}
.ch-wrong input:checked+span{background:var(--red);border-color:var(--red);color:#fff}
.ch-lighter input:checked+span{background:var(--ink);border-color:var(--ink);color:#fff}
.clr{font:inherit;font-size:14px;color:var(--blue);background:none;border:0;padding:6px 4px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.more{display:grid;gap:10px;margin-top:12px}
.more label{display:flex;flex-direction:column;gap:4px;font-size:14px;font-weight:600;color:var(--sec)}
.more textarea,.more input{font:inherit;font-size:15px;font-weight:400;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:7px 9px}
.more textarea{resize:vertical;min-height:3.2em}
.more .need textarea,.more .need input{border-color:var(--am-ink)}`;

/** The criteria of each module, in Module detail. */
const detail = `.mod{border-top:1px solid var(--rule)}
.mod:last-child{border-bottom:1px solid var(--rule)}
.mod>summary{cursor:pointer;padding:12px 0;list-style-position:outside}
.mod>summary::marker{color:var(--sec)}
.mod-h{display:inline;margin:0;font-size:18px}
.mod[open]>summary{padding-bottom:4px}
.mod-h .lv{margin-left:8px;vertical-align:.1em}
.crit{list-style:none;max-width:60rem;margin-top:8px}
.crit li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;padding:10px 0;border-top:1px solid var(--hair)}
.crit .cid{font-weight:600;font-size:15px;overflow-wrap:anywhere;margin:0}
.crit .stm{font-size:15px;line-height:1.5;margin:2px 0 0}
.crit .chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:baseline;font-size:13px;color:var(--sec)}
.crit .cev{grid-column:1/-1;font-size:14px;line-height:1.5;color:var(--sec);overflow-wrap:anywhere}
.crit .cev b{font-weight:600;color:var(--sec)}
.gapt{color:var(--am-ink);font-weight:600}
.nn{color:var(--sec);font-style:italic}`;

/** Configuration findings, the starter configuration and the examined lists. */
const config = `.sev-h{margin:20px 0 8px;font-size:16px}
.sev-h:first-child{margin-top:0}
.sev-error{color:var(--red)}.sev-warning{color:var(--am-ink)}
.fl{list-style:none;max-width:calc(var(--m) + 10rem)}
.fl li{padding:7px 0;border-top:1px solid var(--hair);overflow-wrap:anywhere}
.fl li:first-child{border-top:0}
.fl code{font-size:13px;margin-right:6px}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 20px;margin:0 0 8px;font-size:15px}
.kv dt{color:var(--sec)}.kv dd{margin:0;overflow-wrap:anywhere}
.draft{white-space:pre-wrap;font:13px/1.55 var(--mono);background:var(--bg);color:var(--ink);border:1px solid var(--hair);border-radius:3px;padding:14px;max-width:calc(var(--m) + 10rem);overflow:auto;margin:8px 0}
.btn{font:inherit;font-size:14px;font-weight:600;color:#fff;background:var(--blue);border:1px solid var(--blue);border-radius:3px;padding:7px 14px;cursor:pointer}
.btn:hover{background:var(--ink);border-color:var(--ink)}
.btn:disabled{opacity:.45;cursor:not-allowed;background:var(--blue);border-color:var(--blue)}
.btn-q{color:var(--blue);background:var(--surface);border-color:var(--blue-m)}
.btn-q:hover{color:#fff}
.stack{width:100%;max-width:calc(var(--m) + 14rem);border-collapse:collapse;font-size:15px}
.stack th,.stack td{text-align:left;vertical-align:top;padding:8px 14px 8px 0;border-top:1px solid var(--hair)}
.stack thead th{border-top:0;padding-top:0;font-size:13px;color:var(--sec);font-weight:600}
.stack td code{font-size:13px;overflow-wrap:anywhere;color:var(--sec)}
.plain{padding-left:1.1em;max-width:var(--m)}
.plain li{margin-bottom:.35em}
.plain li::marker{color:var(--sec)}
.chg{list-style:none;display:flex;flex-direction:column;gap:3px;max-width:calc(var(--m) + 10rem)}
.chg code{font-size:13px}
.gone{color:var(--red)}.got{color:var(--em-ink)}`;

/** The decisions tray, fixed at the bottom once a choice exists. */
const tray = `.tray{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--surface);border-top:1px solid var(--rule);box-shadow:0 -8px 24px rgba(30,41,59,.12)}
.tray-in{max-width:1320px;margin:0 auto;padding:12px 40px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px}
.tray h2{font-size:15px}
.counts{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px;color:var(--ink);margin:0}
.counts b{font-variant-numeric:tabular-nums}
.tray-acts{display:flex;align-items:center;gap:10px;margin-left:auto}
.miss{flex-basis:100%;font-size:14px;color:var(--am-ink);margin:0}
.done{color:var(--em-ink);font-weight:600;font-size:14px}
.preview{flex-basis:100%;white-space:pre-wrap;font:13px/1.5 var(--mono);background:var(--bg);color:var(--ink);border:1px solid var(--hair);border-radius:3px;padding:12px;margin:0;max-height:40vh;overflow:auto}
html.has-tray body{padding-bottom:var(--tray-h,96px)}`;

export const REPORT_CSS = `
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
${inShort}
${map}
${cards}
${choices}
${detail}
${config}
${tray}
${K.at1180}
@media (max-width:1100px){${K.at1100.sheet}.sec{--lab:9rem;--gap:1.75rem}${K.at1100.bar}
${K.at1100.meta}.tray-in{padding:12px 24px}}
@media (max-width:860px){.mhead{display:none}.mrow{grid-template-columns:minmax(0,1fr) 8rem;row-gap:8px}.cells{grid-column:1/-1}}
@media (max-width:720px){
${K.at720.reading}
${K.at720.terms}
${K.at720.bar}
${K.at720.tip}
.rec{padding:16px}
.fields{grid-template-columns:1fr;gap:2px}.fields dd{margin-bottom:10px}
.crit li{grid-template-columns:1fr}.crit .chips{justify-content:flex-start}
.ch span{padding:10px 14px}
.tray-in{padding:10px 16px}.tray-acts{margin-left:0}
.stack thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.stack tr{display:block;padding:8px 0;border-top:1px solid var(--hair)}.stack td{display:block;border:0;padding:2px 0}
}
@media print{
${K.print.meta}
.bar,.tray,[data-js]{display:none!important}
html.has-tray body{padding-bottom:0}
.sec>.lab{position:static}
${K.print.page}
${K.print.h1}.lead{font-size:11pt}
${K.print.term}
.c,.sch,.lv,.pchip,.rid,.tag-qw{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.mrow,.rec,.sc,.crit li,.claims li,.fl li,.stack tr{break-inside:avoid}
${K.print.lab}
${K.print.ext}
}`;
