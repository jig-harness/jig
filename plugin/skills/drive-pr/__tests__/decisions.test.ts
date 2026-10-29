/**
 * Every autonomous decision is recorded: `drive-state.ts record-decision`
 * appends one with the level it was taken under, and the handoff lists it
 * under `## Decisions taken unattended`, counting one with no record as a
 * defect.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createStateDurabilityFixtures } from "./drive-pr-state-durability-fixtures.ts";

useDrivePrSuite();

const { stateDirFor, state } = createStateDurabilityFixtures();

function unattendedOverlay(): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "decisions-overlay-")),
    "jig.yaml",
  );
  writeFileSync(path, "autonomy:\n  level: unattended\n");
  return path;
}

describe("record-decision", () => {
  it("records the level, class, record and how to reverse it", async () => {
    const d = stateDirFor("decision-recorded");
    const env = {
      DRIVE_PR_HANDOFF_DIR: join(d, "handoff"),
      DRIVE_PR_TARGET: "999",
      JIG_OVERLAY: unattendedOverlay(),
    };
    const r = await state(
      d,
      ["record-decision", "999"],
      env,
      JSON.stringify({
        class: "file-issue",
        what: "filed the follow-up for the unvalidated retry budget",
        record: "https://example.invalid/issues/7",
        reverse: "close the issue",
      }),
    );
    expectSpawnExit(r, 0);
    await state(d, ["handoff", "999"], env);
    const handoff = readFileSync(join(d, "handoff", "pr-drive-999.md"), "utf8");
    expect(handoff).toContain("## Decisions taken unattended");
    expect(handoff).toContain(
      "- **file-issue** at `unattended`, round 0: filed the follow-up",
    );
    expect(handoff).toContain("to reverse: close the issue");
    expect(handoff).not.toContain("a defect");
  });

  it("counts a decision with no record as a defect", async () => {
    const d = stateDirFor("decision-unrecorded");
    const env = { DRIVE_PR_HANDOFF_DIR: join(d, "handoff") };
    const r = await state(
      d,
      ["record-decision", "999"],
      env,
      JSON.stringify({
        class: "decide-reversible",
        what: "kept the parser in one module",
        reverse: "split it in a later pull request",
      }),
    );
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("counts it as a defect");
    const handoff = readFileSync(join(d, "handoff", "pr-drive-999.md"), "utf8");
    expect(handoff).toContain("at `attended`");
    expect(handoff).toContain("1 decision(s) without a record");
  });

  it("refuses a class outside the decision classes", async () => {
    const d = stateDirFor("decision-bad-class");
    const r = await state(
      d,
      ["record-decision", "999"],
      {},
      JSON.stringify({ class: "merge", what: "x", reverse: "y" }),
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("class must be one of");
  });

  it("refuses a record that is a placeholder rather than a url", async () => {
    const records = ["none", "TODO", "#", "ftp://example.invalid/x"];
    for (const [i, record] of records.entries()) {
      const d = stateDirFor(`decision-bad-record-${i}`);
      const r = await state(
        d,
        ["record-decision", "999"],
        {},
        JSON.stringify({
          class: "file-issue",
          what: "filed the follow-up",
          record,
          reverse: "close the issue",
        }),
      );
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain("record an http(s) url");
    }
  });
});
