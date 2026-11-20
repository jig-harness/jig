import { describe, expect, test } from "bun:test";
import {
  acceptedRows,
  containsEntry,
  assessEpic,
  createProposal,
  readScopes,
  verifyApprovedScope,
} from "../scripts/lib/epic-sweep-plan.ts";
import type { Issue, IssueSummary } from "../scripts/lib/tracker/port.ts";

const epic: Issue = {
  id: "epic",
  identifier: "#10",
  title: "Deliver a feature",
  description: "",
  url: null,
  state: { name: "In Progress", type: "started" },
  nativeType: "Epic",
  labels: [],
  isEpic: true,
  parent: null,
  children: [],
  assignee: null,
  project: null,
  type: null,
  priority: 0,
  size: null,
};

const done: IssueSummary = {
  identifier: "#11",
  title: "Build feature",
  state: { name: "Done", type: "completed" },
  labels: [],
};
const person: IssueSummary = {
  identifier: "#12",
  title: "Check in production",
  state: { name: "In Progress", type: "started" },
  labels: ["hitl"],
};
const plan = { path: "design/plan.md", heading: "10. Deliver a feature" };
const scope = { epic: "#10", plan, roadmap: null, remainder: [] };
const present = () => Promise.resolve(true);
const absent = () => Promise.resolve(false);

describe("epic sweep assessments", () => {
  test("suggests linked backlog work and preserves ordinary scope", async () => {
    const remaining = {
      ...scope,
      remainder: [{ title: "Build the exporter" }],
    };
    const proposed = await assessEpic(epic, [done, person], remaining, present);
    expect(proposed).toMatchObject({
      outcome: "close-with-remainder",
      personTails: ["#12"],
      completed: ["#11"],
      planPresent: true,
      remainder: ["Build the exporter"],
    });
    const blocked = await assessEpic(
      epic,
      [done, person, { ...person, identifier: "#13", labels: [] }],
      remaining,
      present,
    );
    expect(blocked).toMatchObject({ outcome: "keep-open", nextChild: "#13" });
  });

  test("requires an assessment and rejects malformed or duplicate assessments", async () => {
    expect((await assessEpic(epic, [done], undefined, absent)).outcome).toBe(
      "needs-assessment",
    );
    expect(() => readScopes({ scopes: [scope, scope] })).toThrow("Duplicate");
    expect(() =>
      readScopes({
        scopes: [{ ...scope, plan: { ...plan, path: "../plan.md" } }],
      }),
    ).toThrow("plan");
  });

  test("reads real headings and ignores fenced examples", () => {
    expect(containsEntry("### 10. Renamed work", plan.heading)).toBe(true);
    expect(containsEntry("```md\n### 10. Example\n```", plan.heading)).toBe(
      false,
    );
  });

  test("preserves unchecked operator steps and keeps a missing checklist open", async () => {
    const manual = { ...epic, labels: ["manual-ops"] };
    expect((await assessEpic(manual, [done], scope, absent)).outcome).toBe(
      "needs-operator-checklist",
    );
    const withSteps = {
      ...manual,
      description:
        "## Operator Checklist\n\n- [x] Tested\n-  [ ] Verify in production\n1.  [ ] Confirm the rollout\n1) [ ] Obtain approval",
    };
    expect(
      (await assessEpic(withSteps, [done], scope, absent)).operatorSteps,
    ).toEqual([
      "Verify in production",
      "Confirm the rollout",
      "Obtain approval",
    ]);
  });

  test("keeps continuation lines and refuses fenced checklist items", async () => {
    const manual = { ...epic, labels: ["manual-ops"] };
    const row = (description: string) =>
      assessEpic({ ...manual, description }, [done], scope, absent);
    expect(
      (
        await row(
          "## Operator Checklist\n\n- [ ] Deploy\n  only after approval\n- [ ] Verify",
        )
      ).operatorSteps,
    ).toEqual(["Deploy only after approval", "Verify"]);
    expect(
      (await row("## Operator Checklist\n\n- [ ] \n  Verify production"))
        .operatorSteps,
    ).toEqual(["Verify production"]);
    expect(
      (await row("## Operator Checklist\n\n- [ ]\n- [ ] Verify")).outcome,
    ).toBe("needs-operator-checklist");
    expect(
      (await row("## Operator Checklist\n\n- [ ] Run\n  ```sh\n  make\n  ```"))
        .outcome,
    ).toBe("needs-operator-checklist");
  });

  test("an unchecked item owns its blank-separated, nested and quoted content", async () => {
    const manual = { ...epic, labels: ["manual-ops"] };
    const row = (description: string) =>
      assessEpic({ ...manual, description }, [done], scope, absent);
    const head = "## Operator Checklist\n\n- [ ] Deploy\n";
    expect((await row(`${head}\n  only after approval`)).operatorSteps).toEqual(
      ["Deploy only after approval"],
    );
    for (const block of [
      "  - needs approval",
      "  > Only after operator approval",
      "\n  ```sh\n  make\n  ```",
    ]) {
      expect((await row(head + block)).outcome).toBe(
        "needs-operator-checklist",
      );
    }
    expect(
      (await row(`${head}\n> an unrelated example\n- [ ] Verify`))
        .operatorSteps,
    ).toEqual(["Deploy", "Verify"]);
    expect(
      (await row(`${head}- [x] Done\n- [ ] Verify`)).operatorSteps,
    ).toEqual(["Deploy", "Verify"]);
  });

  test("reads tasks and block boundaries from the scanner's list metadata", async () => {
    const manual = { ...epic, labels: ["manual-ops"] };
    const row = (description: string) =>
      assessEpic({ ...manual, description }, [done], scope, absent);
    const head = "## Operator Checklist\n\n";
    expect(
      (await row(`${head}  - [ ] Verify production`)).operatorSteps,
    ).toEqual(["Verify production"]);
    expect((await row(`${head}- [x] Done\n   - [ ] Nested task`)).outcome).toBe(
      "needs-operator-checklist",
    );
    expect(
      (await row(`${head}- [x] Deploy\n  - [ ]\n    Verify rollout`)).outcome,
    ).toBe("needs-operator-checklist");
    expect(
      (
        await row(
          `${head}- [ ] Deploy\n> Background information\n\n- [ ] Verify`,
        )
      ).operatorSteps,
    ).toEqual(["Deploy", "Verify"]);
    expect(
      (await row(`${head}- [ ] Deploy\n  > nested note\n- [ ] Verify`)).outcome,
    ).toBe("needs-operator-checklist");
  });

  test("refuses a thematic break inside an item and same-line nested markers", async () => {
    const manual = { ...epic, labels: ["manual-ops"] };
    const row = (description: string) =>
      assessEpic({ ...manual, description }, [done], scope, absent);
    const head = "## Operator Checklist\n\n";
    for (const body of [
      "- [ ] Deploy\n  ---\n  only after operator approval",
      "- - [ ] Verify production",
      "1. - [ ] Verify production",
    ]) {
      expect((await row(head + body)).outcome).toBe("needs-operator-checklist");
    }
    expect(
      (await row(`${head}- [ ] Deploy\n---\n- [ ] Verify`)).operatorSteps,
    ).toEqual(["Deploy", "Verify"]);
  });

  test("binds a reply to the proposal and supports exclusions", async () => {
    const row = await assessEpic(epic, [done], scope, absent);
    const proposal = createProposal([row, { ...row, epic: "#20" }]);
    expect(acceptedRows(proposal, "all except #20", [proposal.marker])).toEqual(
      [row],
    );
    expect(() => acceptedRows(proposal, "accept all", [])).toThrow("proposal");
    expect(() =>
      acceptedRows(proposal, "accept all", [
        proposal.marker,
        createProposal([row]).marker,
      ]),
    ).toThrow("proposal");
    expect(() =>
      acceptedRows({ ...proposal, rows: [row] }, "accept all", [
        proposal.marker,
      ]),
    ).toThrow("proposal");
  });

  test("blocks acceptance while a status entry remains or new work appears", async () => {
    const approved = await assessEpic(epic, [done, person], scope, present);
    expect(() => verifyApprovedScope(approved, approved)).toThrow("plan");
    const ready = await assessEpic(epic, [done], scope, absent);
    expect(() => verifyApprovedScope(approved, ready)).not.toThrow();
    const detached = await assessEpic(epic, [person], scope, absent);
    expect(() => verifyApprovedScope(approved, detached)).toThrow("changed");
    const changed = await assessEpic(
      epic,
      [done, { ...person, identifier: "#14" }],
      scope,
      absent,
    );
    expect(() => verifyApprovedScope(approved, changed)).toThrow("changed");
  });
});
