/**
 * The stylesheet of the document template, ported from a reference renderer
 * drawn in Claude Design (`render-v2.js`).
 *
 * The reading system (frame, sections, claims, terms, top bar, print) comes
 * from the sheet kit (`../sheet-kit/css.ts`), interpolated where it
 * always stood, so the cascade order is unchanged. The rules here are the
 * decision-only ones: status, owners, chips, the outcome matrix, options,
 * branches, the call index, interplay, calls, picks and the tray.
 *
 * Colours are named constants, not literals in the rules below, so a test can
 * hold each pair that sits on another to WCAG AA.
 */
import { KIT_CSS as K, OUTCOME_INK, TOKEN_TINTS } from "../sheet-kit/css.ts";
import { PALETTE } from "../sheet-kit/html.ts";

/** A faint blue behind a highlighted call row. Text on it stays primary ink. */
export const HIGHLIGHT_ROW = "oklch(0.975 0.012 250)";

/** Every text-on-background pair the stylesheet draws, for the contrast test. Each is [foreground, background, where]. */
export const TEXT_PAIRS: readonly [string, string, string][] = [
  [PALETTE.ink, PALETTE.surface, "body text"],
  [PALETTE.muted, PALETTE.surface, "secondary text"],
  [PALETTE.accent, PALETTE.surface, "links, chips, picks"],
  [PALETTE.accent, TOKEN_TINTS.blueLight, "a reference the reader picked"],
  [PALETTE.ink, TOKEN_TINTS.blueLight, "a traced owner, call or term"],
  [PALETTE.muted, PALETTE.bg, "secondary text on the page"],
  [PALETTE.ink, PALETTE.bg, "copy preview"],
  [OUTCOME_INK.emerald, PALETTE.surface, "ruled state, chosen tag"],
  [OUTCOME_INK.emerald, TOKEN_TINTS.emeraldLight, "Safe tile"],
  [OUTCOME_INK.amber, PALETTE.surface, "open state, next step"],
  [OUTCOME_INK.amber, TOKEN_TINTS.amberLight, "Human tile"],
  [OUTCOME_INK.red, PALETTE.surface, "Risk label"],
  [OUTCOME_INK.red, OUTCOME_INK.redLight, "Risk tile"],
  [PALETTE.ink, TOKEN_TINTS.emeraldLight, "text in a Safe tile"],
  [PALETTE.ink, OUTCOME_INK.redLight, "text in a Risk tile"],
  [PALETTE.ink, TOKEN_TINTS.amberLight, "text in a Human tile"],
  [PALETTE.ink, HIGHLIGHT_ROW, "a highlighted call row"],
  [PALETTE.surface, PALETTE.accent, "a pressed pick, a traced chip"],
  [PALETTE.surface, PALETTE.ink, "a term tip"],
];

export const DOCUMENT_CSS = `
${K.root}
${K.base}
${K.frame}
${K.secLab}.sec-o>.lab{position:static}
${K.reading}
.st{font-weight:600;white-space:nowrap}
.st-open,.st-part{color:var(--am-ink)}.st-done{color:var(--em-ink)}
.own{border-radius:3px;padding:0 3px;margin:0 -3px}
.own[tabindex]{cursor:default;text-decoration:underline dotted var(--rule);text-underline-offset:3px}
.own.hl{background:var(--blue-l)}
.chip,.cchip{display:inline-flex;align-items:center;justify-content:center;min-width:1.6em;height:1.6em;padding:0 .3em;border:1px solid var(--blue-m);border-radius:3px;color:var(--blue);background:var(--surface);font-weight:600;font-size:.85em;line-height:1;text-decoration:none;font-variant-numeric:tabular-nums;vertical-align:.08em;flex:none}
.cchip{border-radius:999px}
.chip.hl,.cchip.hl,.chip:hover,.cchip:hover{background:var(--blue);border-color:var(--blue);color:#fff}
.tag{display:inline-block;font-size:13px;font-weight:500;line-height:1.35;padding:0 6px;border:1px solid var(--rule);border-radius:3px;color:var(--sec);white-space:nowrap}
.tag-chosen{border-color:var(--em-ink);color:var(--em-ink)}
.mx{width:calc(100% + 6px);border-collapse:separate;border-spacing:3px;margin:-3px;table-layout:fixed}
.mx th,.mx td{text-align:left;vertical-align:top;padding:8px 12px;font-weight:400}
.mx thead th{padding:0 12px 8px;font-size:14px;line-height:1.4;color:var(--sec)}
.mx thead .sl{display:block;font-size:15px;font-weight:600;color:var(--ink);margin-bottom:2px}
.mx .mx-o{width:34%}
.mx .mx-p{width:2.75rem;padding:8px 0 0 0;text-align:center}
.mx thead .mx-p{padding:0 0 8px;font-size:12px}
.mx thead .mx-o,.mx thead .mx-p{vertical-align:bottom}
.mx tbody th{padding-left:0;font-size:16px;line-height:1.4}
.oh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.oh .on{font-weight:600}
.mx .oh{flex-wrap:nowrap}.mx .oh .on{flex:1 1 auto;min-width:0}.mx .oh .tag{flex:none}
.mx td{border-radius:3px;font-size:15px;line-height:1.4}
.ow{display:block;font-weight:650;margin-bottom:1px}
.k-safe{background:var(--em-l)}.k-safe .ow,.sw.k-safe{color:var(--em-ink)}
.k-risk{background:var(--red-l)}.k-risk .ow,.sw.k-risk{color:var(--red)}
.k-human{background:var(--am-l)}.k-human .ow,.sw.k-human{color:var(--am-ink)}
.k-neutral{background:var(--surface);box-shadow:inset 0 0 0 1px var(--rule)}.k-neutral .ow,.sw.k-neutral{color:var(--sec)}
.mx tr.dim td{background:var(--surface);box-shadow:inset 0 0 0 1px var(--hair)}
.mx tr.dim td.mx-p{box-shadow:none}
.mx tr.dim th .on{font-weight:500;color:var(--sec)}
.mx tr.dim td .ot{color:var(--sec)}
.mx tr.hl>td:not(.mx-p){box-shadow:inset 0 -3px 0 var(--blue)}
.mx tr.hl>td.k-neutral,.mx tr.dim.hl>td:not(.mx-p){box-shadow:inset 0 0 0 1px var(--rule),inset 0 -3px 0 var(--blue)}
.mx tr.hl .on{color:var(--ink);text-decoration:underline;text-decoration-color:var(--blue);text-decoration-thickness:2px;text-underline-offset:5px}
.sq tr.hl>td{color:var(--ink);box-shadow:inset 0 -2px 0 var(--blue)}
.legend{list-style:none;display:flex;flex-direction:column;gap:6px;margin-top:14px;font-size:15px}
.legend li{display:flex;gap:10px;align-items:baseline}
.sw{display:inline-block;min-width:6.5em;padding:1px 8px;border-radius:3px;font-weight:650;font-size:14px;flex:none}
.opts{grid-column:1/-1;margin-top:10px}
.opt{display:grid;grid-template-columns:var(--lab) minmax(0,1fr);column-gap:var(--gap);padding:24px 0;border-top:1px solid var(--hair);border-radius:2px}
.opt:first-child{border-top:0;padding-top:4px}
.opt.hl{outline:2px solid var(--blue-m);outline-offset:6px}
.opt-side{position:sticky;top:calc(var(--bar-h) + 16px);align-self:start;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.opt-h{display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-size:17px;line-height:1.35}
.opt-h .chip{font-size:15px}
.opt.mine .opt-h .on{color:var(--blue)}
.opt-tags{display:flex;flex-wrap:wrap;gap:6px}
.sum{max-width:var(--m);font-size:17px;line-height:1.5}
.kpr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px var(--gap);margin-top:16px}
.kpr .lab{display:block;margin-bottom:6px;font-size:12px}
.kpr p+.lab{margin-top:14px}
.kpr ul{padding-left:1.1em}
.kpr li{margin-bottom:.4em}
.kpr li::marker{color:var(--sec)}
.kpr>div{max-width:var(--m)}
.opt.dim{color:var(--sec)}
.opt.dim .opt-h .on{font-weight:500}
.brs{display:grid;grid-template-columns:repeat(auto-fit,minmax(21rem,1fr));gap:28px var(--gap)}
.br{max-width:var(--m)}
.br h3{display:flex;gap:10px;align-items:baseline;font-size:17px;line-height:1.4;margin-bottom:6px}
.n{display:inline-grid;place-items:center;width:24px;height:24px;border:1.5px solid var(--am-ink);border-radius:50%;color:var(--am-ink);font-size:13px;font-weight:700;flex:none;transform:translateY(-1px)}
.br>p{padding-left:34px}
.next{margin-top:10px;font-weight:500}
.next b{color:var(--am-ink);font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin-right:8px;display:inline-block}
${K.claims}
.sq{width:100%;max-width:calc(var(--m) + 4rem);border-collapse:collapse;margin-top:12px}
.sq th,.sq td{text-align:left;vertical-align:top;padding:9px 12px 9px 0;border-top:1px solid var(--hair);font-weight:400}
.sq thead th{border-top:0;padding-top:0}
.sq tbody th{width:3.5rem;padding-left:4px}
.sq tr.dim td{color:var(--sec)}
${K.terms}
.idx{width:100%;border-collapse:collapse}
.idx th,.idx td{text-align:left;vertical-align:top;padding:12px 16px 12px 0}
.idx thead th{padding-top:0;border-bottom:1px solid var(--rule)}
.idx td{border-bottom:1px solid var(--hair)}
.idx tr.hl td{background:${HIGHLIGHT_ROW}}
.idx tr.hl .ct a:not(.cchip){text-decoration:underline;text-decoration-color:var(--blue);text-decoration-thickness:2px;text-underline-offset:5px}
.idx .ct{display:flex;gap:10px;align-items:baseline}
.idx .ct a:not(.cchip){font-weight:600;color:var(--ink);text-decoration:none}
.idx .ct a:not(.cchip):hover{text-decoration:underline}
.idx .owns{display:flex;flex-wrap:wrap;gap:0 10px}
.idx .state{display:flex;flex-direction:column;gap:3px}
.idx .state .r{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.oi-l{color:var(--am-ink)!important}
.ip{list-style:none;max-width:calc(var(--m) + 6rem)}
.ip li{display:grid;grid-template-columns:minmax(6rem,max-content) minmax(0,1fr);gap:16px;padding:8px 0;border-top:1px solid var(--hair)}
.ip li:first-child{border-top:0;padding-top:0}
.ipk{display:flex;gap:6px;align-items:baseline;white-space:nowrap;font-weight:600}
.xr{font-weight:600;font-size:14px}
.call{border-top:2px solid var(--ink);margin-top:40px}
.call-h{border-top:0;padding-bottom:4px}
.cl-wrap{display:flex;flex-direction:column}
.cl{font-size:44px;line-height:1;font-weight:300;margin-top:4px}
.call-h h2{font-size:24px;line-height:1.3;max-width:40rem;padding-top:16px}
.cmeta{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;margin-top:8px}
.cmeta .k{font-size:13px;color:var(--sec)}
.cmeta .owns{display:inline-flex;gap:0 10px;flex-wrap:wrap}
.call.ruled .call-h h2{font-weight:500}
${K.bar}
.bar-c b{color:var(--ink)}
.bar-c .p{display:inline-flex;align-items:center;justify-content:center;min-width:1.45em;height:1.45em;padding:0 .3em;margin-left:2px;border-radius:3px;background:var(--blue);color:#fff;font-size:12px;font-weight:700;align-self:center}
.bar-c.hl{background:var(--blue-l);color:var(--ink)}
${K.barLeft}
.bar-picks{font:inherit;font-weight:600;color:var(--blue);background:var(--surface);border:1px solid var(--blue-m);border-radius:3px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.bar-picks b:not(:empty)::before{content:": "}
.bar-picks[aria-expanded="true"],.bar-picks:hover{background:var(--blue);color:#fff;border-color:var(--blue)}
${K.prog}
@media (max-width:1399px){.bar-c .w{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
.bar-many .bar-c .w{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
${K.refs}
.ref.mine{background:var(--blue-l);box-shadow:0 0 0 2px var(--blue-l);text-decoration:none;font-weight:600}
${K.refHl}
.chip.mine{box-shadow:0 0 0 2px var(--surface),0 0 0 3.5px var(--blue)}
.pick{display:inline-flex;align-items:center;font:inherit;font-size:13px;font-weight:600;line-height:1.3;color:var(--blue);background:var(--surface);border:1px solid var(--blue-m);border-radius:999px;padding:3px 11px;cursor:pointer;white-space:nowrap}
.pick:hover{border-color:var(--blue)}
.pick[aria-pressed="true"]{background:var(--blue);border-color:var(--blue);color:#fff}
.pick[aria-pressed="true"]::before{content:"●";margin-right:6px;font-size:9px}
.pick .un{display:none}
.pick[aria-pressed="true"]:hover .pl,.pick[aria-pressed="true"]:focus-visible .pl{display:none}
.pick[aria-pressed="true"]:hover .un,.pick[aria-pressed="true"]:focus-visible .un{display:inline}
.pick-dot{justify-content:center;width:28px;height:28px;padding:0}
.pick-dot::after{content:"";width:10px;height:10px;border-radius:50%;background:transparent}
.pick-dot:hover::after{background:var(--blue-l)}
.pick-dot[aria-pressed="true"]::before{content:none}
.pick-dot[aria-pressed="true"]::after{background:#fff}
.pick-dot[aria-pressed="true"]:hover .pl,.pick-dot[aria-pressed="true"]:focus-visible .pl{display:inline}
.tray-list .rm{align-self:flex-start;padding:2px 0}
.tray{position:fixed;z-index:50;top:calc(var(--bar-h) + 8px);right:16px;width:min(28rem,calc(100vw - 32px));max-height:calc(100vh - var(--bar-h) - 24px);overflow:auto;background:var(--surface);border:1px solid var(--rule);border-radius:4px;box-shadow:0 12px 32px rgba(30,41,59,.16);padding:20px;font-size:15px}
.tray-h{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.tray h2{font-size:18px}
.tbtn{font:inherit;font-size:14px;color:var(--blue);background:none;border:0;padding:6px 0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.tray-sub{font-size:14px;color:var(--sec);margin:4px 0 16px}
.tray-list{list-style:none;display:flex;flex-direction:column;gap:14px;margin-bottom:18px}
.tray-list li{display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:1px solid var(--hair)}
.tray-list li:first-child{border-top:0;padding-top:0}
.tray-list .t{font-weight:600;line-height:1.4}
.tray-list .row{display:flex;gap:6px;flex-wrap:wrap}
.tray-list .o{font:inherit;font-size:14px;font-weight:600;min-width:2.25rem;height:2.1rem;border:1px solid var(--blue-m);border-radius:3px;background:var(--surface);color:var(--blue);cursor:pointer}
.tray-list .o[aria-pressed="true"]{background:var(--blue);border-color:var(--blue);color:#fff}
.tray-list .nm{font-size:14px;line-height:1.45}
.tray-list .nm.none{color:var(--sec)}
.tray-list .ment{font-size:14px;color:var(--sec);line-height:1.45}
.ck{display:flex;gap:8px;align-items:center;font-size:14px;margin:6px 0}
.nt{display:flex;flex-direction:column;gap:4px;font-size:14px;margin:10px 0 16px}
.nt textarea{font:inherit;font-size:14px;border:1px solid var(--rule);border-radius:3px;padding:8px;resize:vertical;color:var(--ink)}
.preview{white-space:pre-wrap;font:13px/1.5 var(--mono);background:var(--bg);border:1px solid var(--hair);border-radius:3px;padding:12px;margin:6px 0 14px;max-height:16rem;overflow:auto}
.tray-a{display:flex;align-items:center;gap:14px}
.copy{font:inherit;font-weight:600;color:#fff;background:var(--blue);border:1px solid var(--blue);border-radius:3px;padding:8px 16px;cursor:pointer}
.copy:hover{background:var(--ink);border-color:var(--ink)}
.done{color:var(--em-ink);font-weight:600;font-size:14px}
.tray-a .clear{margin-left:auto}
${K.at1180}
@media (max-width:1100px){${K.at1100.sheet}.sec,.opt{--lab:9rem;--gap:1.75rem}${K.at1100.bar}
.kpr{grid-template-columns:1fr 1fr}.kpr>:last-child{grid-column:1/-1}${K.at1100.meta}}
@media (max-width:720px){
${K.at720.reading}
.opt{display:block;padding:20px 0}
.opt-side{position:static;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-bottom:10px}
.opt-h{flex-direction:row;align-items:baseline}
.kpr{grid-template-columns:1fr;gap:14px}.kpr>:last-child{grid-column:auto}
.mx,.mx tbody,.mx tr,.mx th,.mx td{display:block;width:auto}
.mx{margin:0}.mx thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.mx tr{padding:14px 0;border-top:1px solid var(--hair)}.mx tr:first-child{border-top:0;padding-top:0}
.mx tbody th{padding:0 0 8px}
.mx td{margin-top:4px}
.mx td.mx-p{margin:0;padding:0 0 8px;text-align:left}
.mx td::before{content:attr(data-s);display:block;font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px}
.mx td.mx-p::before{content:none}
.idx thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.idx tr{display:block;padding:12px 0;border-bottom:1px solid var(--hair)}
.idx td{display:block;border:0;padding:3px 0}
.ip li{grid-template-columns:1fr;gap:4px}
${K.at720.terms}
.cl-wrap{flex-direction:row;gap:10px;align-items:baseline}.cl{font-size:32px}
.call-h h2{padding-top:8px;font-size:21px}
.br>p{padding-left:0}
.brs{grid-template-columns:1fr}
${K.at720.bar}
.pick{min-height:44px;padding:0 16px;font-size:14px}
.pick-dot{width:44px;padding:0}
.tray{left:0;right:0;bottom:0;top:auto;width:auto;max-height:85vh;border-radius:10px 10px 0 0;padding:18px 16px 24px}
.tray-list .o{min-width:44px;height:44px}
.copy{min-height:44px}
${K.at720.tip}
.sq tbody th{width:2.75rem}
}
@media print{
${K.print.meta}
.bar,.tray,.pick,.bar-picks,[data-js]{display:none!important}
.sec>.lab,.opt-side{position:static}
${K.print.page}
${K.print.h1}.sum{font-size:11pt}.opt-h{font-size:12pt}
${K.print.term}
.mx td,.sw,.chip,.cchip,.n{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.opt,.br,.mx tr,.claims li,.sq tr,.idx tr{break-inside:avoid}
${K.print.lab}
.call{break-before:page;margin-top:0}
${K.print.ext}
.hl,.mine{outline:0!important;box-shadow:none!important}
}`;
