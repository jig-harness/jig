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
        "## Operator Checklist\n\n- [x] Tested\n- [ ] Verify in production",
    };
    expect(
      (await assessEpic(withSteps, [done], scope, absent)).operatorSteps,
    ).toEqual(["Verify in production"]);
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
