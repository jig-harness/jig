/** The terminal report carries serialization's part: groups in order, the leader, and each hold. */
import { describe, expect, it } from "bun:test";
import { formatReceipt } from "../lib/report.ts";

describe("the text report of serialization", () => {
  it("names each group's order and leader, why an order cannot be told, and each held re-arm", () => {
    const repo = {
      slug: "example-org/example-repo",
      path: ".",
      refused: null,
      records: [],
      actions: [],
      running: [],
      unplaced: [],
      launches: [],
      notifications: [],
      quiet: [],
      serialized: {
        catalog: "example-org/example-repo@main:catalog.yaml",
        areas: ["migrations", "schema"],
        groups: [
          {
            area: "migrations",
            order: [
              { target: "PR #3", place: "converged and mergeable" },
              { target: "PR #1", place: "stale" },
            ],
            leader: "PR #3",
            drives: "2 drives run",
          },
          {
            area: "schema",
            order: [{ target: "PR #4", place: "stale" }],
            leader: null,
            unplaced: "PR #4's review threads do not read",
          },
        ],
        held: [
          {
            target: "PR #1",
            stage: "rearm",
            reason: "held: serialized behind #3 in migrations",
          },
        ],
      },
    };
    const text = formatReceipt(
      { runId: "r", apply: false, repos: [repo] } as never,
      "receipt.json",
    );
    expect(text).toContain("PR #3 leads; 2 drives run");
    expect(text).toContain("1. PR #3: converged and mergeable");
    expect(text).toContain("no leader (PR #4's review threads do not read)");
    expect(text).toContain(
      "held serialized behind #3 in migrations".replace(
        "held ",
        "held     rearm    PR #1: held: ",
      ),
    );
  });
});
