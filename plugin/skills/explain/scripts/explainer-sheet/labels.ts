/**
 * Every fixed string the explainer projections add around the source's own
 * text. Nothing else may appear in a rendered sheet: the "no claim
 * absent from the source" test reads this table as the complete list of what
 * the renderer may add. Each label names a slot. None of them states a fact
 * about the system being explained.
 */

export const LABEL = {
  sheet: "Explainer",
  inShort: "In short",
  covers: "Covers",
  excludes: "Not covered",
  flow: "How it works",
  details: "Details",
  /** The word a reference token `{step:3}` expands to: "step 3". */
  refStep: "step",
  figure: "Figure",
  diagramSource: "Diagram source:",
  openQuestions: "Open questions",
  terms: "Terms",
  related: "Related",
  factsVerified: "Facts verified",
  source: "Source:",
} as const;

/** The strings only the HTML sheet adds: its contents bar and the script's time left. */
export const SHEET_LABEL = {
  navContents: "Sheet contents",
  timeLeft: "~{n} min left",
  timeEnd: "End",
} as const;

/** The attachment name of a rendered explainer. */
export const SHEET_FILENAME_SUFFIX = "-explainer.html";
