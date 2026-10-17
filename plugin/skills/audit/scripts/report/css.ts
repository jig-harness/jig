/**
 * The stylesheet of the audit sheet: the sheet kit's reading system, plus
 * the audit's own regions: the counts beside the summary, the maturity map,
 * the recommendation cards with their choices, the criterion lists, the
 * configuration findings, the comparison with the last audit, the guide and
 * the decisions tray.
 *
 * The ladder rungs have one colour and one icon each, used for a criterion's
 * mark in the map and for its score chip, so the map's legend reads the
 * whole sheet; each icon is drawn in its rung's ink, so it holds the same
 * contrast as the chip's text. Colours are named constants, so the contrast
 * test can hold every pair of text and background to WCAG AA.
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

/** The fill of each rung, weakest to strongest, of a criterion the shape rules out, and of one the audit did not examine. */
export const RUNG_FILL = {
  absent: ABSENT_FILL,
  convention: "oklch(0.9 0.045 255)",
  advisory: "oklch(0.72 0.1 255)",
  mechanical: PALETTE.accent,
  "expected-absent": PALETTE.hairLight,
  "not-examined": PALETTE.bg,
} as const;

/** The text and icon drawn on each rung's fill: grey for nothing there, then blues that deepen with the rung. */
export const RUNG_INK = {
  absent: PALETTE.muted,
  convention: PALETTE.accent,
  advisory: "oklch(0.3 0.08 255)",
  mechanical: PALETTE.surface,
  "expected-absent": PALETTE.muted,
  "not-examined": PALETTE.muted,
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
  [
    OUTCOME_INK.amber,
    PALETTE.surface,
    "a gap no recommendation covers, its count",
  ],
  [OUTCOME_INK.red, PALETTE.surface, "an error, a regression, a level down"],
  [OUTCOME_INK.emerald, PALETTE.surface, "a level up in the trend"],
  [PALETTE.ink, PALETTE.bg, "a signal to revisit the profile"],
  [PALETTE.muted, PALETTE.bg, "a signal's evidence"],
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
  [PALETTE.ink, PALETTE.surface, "a conditional target and its condition"],
  [PALETTE.muted, PALETTE.surface, "This score is wrong, not chosen"],
  [OUTCOME_INK.red, PALETTE.surface, "This score is wrong, chosen"],
  [PALETTE.muted, PALETTE.surface, "a criterion without a score, its icon"],
  [PALETTE.ink, PALETTE.surface, "a module chip, a popover"],
  [PALETTE.muted, PALETTE.surface, "a popover's field names"],
  [OUTCOME_INK.amber, TOKEN_TINTS.amberLight, "a popover's gap line"],
  [OUTCOME_INK.emerald, TOKEN_TINTS.emeraldLight, "a popover's met line"],
  [PALETTE.muted, PALETTE.bg, "a popover's not-needed line"],
  [PALETTE.surface, OUTCOME_INK.red, "a regressed badge"],
  [OUTCOME_INK.emerald, TOKEN_TINTS.emeraldLight, "a fixed badge"],
  [PALETTE.accent, TOKEN_TINTS.blueLight, "a new or added-by-Jig badge"],
  [PALETTE.ink, PALETTE.hairLight, "a reclassified badge"],
  [PALETTE.muted, PALETTE.bg, "a removed badge"],
  [OUTCOME_INK.amber, TOKEN_TINTS.amberLight, "a still-open badge"],
  [PALETTE.muted, ABSENT_FILL, "a still-open-beyond badge"],
  [PALETTE.ink, PALETTE.hairLight, "an examined-at-one-audit-only badge"],
  [
    OUTCOME_INK.emerald,
    TOKEN_TINTS.emeraldLight,
    "an applied recommendation's tag",
  ],
  [PALETTE.ink, PALETTE.surface, "a needs-an-admin tag"],
  [PALETTE.ink, PALETTE.bg, "a gap left on purpose, the alternative profile"],
  [PALETTE.muted, PALETTE.bg, "an alternative profile's reasons"],
  [OUTCOME_INK.emerald, PALETTE.surface, "an unchanged-and-met badge"],
  [PALETTE.ink, TOKEN_TINTS.blueLight, "the welcome, a guide note"],
  [PALETTE.accent, TOKEN_TINTS.blueLight, "the welcome's link"],
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
.p-explored{color:var(--ink);background:var(--hair)}
.why{max-width:var(--m);margin-top:10px;color:var(--sec);font-size:15px}
.sig-l{font-size:14px;margin-left:4px;white-space:nowrap}
.signals{max-width:var(--m);margin-top:18px;padding:12px 16px;border-left:3px solid var(--rule);background:var(--bg)}
.signals h3{font-size:15px;margin:0 0 4px}
.signals .intro{font-size:14px;margin-bottom:8px}
.signals ul{list-style:none;display:flex;flex-direction:column;gap:8px}
.signals li p{margin:0;font-size:15px}
.signals .src{color:var(--sec);overflow-wrap:anywhere}
.alt{max-width:var(--m);margin-top:18px;padding:12px 16px;border-left:3px solid var(--rule);background:var(--bg);color:var(--ink)}
.alt h3{font-size:16px;margin-bottom:4px}
.alt ul{padding-left:1.1em;color:var(--sec)}
.alt p{margin:6px 0 0}
.signals code{font-size:13px;margin-right:6px}`;

/** The maturity map: a row per module, a mark per criterion. */
const map = `.intro{max-width:var(--m);color:var(--sec);margin-bottom:16px}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:var(--sec);margin-bottom:18px}
.legend li{display:flex;align-items:center;gap:7px}
.legend b{font-weight:600;color:var(--ink)}
.mhead,.mrow{display:grid;grid-template-columns:minmax(0,1fr) 10rem minmax(0,25rem);column-gap:28px;align-items:start}
.mhead .term{color:inherit}
.mhead{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--sec);padding-bottom:8px;border-bottom:1px solid var(--rule)}
.mmap{list-style:none}
.mrow{padding:12px 0;border-bottom:1px solid var(--hair)}
.mname{font-weight:600;margin:0}
.mpur{font-size:14px;line-height:1.45;color:var(--sec);margin:2px 0 0}
.mlev{display:flex;flex-direction:column;gap:1px;font-size:14px;line-height:1.4}
.lv{display:inline-block;align-self:flex-start;font-weight:650;font-size:14px;padding:1px 8px;border-radius:3px;background:var(--bg);color:var(--ink)}
.lv-none{color:var(--sec);font-weight:500}
.tgt{color:var(--sec)}
.ok{color:var(--em-ink);font-weight:600}
.go{color:var(--am-ink);font-weight:600}
.cells{position:relative;display:flex;flex-wrap:wrap;gap:6px 10px;padding-top:1px}
.grp{display:flex;gap:3px;padding-bottom:5px;border-bottom:2px solid transparent}
.grp.in{border-bottom-color:var(--ink)}
.grp.grow{border-bottom:2px dashed var(--sec)}
.cells .pw{position:static}
.cw{display:inline-flex;border-radius:5px;text-decoration:none}
.cw:focus-visible{outline:0}
.cw:hover .c,.cw:focus-visible .c{outline:2px solid var(--ink);outline-offset:1px}
.c{position:relative;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;flex:none}
.c .ic{width:14px;height:14px}
.c-absent{background:${RUNG_FILL.absent};color:${RUNG_INK.absent}}
.c-convention{background:${RUNG_FILL.convention};color:${RUNG_INK.convention}}
.c-advisory{background:${RUNG_FILL.advisory};color:${RUNG_INK.advisory}}
.c-mechanical{background:${RUNG_FILL.mechanical};color:${RUNG_INK.mechanical}}
.c-expected-absent{background:repeating-linear-gradient(135deg,${RUNG_FILL["expected-absent"]} 0 3px,var(--surface) 3px 6px);color:${RUNG_INK["expected-absent"]};box-shadow:inset 0 0 0 1px var(--hair)}
.c-not-examined{background:${RUNG_FILL["not-examined"]};color:${RUNG_INK["not-examined"]};outline:1px dotted var(--rule);outline-offset:-1px}
.c-unscored{background:var(--surface);color:var(--sec);outline:1px dashed var(--rule);outline-offset:-1px}
.c.gap{box-shadow:inset 0 0 0 2px var(--am-ink)}
.c.unc::after{content:"";position:absolute;right:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:var(--am-ink);box-shadow:0 0 0 1.5px var(--surface)}
.bracket{display:inline-block;width:18px;border-bottom:2px solid var(--ink);height:8px}
.bracket.grow{border-bottom-style:dashed;border-bottom-color:var(--sec)}
.hd{font-style:italic}
.mrow.na .mname,.mrow.na .mpur{color:var(--sec)}
.mrow.na .mchip{color:var(--sec)}
.na-why{font-size:14px;line-height:1.45;color:var(--sec);font-style:italic}
.psel{margin-top:16px;font-size:14px;color:var(--sec)}
.psel-p{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0}
.psel select{font:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:4px 8px}
.conds{border:0;padding:0;margin:12px 0 0;min-width:0;max-width:calc(var(--m) + 10rem)}
.conds legend{font-weight:600;color:var(--sec);padding:0;margin-bottom:4px}
.cond{display:flex;gap:8px;align-items:baseline;padding:3px 0;color:var(--ink);cursor:pointer}
.cond input{flex:none;margin:0}
.cond b{font-weight:600}`;

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
.tag-done{border-color:transparent;background:var(--em-l);color:var(--em-ink);font-weight:600;white-space:normal}
.tag-done a{color:inherit}
.tag-admin{border-color:var(--ink);color:var(--ink);font-weight:600}
.rec.done{border-left-color:var(--em-ink);background:var(--bg)}
.later{margin-top:36px;border-top:1px solid var(--rule);padding-top:16px}
.later summary{cursor:pointer;font-size:20px;font-weight:600;list-style-position:outside}
.later summary::marker{color:var(--sec)}
.later-n{color:var(--sec);font-weight:500}
.later>.intro{margin:8px 0 18px}
.later.sm{margin-top:20px;padding-top:12px}
.later.sm summary{font-size:16px}
.later.sm>.intro{margin:6px 0 10px}
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
.sch{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:1.5;padding:0 7px 0 5px;border-radius:3px;white-space:nowrap;vertical-align:.05em}
.sch .ic{width:12px;height:12px}
.s-absent{background:${RUNG_FILL.absent};color:${RUNG_INK.absent}}
.s-convention{background:${RUNG_FILL.convention};color:${RUNG_INK.convention}}
.s-advisory{background:${RUNG_FILL.advisory};color:${RUNG_INK.advisory}}
.s-mechanical{background:${RUNG_FILL.mechanical};color:${RUNG_INK.mechanical}}
.s-expected-absent{background:${RUNG_FILL["expected-absent"]};color:${RUNG_INK["expected-absent"]}}
.s-not-examined{background:${RUNG_FILL["not-examined"]};color:${RUNG_INK["not-examined"]};box-shadow:inset 0 0 0 1px var(--rule)}
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
.unct{color:var(--am-ink);border:1px solid var(--am-ink);border-radius:3px;padding:0 6px}
.nn{color:var(--sec);font-style:italic}
.crit li[data-flag]{box-shadow:inset 3px 0 0 var(--red);padding-left:12px}
.sw{grid-column:1/-1;display:flex;flex-direction:column;gap:6px}
.swl{display:inline-flex;gap:6px;align-items:center;align-self:flex-start;font-size:14px;color:var(--sec);cursor:pointer}
.swl input{margin:0}
li[data-flag] .swl{color:var(--red);font-weight:600}
.swn{display:flex;flex-direction:column;gap:4px;font-size:14px;font-weight:600;color:var(--sec);max-width:40rem}
.swn textarea{font:inherit;font-size:15px;font-weight:400;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:3px;padding:7px 9px;resize:vertical;min-height:3.2em}
.swn.need textarea{border-color:var(--am-ink)}`;

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
.gone{color:var(--red)}.got{color:var(--em-ink)}
.trend-s{font-weight:600;margin-bottom:4px}
.mv-up{color:var(--em-ink);font-weight:600}.mv-down{color:var(--red);font-weight:600}
.uncov{margin-top:34px;max-width:calc(var(--m) + 10rem)}
.uncov .intro{margin-bottom:8px}
.left{margin-top:34px;max-width:calc(var(--m) + 10rem)}
.left .intro{margin-bottom:8px}
.left .lr{display:block;margin-top:2px;color:var(--ink)}
.left .lw{display:block;color:var(--sec);font-size:14px}`;

/**
 * Icons, module chips, criterion refs and the popovers beside them. A popover
 * takes the pointer, and its transparent edge reaches across the gap to what
 * it explains, so the reader can move onto it and select its text.
 */
const marks = `.sprite{position:absolute;width:0;height:0;overflow:hidden}
.ic{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mchip{display:inline-flex;align-items:center;justify-content:center;min-width:2.4em;padding:0 6px;border:1px solid var(--rule);border-radius:4px;background:var(--surface);color:var(--ink);font:600 12.5px/1.55 var(--sans);font-variant-numeric:tabular-nums;text-decoration:none;white-space:nowrap;vertical-align:.08em}
a.mchip:hover{border-color:var(--ink);color:var(--ink)}
.cref{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px}
.cref a{color:var(--ink);text-decoration-color:var(--rule)}
.cref code,.cc code{font-size:13px;overflow-wrap:anywhere}
.pw{position:relative}
.pop{display:none;position:absolute;left:0;top:calc(100% + 6px);z-index:60;width:max-content;max-width:min(22rem,calc(100vw - 24px));padding:10px 12px;background:var(--surface);color:var(--ink);border:1px solid var(--rule);border-radius:6px;box-shadow:0 10px 28px rgba(30,41,59,.18);font:400 14px/1.45 var(--sans);text-align:left;white-space:normal;text-transform:none;letter-spacing:0}
.pop::before{content:"";position:absolute;left:0;right:0;top:-8px;bottom:-8px;z-index:-1}
.pw:hover>.pop,.pw:focus-within>.pop,.mod>summary:focus-visible .pop{display:block}
.notip .pop{display:none!important}
.cells .pop{max-width:min(24rem,100%)}
html.js .pop,html.js .tw>.tip{position:fixed}html.js .tw>.tip{pointer-events:none}
html.js .cells .pop{max-width:min(24rem,calc(100vw - 24px))}
.pop-m b{display:block;font-weight:650;margin-bottom:2px}
.grp-h .mw,.mod-h .mw,.mname .mw{margin-right:9px}
.pc-h{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.pc-h b{font-weight:650;overflow-wrap:anywhere}
.pc-s{display:block;margin-bottom:8px}
.pc-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 10px;align-items:center;font-size:13px;color:var(--sec);margin-bottom:6px}
.pc-k{font-weight:600}
.pc-st{display:block;margin-top:4px;padding:3px 8px;border-radius:4px;font-size:13px;font-weight:600}
.st-gap{color:var(--am-ink);background:var(--am-l)}
.st-ok{color:var(--em-ink);background:var(--em-l)}
.st-nn{color:var(--sec);background:var(--bg)}`;

/** Since the last audit: the counts as badges and the tables of changes. */
const since = `.bds{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 22px}
.bd{display:inline-flex;align-items:baseline;gap:6px;font-size:12.5px;font-weight:600;line-height:1.5;padding:1px 9px;border-radius:999px;white-space:nowrap}
.bds .bd{font-size:14px;padding:3px 12px}
.bd b{font-weight:700;font-variant-numeric:tabular-nums}
.bd-regressed{background:var(--red);color:#fff}
.bd-fixed{background:var(--em-l);color:var(--em-ink)}
.bd-new,.bd-added-by-jig{background:var(--blue-l);color:var(--blue)}
.bd-reclassified{background:var(--hair);color:var(--ink)}
.bd-removed{background:var(--bg);color:var(--sec);box-shadow:inset 0 0 0 1px var(--rule)}
.bd-open{background:var(--am-l);color:var(--am-ink)}
.bd-beyond{background:${ABSENT_FILL};color:var(--sec)}
.bd-examined,.bd-unexamined{background:var(--hair);color:var(--ink)}
.bd-unchanged{background:var(--surface);color:var(--em-ink);box-shadow:inset 0 0 0 1px var(--em-ink)}
.chgt{width:100%;max-width:calc(var(--m) + 16rem);border-collapse:collapse;font-size:14px;margin-bottom:6px}
.chgt th,.chgt td{text-align:left;vertical-align:middle;padding:7px 16px 7px 0;border-top:1px solid var(--hair)}
.chgt thead th{border-top:0;padding-top:0;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--sec)}
.chgt tbody th{font-weight:500}
.chgt tbody th .mw{margin-right:6px}
.chgt td:first-child{width:1%}
.chg-t{table-layout:fixed}
.chg-t th:nth-child(1){width:4.5rem}.chg-t th:nth-child(3){width:15.5rem}.chg-t th:nth-child(4){width:8.5rem}
.g-pt{table-layout:fixed}.g-pt th:first-child{width:36%}
.cc a{color:var(--ink);text-decoration-color:var(--rule)}
.ba{white-space:nowrap}
.arr{color:var(--sec);margin:0 6px}
.nos{color:var(--sec)}
.trend-s{font-weight:600;margin-bottom:4px}
.trend-w{position:relative;max-width:100%;overflow-x:auto}
.trend{width:auto;font-variant-numeric:tabular-nums}
.trend td,.lvt td{white-space:nowrap}
.mv-up{color:var(--em-ink);font-weight:600}.mv-down{color:var(--red);font-weight:600}`;

/** The guide: its own view with the script, the page's last section without it and in print. */
const guide = `@media screen{html.js:not(.guide-on) .guide{display:none}
html.guide-on .sheet>:not(.guide){display:none}
html.guide-on .guide{border-top:0;padding-top:4px}
html.guide-on .tray{display:none!important}
html.guide-on body{padding-bottom:0}}
.welcome{margin-top:22px;max-width:calc(var(--m) + 10rem);padding:14px 18px;border-left:4px solid var(--blue);background:var(--blue-l);border-radius:4px;color:var(--ink)}
.welcome p{margin:0}
.welcome p+p{margin-top:6px}
.welcome a{font-weight:650}
.howto{margin:14px 0 0;font-size:14px}
.g-back{margin:0 0 12px}
.g-back a{font-weight:600}
.g-toc ol{list-style:none;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:14px;margin:12px 0 0}
.g-sec{max-width:calc(var(--m) + 14rem);margin-top:26px;padding-top:20px;border-top:1px solid var(--hair)}
.g-sec h3{font-size:21px;margin-bottom:10px}
.g-sec h4{font-size:16px;margin:20px 0 6px}
.g-sec p{max-width:var(--m)}
.g-ladder{list-style:none;display:flex;flex-direction:column;gap:8px;margin:12px 0 14px;max-width:calc(var(--m) + 6rem)}
.g-ladder li{display:grid;grid-template-columns:9.5rem minmax(0,1fr);gap:4px 14px;align-items:baseline}
.g-ladder .sch{justify-self:start}
.g-mods{list-style:none;margin-top:8px}
.g-mods li{display:grid;grid-template-columns:3.4rem minmax(0,1fr);gap:2px 10px;padding:9px 0;border-top:1px solid var(--hair)}
.g-mods li>span:last-child{color:var(--sec)}
.g-mods b{display:block;color:var(--ink)}
.g-note{max-width:var(--m);margin:14px 0;padding:10px 14px;border-left:3px solid var(--blue-m);background:var(--blue-l);color:var(--ink)}
.g-who{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 18px;margin:10px 0 14px;max-width:calc(var(--m) + 8rem)}
.g-who dt{font-weight:650}.g-who dd{margin:0}
.g-tw{max-width:100%;overflow-x:auto;margin-top:8px}
.g-pt td{vertical-align:top}
.g-when{display:block;font-size:13px;color:var(--sec);max-width:14rem;white-space:normal}
.g-steps{padding-left:1.5em;max-width:var(--m)}
.g-steps li{margin-bottom:8px}
.g-steps li::marker{color:var(--sec);font-weight:600}
.g-read{display:grid;grid-template-columns:minmax(0,1fr);gap:4px;margin:0;max-width:var(--m)}
.g-read dt{font-weight:650;margin-top:10px}.g-read dd{margin:0}
.g-words{grid-template-columns:max-content minmax(0,var(--m))}
.g-links{padding-left:1.1em}`;

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
${marks}
${since}
${guide}
${tray}
${K.at1180}
@media (max-width:1100px){${K.at1100.sheet}.sec{--lab:9rem;--gap:1.75rem}${K.at1100.bar}
${K.at1100.meta}.tray-in{padding:12px 24px}}
@media (max-width:860px){.mhead{display:none}.mrow{grid-template-columns:minmax(0,1fr) 8rem;row-gap:8px}.cells{grid-column:1/-1}}
@media (max-width:720px){.chgt:not(.trend):not(.lvt):not(.g-pt) thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.chgt:not(.trend):not(.lvt):not(.g-pt) tr{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:9px 0;border-top:1px solid var(--hair)}
.chgt:not(.trend):not(.lvt):not(.g-pt) td{border:0;padding:0;width:auto}
.chgt .cc{flex:1 1 60%;min-width:0}
.chg-t,.g-pt{table-layout:auto}.chg-t th,.g-pt th{width:auto!important}
.g-ladder li,.g-who,.g-words{grid-template-columns:1fr}
.g-who dd{margin-bottom:6px}}
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
.c,.sch,.lv,.pchip,.rid,.tag-qw,.bd,.mchip,.welcome,.g-note{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pop,.howto{display:none!important}
.guide{break-before:page}
.mrow,.rec,.sc,.crit li,.claims li,.fl li,.stack tr,.chgt tr,.g-mods li{break-inside:avoid}
${K.print.lab}
${K.print.ext}
}`;
