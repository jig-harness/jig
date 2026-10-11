/**
 * HTML projection of a decision source. Two templates read the same source:
 *
 * - `document` (the default) sets the decision as a report: the question, the
 *   owners, the recommendation and the whole outcome matrix on the first
 *   screen, with light interactivity.
 * - `compact` is the drawing-sheet layout, the first sheet layout.
 *
 * Both are self-contained: no external font, script, stylesheet or image. The
 * source is embedded as an inert `application/json` block, so a later
 * `/decide` run can regenerate the sheet from the attachment alone
 * (`decision-sheet.ts extract`).
 */
import { renderCompactHtml } from "./html-compact.ts";
import { renderDocumentHtml } from "./html-document.ts";
import { DEFAULT_TEMPLATE, type SheetTemplate } from "./html-shared.ts";
import type { DecisionSource } from "./source.ts";

export function renderHtml(
  source: DecisionSource,
  template: SheetTemplate = DEFAULT_TEMPLATE,
): string {
  switch (template) {
    case "compact":
      return renderCompactHtml(source);
    case "document":
      return renderDocumentHtml(source);
    default:
      return assertNever(template);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown sheet template: ${String(value)}`);
}
