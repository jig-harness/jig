/**
 * The module page's two switches. Without them the page shows every level
 * and every tool's section, in order.
 *
 * - Level tabs: one level's text and criteria at a time. The URL's hash
 *   (`#standard`) picks the level, so a link or a search result lands on it.
 * - CI provider: only the chosen provider's sections of the mappings show;
 *   the choice is remembered on the device for every module page.
 */
const LEVELS = ["lite", "standard", "strict"];

const tabs = document.querySelector<HTMLElement>("[data-level-tabs]");
const panels = [
  ...document.querySelectorAll<HTMLElement>("[data-level-panel]"),
];

function showLevel(level: string, focus = false): void {
  if (!tabs || !LEVELS.includes(level)) return;
  for (const panel of panels) panel.hidden = panel.dataset.levelPanel !== level;
  for (const tab of tabs.querySelectorAll<HTMLButtonElement>("[data-level]")) {
    const on = tab.dataset.level === level;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
}

/** A level the reader picked: shown, and kept in the URL so a copied link opens it. */
function selectLevel(level: string, focus = false): void {
  history.replaceState(null, "", `#${level}`);
  showLevel(level, focus);
}

if (tabs) {
  tabs.hidden = false;
  const fromHash = location.hash.slice(1);
  showLevel(LEVELS.includes(fromHash) ? fromHash : "lite");
  if (LEVELS.includes(fromHash)) tabs.scrollIntoView({ block: "start" });
  tabs.addEventListener("click", (event) => {
    const tab = (event.target as Element).closest<HTMLElement>("[data-level]");
    if (tab?.dataset.level) selectLevel(tab.dataset.level);
  });
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const current =
      tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset
        .level ?? "lite";
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next =
      LEVELS[(LEVELS.indexOf(current) + step + LEVELS.length) % LEVELS.length];
    if (next) selectLevel(next, true);
  });
  window.addEventListener("hashchange", () => {
    const level = location.hash.slice(1);
    if (LEVELS.includes(level)) {
      showLevel(level);
      tabs.scrollIntoView({ block: "start" });
    }
  });
}

const ciSwitch = document.querySelector<HTMLElement>("[data-ci-switch]");

function storedCi(): string {
  try {
    return localStorage.getItem("jig-ci") ?? "GitHub Actions";
  } catch {
    return "GitHub Actions";
  }
}

function showCi(ci: string): void {
  if (!ciSwitch) return;
  for (const part of document.querySelectorAll<HTMLElement>("[data-ci-part]"))
    part.hidden = part.dataset.ciPart !== ci;
  for (const button of ciSwitch.querySelectorAll<HTMLButtonElement>(
    "[data-ci]",
  ))
    button.setAttribute("aria-checked", String(button.dataset.ci === ci));
}

if (ciSwitch) {
  ciSwitch.hidden = false;
  showCi(storedCi());
  ciSwitch.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>("[data-ci]");
    const ci = button?.dataset.ci;
    if (!ci) return;
    try {
      localStorage.setItem("jig-ci", ci);
    } catch {
      // Storage refused: the choice holds for this page only.
    }
    showCi(ci);
  });
}
