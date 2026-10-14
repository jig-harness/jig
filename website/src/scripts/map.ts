/**
 * The module map's profile switch: fills in the chosen profile's targets.
 * Every cell already carries its state for each profile (`data-states`), so
 * switching only moves `data-state` and the per-profile notes.
 */
const MEANING: Record<string, string> = {
  on: "target",
  cond: "target when a condition holds",
  off: "not targeted",
};

function setCell(cell: HTMLElement, index: number): void {
  const state = cell.dataset.states?.split(" ")[index] ?? "off";
  cell.dataset.state = state;
  const label = cell.getAttribute("aria-label");
  if (label)
    cell.setAttribute(
      "aria-label",
      `${label.split(":")[0]}: ${MEANING[state]}`,
    );
}

function showProfile(map: HTMLElement, index: number): void {
  for (const b of map.querySelectorAll<HTMLElement>("[data-profile]"))
    b.setAttribute("aria-checked", String(Number(b.dataset.profile) === index));
  for (const cell of map.querySelectorAll<HTMLElement>("[data-states]"))
    setCell(cell, index);
  for (const note of map.querySelectorAll<HTMLElement>("[data-for-profile]"))
    note.hidden = Number(note.dataset.forProfile) !== index;
}

for (const map of document.querySelectorAll<HTMLElement>("[data-map]")) {
  const pills = map.querySelector<HTMLElement>("[data-map-switch]");
  if (!pills) continue;
  pills.hidden = false;
  pills.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLElement>(
      "[data-profile]",
    );
    const index = Number(button?.dataset.profile);
    if (button && !Number.isNaN(index)) showProfile(map, index);
  });
}
