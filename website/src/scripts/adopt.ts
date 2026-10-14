/**
 * The adoption guides' profile choice: the cards, the plan rail and the
 * reasoning all follow it, and the address keeps it (`?profile=`) so the
 * hand-off link opens on the same plan. A guide opened from such a link
 * says so.
 */
const pills = [...document.querySelectorAll<HTMLElement>("[data-profile-id]")];
const ids = [...new Set(pills.map((p) => p.dataset.profileId ?? ""))];

function choose(index: number, remember: boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-profile]"))
    el.setAttribute(
      "aria-checked",
      String(Number(el.dataset.profile) === index),
    );
  for (const el of document.querySelectorAll<HTMLElement>("[data-for-profile]"))
    el.hidden = Number(el.dataset.forProfile) !== index;
  if (remember) {
    const url = new URL(location.href);
    url.searchParams.set("profile", ids[index] ?? "");
    history.replaceState(null, "", url);
  }
}

const asked = new URLSearchParams(location.search).get("profile");
const start = asked ? ids.indexOf(asked) : -1;
if (start >= 0) {
  choose(start, false);
  const banner = document.querySelector<HTMLElement>("[data-handed-over]");
  const name =
    pills.find((p) => p.dataset.profileId === asked)?.textContent ?? "";
  if (banner) {
    const slot = banner.querySelector("[data-profile-name]");
    if (slot) slot.textContent = name;
    banner.hidden = false;
  }
}

document.addEventListener("click", (event) => {
  const el = (event.target as Element).closest<HTMLElement>("[data-profile]");
  if (!el) return;
  const index = Number(el.dataset.profile);
  if (!Number.isNaN(index)) choose(index, true);
});
