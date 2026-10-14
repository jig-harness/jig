/**
 * The live audit example: inert until clicked (so the page keeps its
 * scroll), then usable in place; Done makes it inert again. Expand opens it
 * in a full-screen dialog, closed with Close or Escape.
 */
for (const fig of document.querySelectorAll<HTMLElement>("[data-specimen]")) {
  const frame = fig.querySelector<HTMLElement>(".frame");
  const sheet = fig.querySelector<HTMLIFrameElement>("[data-sheet]");
  const use = fig.querySelector<HTMLButtonElement>("[data-use]");
  const done = fig.querySelector<HTMLButtonElement>("[data-done]");
  const note = fig.querySelector<HTMLElement>("[data-live-note]");
  const expand = fig.querySelector<HTMLButtonElement>("[data-expand]");
  const dialog = fig.querySelector<HTMLDialogElement>("[data-full]");
  const fullSheet = fig.querySelector<HTMLIFrameElement>("[data-full-sheet]");
  if (
    !frame ||
    !sheet ||
    !use ||
    !done ||
    !note ||
    !expand ||
    !dialog ||
    !fullSheet
  )
    continue;
  expand.hidden = false;
  const live = (on: boolean) => {
    frame.classList.toggle("live", on);
    sheet.tabIndex = on ? 0 : -1;
    done.hidden = !on;
    note.hidden = !on;
    if (on) sheet.focus();
  };
  use.addEventListener("click", () => live(true));
  done.addEventListener("click", () => {
    live(false);
    use.focus();
  });
  expand.addEventListener("click", () => {
    if (!fullSheet.src) fullSheet.src = sheet.src;
    dialog.showModal();
  });
  fig
    .querySelector("[data-close]")
    ?.addEventListener("click", () => dialog.close());
}
