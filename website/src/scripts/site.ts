/**
 * The site's few interactions, each an enhancement of a page that reads
 * fully without it: the theme switch, the section bar's scroll, Copy
 * buttons, term definitions beside a term, and search. Definitions and the
 * search index load on first use.
 */

// ---------- theme: the system's until the reader picks light or dark ----------
type Theme = "light" | "dark";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

/** The reader's pick, which the page's head script restores from storage
 *  before it paints; without one the system decides. */
const restored = document.documentElement.dataset.theme;
let chosenTheme: Theme | undefined =
  restored === "light" || restored === "dark" ? restored : undefined;

function themeInEffect(): Theme {
  return chosenTheme ?? (systemDark.matches ? "dark" : "light");
}

/** The switch's icon follows the theme in CSS; its name is set here. */
function labelThemeSwitch(): void {
  const theme = themeInEffect();
  const other = theme === "light" ? "dark" : "light";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-theme-switch]",
  )) {
    button.setAttribute(
      "aria-label",
      `Theme: ${theme}${chosenTheme ? "" : " (your system's)"}. Switch to ${other}`,
    );
  }
}

function chooseTheme(theme: Theme): void {
  chosenTheme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("jig-theme", theme);
  } catch {
    // Storage refused (private mode): the choice holds for this page only.
  }
  labelThemeSwitch();
}

labelThemeSwitch();
systemDark.addEventListener("change", labelThemeSwitch);
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-theme-switch]"))
    chooseTheme(themeInEffect() === "light" ? "dark" : "light");
});

// ---------- the section bar shows its current page ----------
// On a narrow screen the bar scrolls sideways; it starts at the page the
// reader is on.
{
  const row = document.querySelector<HTMLElement>(".section-row");
  const here = row?.querySelector<HTMLElement>("a[aria-current='page']");
  if (row && here && here.offsetLeft + here.offsetWidth > row.clientWidth)
    row.scrollLeft = here.offsetLeft - (row.clientWidth - here.offsetWidth) / 2;
}

// ---------- a header sub-menu closes on Escape ----------
// Escape closes the open menu and puts focus on its entry. Hover and focus
// each open the menu, so it stays closed until both the pointer and focus
// have left the entry, and opens again the next time either comes back.
for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
  const reopen = () => item.classList.remove("dismissed");
  item.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || item.classList.contains("dismissed")) return;
    item.classList.add("dismissed");
    item.querySelector<HTMLElement>(".has-sub")?.focus();
  });
  item.addEventListener("mouseleave", () => {
    if (!item.contains(document.activeElement)) reopen();
  });
  item.addEventListener("focusout", (event) => {
    if (
      !item.contains(event.relatedTarget as Node | null) &&
      !item.matches(":hover")
    )
      reopen();
  });
}

// ---------- Copy buttons ----------
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLElement>("[data-copy]");
  if (!button) return;
  const text =
    button.dataset.copyText ??
    button.closest("figure")?.querySelector("pre")?.innerText ??
    "";
  void navigator.clipboard?.writeText(text).then(() => {
    const before = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = before;
    }, 1200);
  });
});

// ---------- term definitions ----------
const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

interface TermDef {
  term: string;
  group: string;
  html: string;
}

let terms: Promise<Record<string, TermDef>> | undefined;
function loadTerms(): Promise<Record<string, TermDef>> {
  terms ??= fetch("/glossary.json")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return terms;
}

const tip = document.querySelector<HTMLElement>("[data-tip]");
let tipFor: Element | null = null;
let hideTimer: number | undefined;

function place(anchor: Element): void {
  if (!tip) return;
  const r = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
  const below = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top =
    below + tip.offsetHeight > window.innerHeight
      ? `${Math.max(8, r.top - tip.offsetHeight - 8)}px`
      : `${below}px`;
}

// What opens a definition beside it: a glossary term (`data-term`), or an
// element that carries its own (`data-tip-head`, `-kind`, `-body`, `-more`).
const TIPPED = "[data-term], [data-tip-body]";

async function tipHtml(anchor: HTMLElement): Promise<string | undefined> {
  const d = anchor.dataset;
  if (d.tipBody !== undefined) {
    const href = anchor.getAttribute("href");
    const more =
      href && d.tipMore
        ? `<a class="tip-more" href="${escapeHtml(href)}">${escapeHtml(d.tipMore)}</a>`
        : "";
    return `<div class="tip-head"><strong>${escapeHtml(d.tipHead ?? "")}</strong><span>${escapeHtml(d.tipKind ?? "")}</span></div><div class="tip-def">${escapeHtml(d.tipBody)}</div>${more}`;
  }
  const slug = d.term;
  const def = slug ? (await loadTerms())[slug] : undefined;
  if (!def) return undefined;
  return `<div class="tip-head"><strong>${def.term}</strong><span>${def.group}</span></div><div class="tip-def">${def.html}</div><a class="tip-more" href="/glossary/#${slug}">Open in the glossary →</a>`;
}

async function showTip(anchor: HTMLElement): Promise<void> {
  if (!tip) return;
  window.clearTimeout(hideTimer);
  if (tipFor === anchor && !tip.hidden) return;
  // A new anchor takes the panel over empty, so a definition that fails to
  // load never leaves the previous anchor's content showing beside it.
  if (tipFor !== anchor) {
    tip.hidden = true;
    release();
  }
  tipFor = anchor;
  const html = await tipHtml(anchor);
  if (!html || tipFor !== anchor) return;
  tip.innerHTML = html;
  tip.hidden = false;
  anchor.setAttribute("aria-describedby", "term-tip");
  place(anchor);
}

// Unlinks the current anchor from the panel; a definition still loading
// for it is dropped when it arrives, since it no longer owns the panel.
function release(): void {
  tipFor?.removeAttribute("aria-describedby");
  tipFor = null;
}

function dismiss(): void {
  window.clearTimeout(hideTimer);
  if (tip) tip.hidden = true;
  release();
}

// Hover and focus each keep the panel open: it closes only once neither
// the anchor nor the panel is hovered or holds focus.
function engaged(el: Element | null): boolean {
  return !!el && (el.matches(":hover") || el.contains(document.activeElement));
}

function hideTip(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (!engaged(tipFor) && !engaged(tip)) dismiss();
  }, 160);
}

for (const type of ["mouseover", "focusin"] as const)
  document.addEventListener(type, (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (tip?.contains(target)) {
      window.clearTimeout(hideTimer);
      return;
    }
    const term = target.closest<HTMLElement>(TIPPED);
    if (term) void showTip(term);
  });
for (const type of ["mouseout", "focusout"] as const)
  document.addEventListener(type, (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(TIPPED) || tip?.contains(target)) hideTip();
  });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && tipFor) dismiss();
});

// ---------- search ----------
interface Entry {
  kind: string;
  label: string;
  sub: string;
  href: string;
  key: string;
}

let index: Promise<Entry[]> | undefined;
function loadIndex(): Promise<Entry[]> {
  index ??= fetch("/search.json")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return index;
}

const KIND_RANK: Record<string, number> = {
  Page: 0,
  Feature: 1,
  Module: 1,
  Level: 2,
  Station: 3,
  Scaffolding: 3,
  Skill: 4,
  Agent: 4,
  Term: 5,
};

function score(entry: Entry, q: string, words: string[]): number {
  const label = entry.label.toLowerCase();
  let s: number;
  if (label === q) s = 0;
  else if (label.startsWith(q)) s = 1;
  else if (label.includes(q)) s = 2;
  else if (words.every((w) => entry.key.includes(w))) s = 3;
  else return -1;
  return s * 10 + (KIND_RANK[entry.kind] ?? 6);
}

function search(entries: Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  return entries
    .map((e) => ({ e, s: score(e, q, words) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, 8)
    .map((x) => x.e);
}

for (const box of document.querySelectorAll<HTMLElement>("[data-search]")) {
  box.hidden = false;
  const input = box.querySelector<HTMLInputElement>("[data-search-input]");
  const list = box.querySelector<HTMLElement>("[data-search-results]");
  if (!input || !list) continue;
  let results: Entry[] = [];
  let selected = 0;
  const render = () => {
    const q = input.value.trim();
    list.hidden = !q;
    input.setAttribute("aria-expanded", String(!list.hidden));
    if (!q) return;
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) =>
              `<a role="option" aria-selected="${i === selected}" href="${r.href}" class="result"><span class="result-kind">${r.kind}</span><span class="result-text"><span class="result-label">${escapeHtml(r.label)}</span><span class="result-sub">${escapeHtml(r.sub)}</span></span></a>`,
          )
          .join("") +
        '<p class="result-keys">↑ ↓ move · Enter open · Esc close</p>'
      : `<p class="result-none">Nothing matches “${escapeHtml(q)}”. Try a module id (M7), a skill (drive-pr) or a term (drift).</p>`;
  };
  input.addEventListener("input", async () => {
    results = search(await loadIndex(), input.value);
    selected = 0;
    render();
  });
  input.addEventListener("focus", () => void loadIndex());
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected =
        (selected + step + results.length) % Math.max(results.length, 1);
      render();
    } else if (event.key === "Enter" && results[selected]) {
      window.location.href = results[selected].href;
    } else if (event.key === "Escape") {
      input.value = "";
      results = [];
      render();
      input.blur();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }, 150);
  });
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  if (event.key !== "/" || typing) return;
  const input = document.querySelector<HTMLInputElement>("[data-search-input]");
  if (input && input.offsetParent !== null) {
    event.preventDefault();
    input.focus();
  }
});

// ---------- a link into a folded section opens it ----------
function openTarget(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (!target) return;
  let el: HTMLElement | null = target;
  while (el) {
    if (el instanceof HTMLDetailsElement) el.open = true;
    el = el.parentElement;
  }
  target.scrollIntoView();
}
openTarget();
window.addEventListener("hashchange", openTarget);
