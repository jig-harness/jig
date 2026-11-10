/**
 * The pull-request policy's labels checked against the repository's: the
 * fixed labels and the labels the issue's labels map to.
 */
import { describe, expect, test } from "bun:test";
import {
  missingLabelFindings,
  policyLabels,
} from "../scripts/lib/label-fit.ts";

describe("label-fit", () => {
  const config = {
    pull_requests: {
      labels: ["agent-authored"],
      labels_from_issue: {
        "kind:db-migration": "missing-mapped",
        "kind:x": "agent-authored",
      },
    },
  };

  test("collects the fixed labels and the mapped ones, each with its field", () => {
    expect(policyLabels(config)).toEqual([
      ["agent-authored", "pull_requests.labels"],
      ["missing-mapped", "pull_requests.labels_from_issue"],
      ["agent-authored", "pull_requests.labels_from_issue"],
    ]);
    expect(policyLabels({})).toEqual([]);
  });

  test("reports a mapped label the repository does not have", () => {
    expect(
      missingLabelFindings(
        policyLabels(config),
        new Set(["agent-authored"]),
        "acme/app",
      ),
    ).toEqual([
      {
        id: "derivation:pull_requests.labels_from_issue:missing-mapped",
        severity: "error",
        message:
          "pull_requests.labels_from_issue names missing-mapped, which does not exist in acme/app: opening a pull request fails",
      },
    ]);
  });

  test("matches labels in any case, as the planner does", () => {
    expect(
      missingLabelFindings(
        [["Needs-Review", "pull_requests.labels_from_issue"]],
        new Set(["needs-review"]),
        "acme/app",
      ),
    ).toEqual([]);
  });
});
