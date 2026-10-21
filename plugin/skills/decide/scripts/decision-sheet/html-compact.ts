/**
 * The compact template: a self-contained decision sheet in a drawing-sheet
 * layout (grid references, lettered panels, title block). This is the first
 * sheet layout, unchanged by the document template: its output for a source
 * without reference tokens is byte-identical to what it was before.
 *
 * One call renders as one sheet, the layout of the pilot sheet. Two or more
 * calls render as an overview sheet plus one sheet per call, each with its own
 * options panel and outcome matrix; the overview carries the interplay panel.
 *
 * Self-contained means no external font, script, stylesheet or image. The
 * source itself is embedded as an inert `application/json` data block, so a
 * later `/decide` run can regenerate the sheet from the attachment alone
 * (`decision-sheet.ts extract`). Browsers never execute that block.
 */

import { embedJson, esc, link, PALETTE } from "../sheet-kit/html.ts";
import { OUTCOME_COLOUR, SOURCE_BLOCK_ID } from "./html-shared.ts";
import { LABEL, OUTCOME_ICON, OUTCOME_WORD } from "./labels.ts";
import { plainSource } from "./refs.ts";
import {
  type Call,
  type DecisionSource,
  decisionStatus,
  facetLabel,
  headlineOwners,
  type Option,
  OUTCOME_KINDS,
  optionName,
  type SourcedClaim,
  sentence,
} from "./source.ts";

const owners = (facets: readonly string[]) =>
  facets.map(facetLabel).join(" + ");

interface PanelSpec {
  title: string;
  note: string;
  body: string;
  span: 1 | 2 | 3;
  kind: string;
}

function panels(list: (PanelSpec | undefined)[]): string {
  return list
    .filter((p): p is PanelSpec => p !== undefined)
    .map(
      (p, i) =>
        `<section class="panel span-${p.span}" data-panel="${p.kind}" aria-labelledby="${p.kind}-h"><header><span class="ltr" aria-hidden="true">${String.fromCharCode(65 + i)}</span><h2 id="${p.kind}-h">${esc(p.title)}</h2><span class="note">${esc(p.note)}</span></header><div class="body">${p.body}</div></section>`,
    )
    .join("");
}

const claims = (xs: SourcedClaim[]) =>
  `<ul class="facts">${xs.map((f) => `<li>${esc(f.text)}<span class="src">${esc(f.source)}</span></li>`).join("")}</ul>`;

function branchesBody(source: DecisionSource): string {
  return `<div class="branches">${(source.hiddenBranches ?? [])
    .map(
      (h, i) =>
        `<div class="branch"><div class="bn" aria-hidden="true">${i + 1}</div><div><h3>${esc(h.title)}</h3><p>${esc(h.text)}</p><p class="act"><span class="lbl">${esc(LABEL.nextStep)}</span> ${esc(h.action)}</p></div></div>`,
    )
    .join("")}</div>`;
}

function optionMark(call: Call, option: Option): string {
  if (call.ruling)
    return call.ruling.option === option.id
      ? `<span class="rec">${esc(LABEL.chosen)}</span>`
      : "";
  return call.recommended === option.id
    ? `<span class="rec">${esc(LABEL.recommended)}</span>`
    : "";
}

function optionHead(call: Call, option: Option): string {
  return `<span class="oid">${esc(option.id)}</span><span class="oname">${esc(option.name)}</span>${optionMark(call, option)}${option.tag ? `<span class="tag">${esc(option.tag)}</span>` : ""}`;
}

/** The outcome matrix: one row per option, one cell per scenario, every cell an icon plus a word. */
export function matrix(call: Call): string {
  const scenarios = call.scenarios ?? [];
  const head = `<tr><th scope="col">${esc(LABEL.option)}</th>${scenarios
    .map(
      (s) =>
        `<th scope="col"><b>${esc(s.label)}</b><span>${esc(s.detail)}</span></th>`,
    )
    .join("")}</tr>`;
  const rows = call.options
    .map((o) => {
      const cells = scenarios
        .map((s) => {
          const outcome = o.outcomes?.[s.id];
          if (!outcome)
            throw new Error(
              `call ${call.id} option ${o.id}: no outcome for scenario ${s.id}`,
            );
          return `<td class="cell ${outcome.kind}" data-option="${esc(o.id)}" data-scenario="${esc(s.id)}"><span class="ic" aria-hidden="true">${OUTCOME_ICON[outcome.kind]}</span><b>${OUTCOME_WORD[outcome.kind]}</b><span class="ot">${esc(outcome.text)}</span></td>`;
        })
        .join("");
      return `<tr><th scope="row">${optionHead(call, o)}</th>${cells}</tr>`;
    })
    .join("");
  const used = new Set(
    call.options.flatMap((o) =>
      Object.values(o.outcomes ?? {}).map((x) => x.kind),
    ),
  );
  const legend = OUTCOME_KINDS.filter((k) => used.has(k))
    .map(
      (k) =>
        `<span class="lg ${k}"><span class="ic" aria-hidden="true">${OUTCOME_ICON[k]}</span><b>${OUTCOME_WORD[k]}</b>${call.outcomeMeaning?.[k] ? `<span class="lgm">${esc(call.outcomeMeaning[k])}</span>` : ""}</span>`,
    )
    .join("");
  return `<table class="matrix" data-call="${esc(call.id)}"><thead>${head}</thead><tbody>${rows}</tbody></table><p class="legend">${legend}</p>`;
}

function optionCards(call: Call): string {
  return `<div class="opts" data-call="${esc(call.id)}">${call.options
    .map((o) => {
      const mark = call.ruling
        ? call.ruling.option === o.id
        : call.recommended === o.id;
      return `<article class="opt${mark ? " is-rec" : ""}"><h3>${optionHead(call, o)}</h3><p class="sum">${esc(o.summary)}</p><dl><dt>${esc(LABEL.keep)}</dt><dd><ul>${o.keep.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></dd><dt>${esc(LABEL.pay)}</dt><dd><ul>${o.pay.map((k) => `<li>${esc(k)}</li>`).join("")}</ul></dd><dt>${esc(LABEL.rightWhen)}</dt><dd>${esc(o.rightWhen)}</dd>${o.obligation ? `<dt>${esc(LABEL.obligation)}</dt><dd>${esc(o.obligation)}</dd>` : ""}</dl></article>`;
    })
    .join("")}</div>`;
}

function followOnBody(call: Call): string {
  const subs = (call.subQuestions ?? [])
    .map(
      (s) =>
        `<div class="sq">${s.title ? `<h3>${esc(s.title)}</h3>` : ""}<p class="q2">${esc(s.question)}</p><table class="api">${call.options
          .map(
            (o) =>
              `<tr><th scope="row"><span class="oid">${esc(o.id)}</span></th><td>${esc(s.byOption[o.id] ?? "")}</td></tr>`,
          )
          .join("")}</table></div>`,
    )
    .join("");
  const notes = (call.notes ?? [])
    .map((n) => `<p class="side">${esc(n)}</p>`)
    .join("");
  return subs + notes;
}

function followOnPanel(call: Call, span: 1 | 2 | 3): PanelSpec | undefined {
  if (!call.subQuestions?.length && !call.notes?.length) return undefined;
  const single =
    call.subQuestions?.length === 1 ? call.subQuestions[0] : undefined;
  return {
    title: call.subQuestions?.length
      ? (single?.title ?? LABEL.followOn)
      : LABEL.notes,
    note: call.subQuestions?.length ? LABEL.followOnNote : "",
    body: followOnBody(
      single?.title
        ? {
            ...call,
            subQuestions: [
              { question: single.question, byOption: single.byOption },
            ],
          }
        : call,
    ),
    span,
    kind: `followon-${call.id}`,
  };
}

/** The call's verdict line: the ruling once one exists, the recommendation before. Never both. */
function callVerdict(call: Call): string {
  if (call.ruling)
    return `<p class="read ruled"><span class="lbl">${esc(LABEL.decided)}</span> <b>${esc(call.ruling.option)}. ${esc(optionName(call, call.ruling.option))}</b><span class="rmeta">${esc(LABEL.ruledOn)} <span class="mono">${esc(call.ruling.ruledAt)}</span> · ${link(call.ruling.recordUrl, LABEL.rulingRecord)}</span></p>`;
  const rec = call.recommended
    ? `<p class="read"><b>${esc(call.recommended)}. ${esc(sentence(optionName(call, call.recommended)))}</b> ${esc(call.why ?? "")}</p>`
    : "";
  const open = call.openInput
    ? `<p class="open"><span class="lbl">${esc(LABEL.openInput)}</span> ${esc(call.openInput)}</p>`
    : "";
  return rec + open;
}

function glossary(source: DecisionSource): string {
  if (!source.glossary?.length) return "";
  return `<h3>${esc(LABEL.terms)}</h3><dl class="gl">${source.glossary
    .map((g) => `<dt>${esc(g.term)}</dt><dd>${esc(g.meaning)}</dd>`)
    .join("")}</dl>`;
}

/** The overall read is shown only while a call is still open; a fully ruled sheet shows rulings, not advice. */
function overallRead(source: DecisionSource): string {
  return source.calls.some((c) => !c.ruling)
    ? `<p class="read">${esc(source.myRead)}</p>`
    : "";
}

function titleBlock(
  source: DecisionSource,
  sheet: number,
  total: number,
  sub?: string,
): string {
  return `<section class="tblock span-1" aria-label="${esc(LABEL.title)}">
<div class="wide"><span class="tl">${esc(LABEL.title)}</span><h1 class="tt">${esc(source.title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
<div><span class="tl">${esc(LABEL.decision)}</span><div>${link(source.url, source.id)}</div></div>
<div><span class="tl">${esc(LABEL.owners)}</span><div>${esc(owners(headlineOwners(source)))}</div></div>
<div><span class="tl">${esc(LABEL.status)}</span><div>${esc(decisionStatus(source))}</div></div>
<div><span class="tl">${esc(LABEL.priority)}</span><div>${esc(source.priority)}</div></div>
<div class="wide"><span class="tl">${esc(LABEL.reversibility)}</span><div>${esc(source.reversibility)}</div></div>
<div><span class="tl">${esc(LABEL.factsVerified)}</span><div class="mono">${esc(source.verifiedAt.date)} @ ${esc(source.verifiedAt.commit)}</div></div>
<div><span class="tl">${esc(LABEL.sheet)}</span><div>${sheet} of ${total}</div></div>
</section>`;
}

const gridRefs = () => {
  const cols = Array.from(
    { length: 8 },
    (_, i) => `<span>${i + 1}</span>`,
  ).join("");
  const rows = ["A", "B", "C", "D"].map((r) => `<span>${r}</span>`).join("");
  return `<div class="gx t" aria-hidden="true">${cols}</div><div class="gx b" aria-hidden="true">${cols}</div><div class="gy l" aria-hidden="true">${rows}</div><div class="gy r" aria-hidden="true">${rows}</div>`;
};

function sheet(id: string, body: string): string {
  return `<main class="sheet" id="${esc(id)}">${gridRefs()}<div class="frame">${body}</div></main>`;
}

/** The most claims the question panel holds while it sits beside the matrix. */
export const SIDE_BY_SIDE_MAX_CLAIMS = 6;

function singleCallSheet(source: DecisionSource): string {
  const call = source.calls[0] as Call;
  const hasMatrix = Boolean(call.scenarios?.length);
  // Beside the matrix the question panel is one column wide. With many claims
  // it grows far taller than the matrix and leaves a blank area beside it
  // (the pilot had 13 claims). Then both panels take the full width instead.
  const claimCount = source.currentBehaviour.length + (call.facts?.length ?? 0);
  const sideBySide = hasMatrix && claimCount <= SIDE_BY_SIDE_MAX_CLAIMS;
  const followOn = followOnPanel(call, 1);
  const questionBody = `<p class="q">${esc(source.question)}</p>${call.title ? `<h3>${esc(call.title)}</h3>` : ""}${call.question ? `<p class="q">${esc(call.question)}</p>` : ""}<h3>${esc(LABEL.currentBehaviour)}</h3>${claims(source.currentBehaviour)}${call.facts?.length ? `<h3>${esc(LABEL.facts)}</h3>${claims(call.facts)}` : ""}`;
  const verdict = call.ruling
    ? { title: LABEL.ruling, note: LABEL.rulingNote }
    : { title: LABEL.recommendation, note: LABEL.recommendationNote };
  return sheet(
    "sheet-1",
    panels([
      {
        title: LABEL.theQuestion,
        note: LABEL.decisionNote,
        body: questionBody,
        span: sideBySide ? 1 : 3,
        kind: "question",
      },
      hasMatrix
        ? {
            title: LABEL.outcomes,
            note: LABEL.outcomesNote,
            body: matrix(call),
            span: sideBySide ? 2 : 3,
            kind: `matrix-${call.id}`,
          }
        : undefined,
      source.settled?.length
        ? {
            title: LABEL.settled,
            note: LABEL.settledNote,
            body: claims(source.settled),
            span: 3,
            kind: "settled",
          }
        : undefined,
      source.hiddenBranches?.length
        ? {
            title: LABEL.hiddenBranches,
            note: LABEL.hiddenBranchesNote,
            body: branchesBody(source),
            span: 3,
            kind: "branches",
          }
        : undefined,
      {
        title: LABEL.options,
        note: LABEL.optionsNote,
        body: optionCards(call),
        span: 3,
        kind: `options-${call.id}`,
      },
      source.interplay?.length
        ? {
            title: LABEL.interplay,
            note: LABEL.interplayNote,
            body: interplayBody(source),
            span: 3,
            kind: "interplay",
          }
        : undefined,
      followOn,
      {
        title: verdict.title,
        note: verdict.note,
        body: `${callVerdict(call)}${overallRead(source)}${glossary(source)}`,
        span: followOn ? 1 : 2,
        kind: "recommendation",
      },
    ]) + titleBlock(source, 1, 1),
  );
}

function callIndex(source: DecisionSource): string {
  return `<table class="idx"><thead><tr><th scope="col">${esc(LABEL.call)}</th><th scope="col">${esc(LABEL.owners)}</th><th scope="col">${esc(LABEL.status)}</th></tr></thead><tbody>${source.calls
    .map((c) => {
      const status = c.ruling
        ? `<b><span class="lbl">${esc(LABEL.decided)}</span> ${esc(c.ruling.option)}. ${esc(optionName(c, c.ruling.option))}</b>`
        : c.recommended
          ? `<b>${esc(c.recommended)}. ${esc(optionName(c, c.recommended))}</b><span class="why">${esc(c.why ?? "")}</span>`
          : `<b>${esc(LABEL.open)}</b>`;
      return `<tr><th scope="row"><a href="#call-${esc(c.id)}"><span class="cid">${esc(c.id)}</span>${esc(c.title ?? "")}</a></th><td>${esc(owners(c.owners ?? source.owners))}</td><td>${status}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function interplayBody(source: DecisionSource): string {
  return `<ul class="ip">${(source.interplay ?? [])
    .map(
      (x) =>
        `<li><span class="cid">${esc(x.from)}</span><span aria-hidden="true">→</span><span class="cid">${esc(x.to)}</span><span class="ipt">${esc(x.text)}</span></li>`,
    )
    .join("")}</ul>`;
}

function multiCallSheets(source: DecisionSource): string {
  const overviewRead = `${overallRead(source)}${glossary(source)}`;
  const total = source.calls.length + 1;
  const overview = sheet(
    "sheet-1",
    panels([
      {
        title: LABEL.theQuestion,
        note: LABEL.decisionNote,
        body: `<p class="q">${esc(source.question)}</p><h3>${esc(LABEL.currentBehaviour)}</h3>${claims(source.currentBehaviour)}`,
        span: source.settled?.length ? 2 : 3,
        kind: "question",
      },
      source.settled?.length
        ? {
            title: LABEL.settled,
            note: LABEL.settledNote,
            body: claims(source.settled),
            span: 1,
            kind: "settled",
          }
        : undefined,
      source.hiddenBranches?.length
        ? {
            title: LABEL.hiddenBranches,
            note: LABEL.hiddenBranchesNote,
            body: branchesBody(source),
            span: 3,
            kind: "branches",
          }
        : undefined,
      {
        title: LABEL.calls,
        note: LABEL.callsNote,
        body: callIndex(source),
        span: 3,
        kind: "calls",
      },
      {
        title: LABEL.interplay,
        note: LABEL.interplayNote,
        body: interplayBody(source),
        span: overviewRead ? 1 : 2,
        kind: "interplay",
      },
      // Once every call is ruled and there is no glossary, this panel would be empty: leave it out.
      overviewRead
        ? {
            title: LABEL.recommendation,
            note: LABEL.recommendationNote,
            body: overviewRead,
            span: 1,
            kind: "recommendation",
          }
        : undefined,
    ]) + titleBlock(source, 1, total, LABEL.overview),
  );
  const perCall = source.calls.map((call, i) => {
    const hasMatrix = Boolean(call.scenarios?.length);
    // Same layout rule as a lone call; this panel holds only the call's own facts.
    const sideBySide =
      hasMatrix && (call.facts?.length ?? 0) <= SIDE_BY_SIDE_MAX_CLAIMS;
    const followOn = followOnPanel(call, 1);
    const verdict = call.ruling
      ? { title: LABEL.ruling, note: LABEL.rulingNote }
      : { title: LABEL.recommendation, note: LABEL.recommendationNote };
    return sheet(
      `call-${call.id}`,
      panels([
        {
          title: `${call.id}. ${call.title ?? ""}`,
          note: owners(call.owners ?? source.owners),
          body: `<p class="q">${esc(call.question ?? "")}</p>${call.facts?.length ? `<h3>${esc(LABEL.facts)}</h3>${claims(call.facts)}` : ""}`,
          span: sideBySide ? 1 : 3,
          kind: `call-${call.id}`,
        },
        hasMatrix
          ? {
              title: LABEL.outcomes,
              note: LABEL.outcomesNote,
              body: matrix(call),
              span: sideBySide ? 2 : 3,
              kind: `matrix-${call.id}`,
            }
          : undefined,
        {
          title: LABEL.options,
          note: LABEL.optionsNote,
          body: optionCards(call),
          span: 3,
          kind: `options-${call.id}`,
        },
        followOn,
        {
          title: verdict.title,
          note: verdict.note,
          body: `${callVerdict(call)}<p class="back"><a href="#sheet-1">${esc(LABEL.backToOverview)}</a></p>`,
          span: followOn ? 1 : 2,
          kind: `recommendation-${call.id}`,
        },
      ]) +
        titleBlock(
          source,
          i + 2,
          total,
          `${LABEL.call} ${call.id}: ${call.title ?? ""}`,
        ),
    );
  });
  return overview + perCall.join("");
}

/**
 * `source` is the decision source as written. A reference token reads as plain
 * words on this sheet (`option 3`), which `plainSource` writes out; the
 * embedded block keeps the source untouched so it still round-trips.
 */
export function renderCompactHtml(source: DecisionSource): string {
  const shown = plainSource(source);
  const body =
    shown.calls.length === 1 ? singleCallSheet(shown) : multiCallSheets(shown);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(source.id)} decision sheet</title><style>${CSS}</style></head><body>${body}<script type="application/json" id="${SOURCE_BLOCK_ID}">${embedJson(source)}</script></body></html>`;
}

const CSS = `:root{--bg:${PALETTE.bg};--paper:${PALETTE.surface};--ink:${PALETTE.ink};--muted:${PALETTE.muted};--hair:${PALETTE.hair};--hair2:${PALETTE.hairLight};--accent:${PALETTE.accent};--safe:${OUTCOME_COLOUR.safe};--risk:${OUTCOME_COLOUR.risk};--human:${OUTCOME_COLOUR.human};--neutral:${OUTCOME_COLOUR.neutral}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.mono,.note,.src,.tl,.cid,.oid,.tag,.rec,.lbl{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
a{color:var(--accent)}
.sheet{max-width:1680px;margin:16px auto 28px;background:var(--paper);border:1.5px solid var(--ink);position:relative;padding:26px}
.gx{position:absolute;left:26px;right:26px;display:flex;justify-content:space-around;color:var(--muted);font:11px ui-monospace,Menlo,monospace}.gx.t{top:6px}.gx.b{bottom:6px}
.gy{position:absolute;top:26px;bottom:26px;display:flex;flex-direction:column;justify-content:space-around;color:var(--muted);font:11px ui-monospace,Menlo,monospace}.gy.l{left:9px}.gy.r{right:9px}
.frame{padding:18px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
.span-1{grid-column:span 1}.span-2{grid-column:span 2}.span-3{grid-column:1/-1}
.panel{border:1.5px solid var(--ink);display:flex;flex-direction:column;min-width:0}
.panel header{display:flex;align-items:center;border-bottom:1.5px solid var(--ink)}
.ltr{background:var(--ink);color:#fff;font-weight:600;width:30px;align-self:stretch;display:grid;place-items:center}
.panel h2{font-size:15px;margin:0;padding:7px 10px;flex:1}.note{color:var(--muted);font-size:11px;padding-right:10px}
.body{padding:10px 12px}.body p,.body li,.body dd,.ipt{max-width:65ch}h3{font-size:12.5px;margin:10px 0 4px}.q{margin:0 0 6px;font-size:13.5px}
ul{margin:0;padding-left:16px}li{margin:2px 0}.facts li{margin-bottom:5px;break-inside:avoid}.span-2 .facts,.span-3 .facts{columns:2 30em;column-gap:28px}.src{display:block;color:var(--muted);font-size:10.5px;overflow-wrap:anywhere}
.branches{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:20px}
.branch{display:flex;gap:10px}.branch p{margin:2px 0}.branch h3{margin-top:1px}
.bn{flex:none;width:22px;height:22px;border:1.5px solid var(--human);color:var(--human);border-radius:50%;display:grid;place-items:center;font-weight:600}
.act{color:var(--human);font-weight:500}.lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.cid,.oid{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 3px;border:1.5px solid var(--accent);color:var(--accent);font-weight:600;font-size:11.5px;margin-right:7px}
.idx{width:100%;border-collapse:collapse}.idx th,.idx td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--hair2)}.idx thead th{border-bottom:1.5px solid var(--ink);font-size:12px}
.idx tbody th{width:34%}.idx tbody th a{color:var(--ink);text-decoration:none}.idx td:nth-child(2){width:18%;color:var(--muted)}.why{display:block;color:var(--muted);font-weight:400}
.ip{list-style:none;padding:0}.ip li{margin:0 0 8px}.ip .cid{margin:0 4px}.ipt{display:block;margin-top:2px}
.read{font-size:14px;border-left:3px solid var(--accent);padding-left:10px;margin:0 0 8px}.read.ruled{border-left-color:var(--safe)}.rmeta{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.open{color:var(--human);margin:6px 0}.back{margin:8px 0 0;font-size:12px}
.gl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0}.gl dt{font-weight:600;font-size:12px}.gl dd{margin:0;color:var(--muted)}
.matrix{width:100%;border-collapse:collapse}.matrix th,.matrix td{border-bottom:1px solid var(--hair2);padding:8px;text-align:left;vertical-align:top}
.matrix thead th{border-bottom:1.5px solid var(--ink);font-weight:400}.matrix thead th b{display:block}.matrix thead th span{color:var(--muted);font-size:11.5px}
.matrix tbody th{font-weight:600;width:28%}.ot{display:block;color:var(--muted)}
.ic{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:3px;color:#fff;font-weight:700;margin-right:6px;font-size:12px}
.safe .ic{background:var(--safe)}.risk .ic{background:var(--risk)}.human .ic{background:var(--human)}.neutral .ic{background:var(--neutral)}
.safe b{color:var(--safe)}.risk b{color:var(--risk)}.human b{color:var(--human)}.neutral b{color:var(--neutral)}
.legend{color:var(--muted);font-size:11.5px;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 18px}.lg{display:inline-flex;align-items:center;gap:2px}.lg .ic{width:16px;height:16px;font-size:10px;margin-right:4px}.lgm{margin-left:5px}
.tag,.rec{font-size:10.5px;border:1px solid var(--hair);padding:0 4px;margin-left:6px;font-weight:500;color:var(--muted);white-space:nowrap}.rec{border-color:var(--accent);color:var(--accent)}
.opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px 0}.opt{padding:0 12px;border-left:1px solid var(--hair2)}.opt.is-rec .oname{color:var(--accent)}
.opt h3{font-size:13.5px;margin:2px 0 4px}.sum{margin:0 0 6px;color:var(--muted)}
dl{margin:0}.opt dt{font:600 10.5px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin-top:7px}.opt dd{margin:2px 0 0}
.sq+.sq{margin-top:10px}.q2{margin:0 0 6px;font-weight:500}.api{border-collapse:collapse;width:100%}.api th,.api td{padding:4px;border-bottom:1px solid var(--hair2);vertical-align:top;text-align:left}.api th{width:34px}
.side{color:var(--muted);font-size:12px;margin:8px 0 0}
.tblock{border:1.5px solid var(--ink);display:grid;grid-template-columns:1fr 1fr;align-self:stretch}.tblock>div{border-bottom:1px solid var(--ink);padding:5px 9px}.tblock>div:nth-child(even){border-right:1px solid var(--ink)}
.tblock .wide{grid-column:1/-1;border-right:0!important}.tt{font-size:15px;font-weight:600;margin:0}.sub{color:var(--muted)}.tl{display:block;color:var(--muted);font-size:10.5px}.tblock>div:nth-last-child(-n+2){border-bottom:0}
@media (max-width:1100px){.frame{grid-template-columns:1fr}.span-1,.span-2,.span-3{grid-column:1/-1}.sheet{padding:26px 12px}}
@media print{body{background:#fff}.sheet{margin:0 auto;break-after:page}}`;
