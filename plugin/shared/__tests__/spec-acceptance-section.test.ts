/**
 * The pull request's `## Acceptance` section (`shared/spec/acceptance-section.ts`):
 * one line per criterion, with its state and its evidence, item or reason.
 */
import { expect, test } from "bun:test";
import { renderAcceptanceSection } from "../spec/acceptance-section.ts";
import type { Criterion } from "../spec/resolve.ts";

function criterion(ref: string, id: string, text: string): Criterion {
  return { id, key: `${ref}#${id}`, text, requirement: null, source: 0 };
}

const criteria = [
  criterion("#body/Spec", "AC-1", "The first row\n holds the column names"),
  criterion("#body/Spec", "AC-2", "An empty range gives a header row"),
  criterion("#body/Spec", "AC-3", "Exports finish in 2 seconds"),
  criterion("#body/Spec", "AC-4", "A failed export says why"),
  criterion("#body/Spec", "AC-5", "Exports are logged"),
];

test("issue text cannot open HTML or close the label's code span", () => {
  const section = renderAcceptanceSection(
    [criterion("#body/a`b", "x`y", "Works <!-- & hides the rest")],
    { "#body/a`b#x`y": { state: "met", evidence: "<b>shown</b>" } },
  );
  expect(section.split("\n").at(-1)).toBe(
    "- ``x`y`` Works &lt;!-- &amp; hides the rest: **met**; evidence: &lt;b&gt;shown&lt;/b&gt;",
  );
});

test("writes one line per criterion with its state and what accounts for it", () => {
  expect(
    renderAcceptanceSection(criteria, {
      "#body/Spec#AC-1": {
        state: "met",
        evidence: "test `export.test.ts` header row",
      },
      "AC-2": { state: "deferred", item: "#57" },
      "AC-3": { state: "not applicable", reason: "no export\nruns here" },
      "AC-5": { state: "met", evidence: "  " },
    }),
  ).toBe(
    [
      "## Acceptance",
      "",
      "- `AC-1` The first row holds the column names: **met**; evidence: test `export.test.ts` header row",
      "- `AC-2` An empty range gives a header row: **deferred**; deferred to: #57",
      "- `AC-3` Exports finish in 2 seconds: **not applicable**; reason: no export runs here",
      "- `AC-4` A failed export says why: **unaccounted**",
      "- `AC-5` Exports are logged: **unaccounted** (met without evidence)",
    ].join("\n"),
  );
});

test("a short id two sources share is shown, and accounted for, by its key", () => {
  const shared = [
    criterion("#body/Spec", "AC-1", "Body criterion"),
    criterion("notes/a.md", "AC-1", "File criterion"),
  ];
  expect(
    renderAcceptanceSection(shared, {
      "AC-1": { state: "met", evidence: "ambiguous, counts for neither" },
      "notes/a.md#AC-1": { state: "deferred", item: "" },
    }),
  ).toBe(
    [
      "## Acceptance",
      "",
      "- `#body/Spec#AC-1` Body criterion: **unaccounted**",
      "- `notes/a.md#AC-1` File criterion: **unaccounted** (deferred without an item)",
    ].join("\n"),
  );
});

test("says so when there is no criterion", () => {
  expect(renderAcceptanceSection([], {})).toBe(
    "## Acceptance\n\nNo acceptance criteria resolved.",
  );
});
