/**
 * The document template: a decision set as a report, ported from a
 * reference renderer drawn in Claude Design (`render-v2.js`), one function
 * per region.
 *
 * The layout is three fixed columns: a hanging label column, a reading
 * column, and a margin that holds what sits next to the text (the
 * recommendation or the ruling). The first screen of a one-call sheet shows
 * the question, the owners, the status, the reversibility, the recommendation
 * and the whole outcome matrix. Citations follow their claims in the margin.
 *
 * Differences from the reference renderer:
 *
 * - A reference to an option or a call is an explicit token (`refs.ts`), never
 *   found by a pattern in prose. Issue-key links (`ENG-123`, `#123`) stay
 *   pattern-based: the shape of the sheet's own tracker is unambiguous.
 * - The Pick control of the matrix is an icon in its own narrow column, so it
 *   adds no row height.
 * - Every text goes through `esc` (it also escapes `'`), never a local copy.
 * - Every fixed word comes from `labels.ts`.
 *
 * Everything is inline: no external font, script, stylesheet or image. With
 * JavaScript off all content is visible (`html-document-script.ts`).
 */
import {
  claimList,
  esc,
  extLink as ext,
  NAV_SEPARATOR,
  navItem as navEntry,
  page,
  section as sec,
  slug,
  termList,
  topBar,
} from "../sheet-kit/html.ts";
import { createInline } from "../sheet-kit/inline.ts";
import { DOCUMENT_CSS } from "./html-document-css.ts";
import { DOCUMENT_SCRIPT } from "./html-document-script.ts";
import { SOURCE_BLOCK_ID } from "./html-shared.ts";
import {
  DOCUMENT_LABEL as D,
  LABEL as L,
  OUTCOME_ICON,
  OUTCOME_WORD,
} from "./labels.ts";
import { refWords, splitRefs } from "./refs.ts";
import {
  type Call,
  type DecisionSource,
  decisionStatus,
  facetLabel,
  headlineOwners,
  type Option,
  OUTCOME_KINDS,
  sentence,
} from "./source.ts";

/** Where a piece of text sits: the call whose option an `{opt:N}` means, and which terms it has already marked. */
interface Region {
  call: string | undefined;
  seen: Set<string>;
}

/** Above this many calls the top bar shows each call's state as a glyph only (the word stays for screen readers): seven calls with words cannot share one row. */
const MANY_CALLS = 4;

const statusOf = (source: DecisionSource) => {
  const ruled = source.calls.filter((c) => c.ruling).length;
  const text = decisionStatus(source);
  if (ruled === 0) return { kind: "open", glyph: D.stateOpen, text } as const;
  if (ruled < source.calls.length)
    return { kind: "part", glyph: D.statePart, text } as const;
  return { kind: "done", glyph: D.stateDone, text } as const;
};

const owners = (facets: readonly string[], trace: boolean) =>
  facets
    .map(
      (f) =>
        `<span class="own"${trace ? ' tabindex="0"' : ""} data-t="w-${esc(f)}">${esc(facetLabel(f))}</span>`,
    )
    .join("");

const optionKey = (call: string, option: string) => `o-${call}-${option}`;

const chip = (call: string, option: string) =>
  `<a class="chip" href="#${esc(optionKey(call, option))}" data-t="${esc(optionKey(call, option))}"><span class="vh">${esc(L.option)} </span>${esc(option)}</a>`;

const callChip = (call: string) =>
  `<a class="cchip" href="#call-${esc(call)}" data-t="c-${esc(call)}"><span class="vh">${esc(L.call)} </span>${esc(call)}</a>`;

const optionById = (call: Call, id: string) =>
  call.options.find((o) => o.id === id) as Option;

export function renderDocumentHtml(source: DecisionSource): string {
  const multi = source.calls.length > 1;
  const status = statusOf(source);
  const inline = createInline({
    glossary: source.glossary ?? [],
    issueUrl: source.url,
    team: /^([A-Z][A-Z0-9]*)-\d+$/.exec(source.id)?.[1],
  });
  const termIds = inline.termIds;
  const callIds = new Set(source.calls.map((c) => c.id));

  const region = (call?: string): Region => ({ call, seen: new Set() });

  // ---------- inline text: references, issue ids, glossary terms ----------

  /** Source text to HTML. A reference token becomes a link that traces its option or call; its words come from `refs.ts`. */
  function rich(text: string, r: Region): string {
    return splitRefs(text)
      .map((p) => {
        if (p.kind === "text") return inline.textHtml(p.text, r.seen);
        const home = p.call ?? r.call;
        if (p.opt !== undefined && home !== undefined && callIds.has(home)) {
          const key = optionKey(home, p.opt);
          return `<a class="ref" href="#${esc(key)}" data-t="${esc(key)}">${esc(refWords(p))}</a>`;
        }
        if (p.call !== undefined && callIds.has(p.call))
          return `<a class="ref" href="#call-${esc(p.call)}" data-t="c-${esc(p.call)}">${esc(refWords(p))}</a>`;
        return esc(refWords(p));
      })
      .join("");
  }

  const paras = (text: string, r: Region) =>
    text
      .split(/\n\n/)
      .map((p) => `<p>${rich(p, r)}</p>`)
      .join("");

  // ---------- structure ----------

  function tags(call: Call, option: Option): string {
    let out = option.tag ? `<span class="tag">${esc(option.tag)}</span>` : "";
    if (call.ruling) {
      if (call.ruling.option === option.id)
        out += `<span class="tag tag-chosen">${esc(L.chosen)}</span>`;
    } else if (call.recommended === option.id)
      out += `<span class="tag">${esc(L.recommended)}</span>`;
    return out;
  }

  /** A Pick control. The matrix gets an icon in its own column; the option head gets the labelled pill. */
  function pick(call: Call, option: Option, dot: boolean): string {
    if (call.ruling) return "";
    return `<button type="button" class="pick${dot ? " pick-dot" : ""}" data-call="${esc(call.id)}" data-opt="${esc(option.id)}" aria-pressed="false" hidden>${
      dot
        ? `<span class="vh"><span class="pl">${esc(D.pick)}</span> ${esc(L.refOption)} ${esc(option.id)}</span>`
        : `<span class="pl">${esc(D.pick)}</span><span class="un" aria-hidden="true">${esc(D.unpick)}</span><span class="vh"> ${esc(L.refOption)} ${esc(option.id)}</span>`
    }</button>`;
  }

  function mast(): string {
    const trace = multi;
    return `<header class="sec mast"><p class="lab mast-id">${
      /^https:\/\//.test(source.url)
        ? `<a href="${esc(source.url)}">${esc(source.id)}</a>`
        : esc(source.id)
    }<span>${esc(D.sheet)}</span></p><div class="body"><h1>${esc(source.title)}</h1><dl class="meta"><div><dt>${esc(L.status)}</dt><dd><span class="st st-${status.kind}">${esc(status.glyph)} ${esc(status.text)}</span></dd></div><div><dt>${esc(L.owners)}</dt><dd>${owners(headlineOwners(source), trace)}</dd></div><div><dt>${esc(L.priority)}</dt><dd>${esc(source.priority)}</dd></div><div><dt>${esc(L.factsVerified)}</dt><dd class="mono">${esc(source.verifiedAt.date)} @ ${esc(source.verifiedAt.commit)}</dd></div><div class="rev"><dt>${esc(L.reversibility)}</dt><dd>${esc(source.reversibility)}</dd></div></dl></div></header>`;
  }

  function rulingBlock(call: Call): string {
    const ruling = call.ruling as NonNullable<Call["ruling"]>;
    const o = optionById(call, ruling.option);
    return `<div class="blk" data-place="${esc(L.ruling)}"><h3 class="lab">${esc(L.ruling)}</h3><p><span class="st st-done">${esc(D.stateDone)} ${esc(L.ruledOn)} ${esc(ruling.ruledAt)}</span></p><p>${chip(call.id, o.id)} <strong>${esc(o.name)}</strong></p><p>${ext(ruling.recordUrl, L.rulingRecord)}</p></div>`;
  }

  /** The recommendation: a call's recommended option and why, and the overall read. */
  function recBlock(
    call: Call | undefined,
    myRead: string | undefined,
    r: Region,
    place?: string,
  ): string {
    let h = "";
    if (call?.recommended) {
      const o = optionById(call, call.recommended);
      h += `<p>${chip(call.id, o.id)} <strong>${esc(sentence(o.name))}</strong> ${rich(call.why ?? "", r)}</p>`;
    }
    if (myRead) h += `<p>${rich(myRead, r)}</p>`;
    return h
      ? `<div class="blk" data-place="${esc(place ?? L.recommendation)}"><h3 class="lab">${esc(L.recommendation)}</h3>${h}</div>`
      : "";
  }

  const openBlock = (call: Call, r: Region) =>
    call.openInput && !call.ruling
      ? `<div class="blk" data-place="${esc(D.openInput)}"><h3 class="lab oi-l">${esc(D.stateInput)} ${esc(D.openInput)}</h3><p>${rich(call.openInput, r)}</p></div>`
      : "";

  /** The outcome matrix: one tinted tile per option and scenario, each with a glyph and a word. */
  function matrix(call: Call, r: Region): string {
    const scenarios = call.scenarios ?? [];
    const chosen = call.ruling?.option;
    const picks = !call.ruling;
    const head = `<tr>${picks ? `<th class="mx-p" scope="col" data-js hidden>${esc(D.pick)}</th>` : ""}<th class="mx-o" scope="col">${esc(L.option)}</th>${scenarios
      .map(
        (s) =>
          `<th scope="col"><span class="sl">${esc(s.label)}</span>${rich(s.detail, r)}</th>`,
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
            return `<td class="k-${outcome.kind}" data-s="${esc(s.label)}"><span class="ow">${OUTCOME_ICON[outcome.kind]} ${OUTCOME_WORD[outcome.kind]}</span><span class="ot">${rich(outcome.text, r)}</span></td>`;
          })
          .join("");
        return `<tr data-t="${esc(optionKey(call.id, o.id))}"${chosen && chosen !== o.id ? ' class="dim"' : ""}>${picks ? `<td class="mx-p" data-js hidden>${pick(call, o, true)}</td>` : ""}<th scope="row"><span class="oh">${chip(call.id, o.id)}<span class="on">${esc(o.name)}</span>${tags(call, o)}</span></th>${cells}</tr>`;
      })
      .join("");
    const used = new Set(
      call.options.flatMap((o) =>
        Object.values(o.outcomes ?? {}).map((x) => x.kind),
      ),
    );
    const legend = OUTCOME_KINDS.filter(
      (k) => used.has(k) && call.outcomeMeaning?.[k],
    )
      .map(
        (k) =>
          `<li><span class="sw k-${k}">${OUTCOME_ICON[k]} ${OUTCOME_WORD[k]}</span><span>${rich(call.outcomeMeaning?.[k] ?? "", r)}</span></li>`,
      )
      .join("");
    return `<table class="mx"><thead>${head}</thead><tbody>${rows}</tbody></table>${legend ? `<ul class="legend">${legend}</ul>` : ""}`;
  }

  const list = (items: string[], r: Region) =>
    `<ul>${items.map((x) => `<li>${rich(x, r)}</li>`).join("")}</ul>`;

  /** Every option in full: keep, pay, right when. The name, tags and Pick hang in the left column and stay pinned beside a long option. */
  function optionsBody(call: Call, r: Region): string {
    const chosen = call.ruling?.option;
    return `<div class="opts">${call.options
      .map(
        (o) =>
          `<article class="opt${chosen && chosen !== o.id ? " dim" : ""}" id="${esc(optionKey(call.id, o.id))}" data-t="${esc(optionKey(call.id, o.id))}"><div class="opt-side"><h3 class="opt-h">${chip(call.id, o.id)}<span class="on">${esc(o.name)}</span></h3>${tags(call, o) ? `<span class="opt-tags">${tags(call, o)}</span>` : ""}${pick(call, o, false)}</div><div class="opt-main"><p class="sum">${rich(o.summary, r)}</p><div class="kpr"><div><h4 class="lab">${esc(L.keep)}</h4>${list(o.keep, r)}</div><div><h4 class="lab">${esc(L.pay)}</h4>${list(o.pay, r)}</div><div><h4 class="lab">${esc(L.rightWhen)}</h4><p>${rich(o.rightWhen, r)}</p>${o.obligation ? `<h4 class="lab">${esc(L.obligation)}</h4><p>${rich(o.obligation, r)}</p>` : ""}</div></div></div></article>`,
      )
      .join("")}</div>`;
  }

  const claims = (items: { text: string; source: string }[], r: Region) =>
    claimList(items, (t) => rich(t, r), L.source);

  function subQuestions(
    call: Call,
    r: Region,
    h: "h2" | "h3",
    idPrefix: string,
    placePrefix: string,
  ): string {
    const chosen = call.ruling?.option;
    return (call.subQuestions ?? [])
      .map((q, i) => {
        const rows = call.options
          .map(
            (o) =>
              `<tr data-t="${esc(optionKey(call.id, o.id))}"${chosen && chosen !== o.id ? ' class="dim"' : ""}><th scope="row">${chip(call.id, o.id)}</th><td>${rich(q.byOption[o.id] ?? "", r)}</td></tr>`,
          )
          .join("");
        const label = q.title ?? L.followOn;
        return sec(
          label,
          `<p class="main">${rich(q.question, r)}</p><table class="sq"><thead><tr><th class="lab" scope="col">${esc(L.ifYouChoose)}</th><th class="lab" scope="col">${esc(D.answer)}</th></tr></thead><tbody>${rows}</tbody></table>`,
          {
            h,
            id: subQuestionId(idPrefix, q.title, i),
            place: `${placePrefix}${label}`,
          },
        );
      })
      .join("");
  }

  const subQuestionId = (
    prefix: string,
    title: string | undefined,
    i: number,
  ) => `${prefix}sq-${slug(title ?? "") || i + 1}-${i + 1}`;

  const notesSection = (
    call: Call,
    r: Region,
    h: "h2" | "h3",
    placePrefix: string,
  ) =>
    call.notes?.length
      ? sec(
          L.notes,
          call.notes.map((n) => `<p class="main">${rich(n, r)}</p>`).join(""),
          { h, place: `${placePrefix}${L.notes}` },
        )
      : "";

  function branches(r: Region): string {
    return sec(
      L.hiddenBranches,
      `<div class="brs">${(source.hiddenBranches ?? [])
        .map(
          (b, i) =>
            `<div class="br"><h3><span class="n">${i + 1}</span><span>${esc(b.title)}</span></h3><p>${rich(b.text, r)}</p><p class="next"><b>${esc(D.nextStep)}</b>${rich(b.action, r)}</p></div>`,
        )
        .join("")}</div>`,
      { id: "before" },
    );
  }

  /** A call or an issue named in an interplay line: a chip when it is a call of a several-call sheet, plain text otherwise. */
  const xref = (x: string) =>
    multi && callIds.has(x) ? callChip(x) : `<span class="xr">${esc(x)}</span>`;

  const interplayList = (items: DecisionSource["interplay"], r: Region) =>
    `<ul class="ip">${(items ?? [])
      .map(
        (i) =>
          `<li data-place="${esc(`${i.from} → ${i.to}`)}"><span class="ipk">${xref(i.from)}<span aria-hidden="true">→</span><span class="vh">${esc(D.affects)}</span>${xref(i.to)}</span><span>${rich(i.text, r)}</span></li>`,
      )
      .join("")}</ul>`;

  function callIndex(): string {
    const rows = source.calls
      .map((c) => {
        let state: string;
        if (c.ruling) {
          const o = optionById(c, c.ruling.option);
          state = `<span class="r"><span class="st st-done">${esc(D.stateDone)} ${esc(L.ruledOn)} ${esc(c.ruling.ruledAt)}</span></span><span class="r">${chip(c.id, o.id)}<span>${esc(o.name)}</span></span>`;
        } else {
          state = `<span class="r"><span class="st st-open">${esc(D.stateOpen)} ${esc(L.open)}</span>${c.openInput ? `<span class="st st-open">${esc(D.stateInput)} ${esc(D.openInput)}</span>` : ""}</span>`;
          if (c.recommended) {
            const o = optionById(c, c.recommended);
            state += `<span class="r"><span>${esc(D.recommendedState)}</span>${chip(c.id, o.id)}<span>${esc(o.name)}</span></span>`;
          }
        }
        return `<tr data-t="c-${esc(c.id)}"><td><span class="ct">${callChip(c.id)}<a href="#call-${esc(c.id)}">${esc(c.title ?? "")}</a></span></td><td><span class="owns">${owners(c.owners ?? source.owners, false)}</span></td><td><span class="state">${state}</span></td><td data-js hidden>${c.ruling ? "" : `<span class="r" data-pick-long="${esc(c.id)}"></span>`}</td></tr>`;
      })
      .join("");
    return sec(
      L.calls,
      `<table class="idx"><thead><tr><th class="lab" scope="col">${esc(L.call)}</th><th class="lab" scope="col">${esc(L.owners)}</th><th class="lab" scope="col">${esc(D.state)}</th><th class="lab" scope="col" data-js hidden>${esc(D.yourPick)}</th></tr></thead><tbody>${rows}</tbody></table>`,
      { id: "calls" },
    );
  }

  /** One call of a several-call sheet: a heavy rule, a large letter, then the call's own sections. */
  function callSection(c: Call): string {
    const r = region(c.id);
    const prefix = `(${c.id}) `;
    let h = `<section class="call${c.ruling ? " ruled" : ""}" id="call-${esc(c.id)}" aria-labelledby="call-${esc(c.id)}-t">`;
    h += `<div class="sec call-h"><div class="cl-wrap"><span class="lab">${esc(L.call)}</span><span class="cl">${esc(c.id)}</span></div><div class="body"><h2 id="call-${esc(c.id)}-t">${esc(c.title ?? "")}</h2><p class="cmeta">${
      c.ruling
        ? `<span class="st st-done">${esc(D.stateDone)} ${esc(L.ruledOn)} ${esc(c.ruling.ruledAt)}</span>`
        : `<span class="st st-open">${esc(D.stateOpen)} ${esc(L.open)}</span>`
    }<span><span class="k">${esc(L.owners)} </span><span class="owns">${owners(c.owners ?? source.owners, true)}</span></span></p></div></div>`;
    const side =
      (c.ruling
        ? rulingBlock(c)
        : recBlock(c, undefined, r, `${prefix}${L.recommendation}`)) +
      openBlock(c, r);
    h += sec(
      L.theQuestion,
      `<div class="main"><p>${rich(c.question ?? "", r)}</p></div>${side ? `<aside class="side">${side}</aside>` : ""}`,
      { h: "h3", pair: true, place: `${prefix}${L.theQuestion}` },
    );
    if (c.facts?.length)
      h += sec(L.facts, claims(c.facts, r), {
        h: "h3",
        place: `${prefix}${L.facts}`,
      });
    if (c.scenarios?.length)
      h += sec(D.outcomes, matrix(c, r), {
        h: "h3",
        place: `${prefix}${D.outcomes}`,
      });
    h += sec(L.options, optionsBody(c, r), {
      h: "h3",
      raw: true,
      cls: "sec-o",
      place: `${prefix}${L.options}`,
    });
    h += subQuestions(c, r, "h3", `call-${c.id}-`, prefix);
    h += notesSection(c, r, "h3", prefix);
    const connected = (source.interplay ?? []).filter(
      (i) => i.from === c.id || i.to === c.id,
    );
    if (connected.length)
      h += sec(D.connectsTo, interplayList(connected, r), {
        h: "h3",
        place: `${prefix}${D.connectsTo}`,
      });
    return `${h}</section>`;
  }

  // ---------- the top bar ----------

  const nav: string[] = [];
  const navItem = (id: string, label: string) => nav.push(navEntry(id, label));
  const navSep = () => nav.push(NAV_SEPARATOR);

  const barCall = (c: Call) =>
    `<li><a class="bar-c" href="#call-${esc(c.id)}" data-t="c-${esc(c.id)}"><b>${esc(c.id)}</b><span aria-hidden="true">${esc(c.ruling ? D.stateDone : D.stateOpen)}</span><span class="w">${esc(c.ruling ? L.ruledOn : L.open)}</span><span class="p" data-pick-for="${esc(c.id)}" hidden></span></a></li>`;

  const bar = () =>
    topBar({
      id: source.id,
      navLabel: D.navContents,
      nav,
      ...(source.calls.length > MANY_CALLS ? { cls: "bar-many" } : {}),
      end: `<button type="button" class="bar-picks" aria-expanded="false" aria-controls="tray" hidden>${esc(multi ? D.myPicks : D.myPick)}<b></b></button>`,
    });

  // ---------- the page ----------

  const parts: string[] = ['<main class="sheet" id="top">', mast()];
  const only = source.calls[0] as Call;
  const late = status.kind === "done";

  // The question, with the recommendation or the ruling beside it.
  const questionRegion = region(multi ? undefined : only.id);
  // The question text renders first: a region links a glossary term at its
  // first use in reading order, and the question comes before the side column.
  let questionHtml = paras(source.question, questionRegion);
  let side = "";
  if (!multi) {
    if (only.title)
      questionHtml += `<p><strong>${esc(only.title)}</strong></p>`;
    if (only.question) questionHtml += paras(only.question, questionRegion);
    side =
      (only.ruling
        ? rulingBlock(only)
        : recBlock(only, source.myRead, questionRegion)) +
      openBlock(only, questionRegion);
  } else if (!late) {
    side = recBlock(undefined, source.myRead, questionRegion);
  }
  parts.push(
    sec(
      L.theQuestion,
      `<div class="main">${questionHtml}</div>${side ? `<aside class="side">${side}</aside>` : ""}`,
      { id: "question", pair: true },
    ),
  );
  navItem("question", D.navQuestion);

  const interplayRegion = region(multi ? undefined : only.id);
  if (multi) {
    parts.push(callIndex());
    navItem("calls", L.calls);
  } else if (only.scenarios?.length) {
    parts.push(
      sec(D.outcomes, matrix(only, region(only.id)), { id: "outcomes" }),
    );
    navItem("outcomes", D.outcomes);
  }
  if (source.interplay?.length)
    parts.push(
      sec(L.interplay, interplayList(source.interplay, interplayRegion), {
        id: "interplay",
      }),
    );

  if (source.hiddenBranches?.length && !late) {
    parts.push(branches(region(multi ? undefined : only.id)));
    navItem("before", L.hiddenBranches);
  }

  if (multi) {
    navSep();
    for (const c of source.calls) {
      parts.push(callSection(c));
      nav.push(barCall(c));
    }
    navSep();
  } else {
    const r = region(only.id);
    if (only.facts?.length) parts.push(sec(L.facts, claims(only.facts, r)));
    parts.push(
      sec(L.options, optionsBody(only, r), {
        id: "options",
        raw: true,
        cls: "sec-o",
      }),
    );
    navItem("options", L.options);
    (only.subQuestions ?? []).forEach((q, i) => {
      navItem(subQuestionId("", q.title, i), q.title ?? L.followOn);
    });
    parts.push(subQuestions(only, r, "h2", "", ""));
    parts.push(notesSection(only, r, "h2", ""));
  }

  if (source.hiddenBranches?.length && late) {
    parts.push(branches(region(multi ? undefined : only.id)));
    navItem("before", L.hiddenBranches);
  }

  // Evidence follows the calls, behind the one heavy rule of a several-call sheet.
  let heavy = multi;
  const after = (label: string, body: string, id: string) => {
    parts.push(sec(label, body, { id, ...(heavy ? { cls: "heavy" } : {}) }));
    heavy = false;
  };
  if (source.currentBehaviour.length) {
    after(
      L.currentBehaviour,
      claims(source.currentBehaviour, region(multi ? undefined : only.id)),
      "now",
    );
    navItem("now", D.navEvidence);
  }
  if (source.settled?.length)
    after(
      L.settled,
      claims(source.settled, region(multi ? undefined : only.id)),
      "settled",
    );
  if (source.glossary?.length) {
    after(L.terms, termList(source.glossary, termIds), "terms");
    navItem("terms", L.terms);
  }
  parts.push("</main>");

  return page({
    title: `${source.id}: ${source.title}`,
    css: DOCUMENT_CSS,
    body: bar() + parts.join(""),
    source: { id: SOURCE_BLOCK_ID, template: "document", value: source },
    script: DOCUMENT_SCRIPT,
  });
}
