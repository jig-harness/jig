/**
 * The site's few interactions, each an enhancement of a page that reads
 * fully without it: the theme switch, Copy buttons, term definitions beside
 * a term, and search. Definitions and the search index load on first use.
 */

// ---------- theme: system → light → dark ----------
const THEMES = ["system", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
const THEME_LABEL: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("jig-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** The theme in effect; storage only remembers it across pages. */
let currentTheme: Theme = storedTheme();

function applyTheme(theme: Theme): void {
  currentTheme = theme;
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem("jig-theme");
    else localStorage.setItem("jig-theme", theme);
  } catch {
    // Storage refused (private mode): the choice holds for this page only.
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-theme-switch]",
  )) {
    const label = button.querySelector(".theme-label");
    if (label) label.textContent = THEME_LABEL[theme];
    button.setAttribute(
      "aria-label",
      theme === "system"
        ? "Theme: follows your system. Switch to light"
        : `Theme: ${theme}. Switch to ${theme === "light" ? "dark" : "your system's"}`,
    );
  }
}

applyTheme(currentTheme);
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-theme-switch]")) {
    const next = THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length];
    if (next) applyTheme(next);
  }
});

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

async function showTip(anchor: HTMLElement): Promise<void> {
  const slug = anchor.dataset.term;
  if (!tip || !slug) return;
  window.clearTimeout(hideTimer);
  if (tipFor === anchor && !tip.hidden) return;
  tipFor = anchor;
  const def = (await loadTerms())[slug];
  if (!def || tipFor !== anchor) return;
  tip.innerHTML = `<div class="tip-head"><strong>${def.term}</strong><span>${def.group}</span></div><div class="tip-def">${def.html}</div><a class="tip-more" href="/glossary/#${slug}">Open in the glossary →</a>`;
  tip.hidden = false;
  anchor.setAttribute("aria-describedby", "term-tip");
  place(anchor);
}

function hideTip(): void {
  hideTimer = window.setTimeout(() => {
    if (tip) tip.hidden = true;
    tipFor?.removeAttribute("aria-describedby");
    tipFor = null;
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
    const term = target.closest<HTMLElement>("a[data-term]");
    if (term) void showTip(term);
  });
for (const type of ["mouseout", "focusout"] as const)
  document.addEventListener(type, (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("a[data-term]") || tip?.contains(target)) hideTip();
  });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && tip && !tip.hidden) {
    tip.hidden = true;
    tipFor = null;
  }
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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

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
