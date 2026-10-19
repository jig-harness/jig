/**
 * The parts of the HTML projection that every decision template shares: the
 * embedded source block, the template names and the compact outcome colours.
 * Escaping and the structural palette come from the sheet kit
 * (`../sheet-kit/html.ts`). A template is one module that turns a decision
 * source into a self-contained sheet (`html-compact.ts`, `html-document.ts`);
 * `html.ts` picks one.
 */
import { extractEmbedded } from "../sheet-kit/html.ts";

export const SOURCE_BLOCK_ID = "decision-source";

/** The sheet layouts. `compact` is the drawing sheet, the first layout; `document` is the report layout. */
export const SHEET_TEMPLATES = ["compact", "document"] as const;
export type SheetTemplate = (typeof SHEET_TEMPLATES)[number];
export const DEFAULT_TEMPLATE: SheetTemplate = "document";

/**
 * Recover the embedded source from a rendered sheet. The block may carry a
 * `data-template` attribute, which `extractTemplate` reads.
 */
export function extractSource(html: string): unknown {
  return extractEmbedded(html, SOURCE_BLOCK_ID, "decision source").value;
}

/**
 * The template a sheet was rendered with. A sheet without the attribute is a
 * compact sheet: the compact layout never recorded one, and every sheet made
 * before the document layout existed is compact.
 */
export function extractTemplate(html: string): SheetTemplate {
  const found = extractEmbedded(
    html,
    SOURCE_BLOCK_ID,
    "decision source",
  ).template;
  if (found === undefined) return "compact";
  if (!(SHEET_TEMPLATES as readonly string[]).includes(found))
    throw new Error(
      `unknown template "${found}" in the embedded source; use ${SHEET_TEMPLATES.join(" or ")}`,
    );
  return found as SheetTemplate;
}

/**
 * The outcome colours of the compact template. They have no token yet (the
 * set has no red). A test holds each at WCAG AA contrast against white. The
 * structural palette is the kit's `PALETTE`.
 */
export const OUTCOME_COLOUR = {
  safe: "#2e6b34",
  risk: "#b3261e",
  human: "#8a5a00",
  neutral: "#475569",
} as const;
