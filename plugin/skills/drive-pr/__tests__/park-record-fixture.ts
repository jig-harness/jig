/**
 * A well-formed `drive-state.ts park` call for the tests that need an item
 * parked: the argv with its decision class, and the decision record its stdin
 * carries (`lib/state/framed-park.ts`).
 */

/** The class a fixture park records unless a test names another. */
const FIXTURE_PARK_CLASS = "escalated";

/** `park 999 --key K --kind <kind> --class <class>`. */
export function parkArgs(
  key: string,
  kind: "thread" | "finding",
  parkClass: string = FIXTURE_PARK_CLASS,
  pr = "999",
): string[] {
  return ["park", pr, "--key", key, "--kind", kind, "--class", parkClass];
}

/** A complete decision record asking `question` (a `?` is added when missing). */
export function parkRecord(
  question: string,
  parkClass: string = FIXTURE_PARK_CLASS,
): string {
  const q = question.endsWith("?") ? question : `${question}?`;
  return [
    "## Question",
    "",
    q,
    "",
    "## Options",
    "",
    "- **Keep it** — Changes: nothing in the code. Costs: the reviewer's concern stays open.",
    "- **Change it** — Changes: the anchored function. Costs: one more review round.",
    "",
    "## Recommended",
    "",
    "**Keep it**, because the current value matches the decision the pull request records.",
    "",
    "## Class",
    "",
    parkClass,
    "",
    "## Steps for a person",
    "",
    "None.",
    "",
    "## Already done",
    "",
    "Replied on the thread with an interim status and parked it.",
    "",
  ].join("\n");
}
