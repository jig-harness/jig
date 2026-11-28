/**
 * The forge classes a label write's refusal itself: `gh pr edit` naming a
 * label the repository lacks is `missing-label`, carrying that label, so
 * the tick never reads the refusal's text; any other refusal stays
 * `refused`.
 */
import { describe, expect, it } from "bun:test";
import { labelEditFailure } from "../lib/forge.ts";

/** The reason a refused `gh pr edit` carries: gh's last line of standard error, as `editLabels` keeps it. */
const refusal = (stderr: string) => ({
  code: "refused" as const,
  reason: `gh pr edit exited 1: ${stderr}`,
});

describe("editLabels' refusal classes", () => {
  it("classes gh's missing-label refusal as missing-label, naming the label", () => {
    const failure = labelEditFailure(refusal("'jig:converged' not found"), [
      "jig:converged",
      "automation",
    ]);
    expect(failure).toMatchObject({
      code: "missing-label",
      missing: ["jig:converged"],
    });
    expect(failure.reason).toContain("'jig:converged' not found");
  });

  it("also reads the create path's prefixed form", () => {
    expect(
      labelEditFailure(
        refusal("could not add label: 'jig:converged' not found"),
        ["jig:converged"],
      ),
    ).toMatchObject({ code: "missing-label", missing: ["jig:converged"] });
  });

  it("keeps a refusal that names no label the write adds as refused", () => {
    expect(
      labelEditFailure(refusal("'other' not found"), ["jig:converged"]).code,
    ).toBe("refused");
    expect(
      labelEditFailure(
        refusal("gh: Resource not accessible by integration (HTTP 403)"),
        ["jig:converged"],
      ).code,
    ).toBe("refused");
  });
});
