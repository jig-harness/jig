/** The weights file's fail-closed reading and the priorities record's validator. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneShares } from "../priorities/lanes.ts";
import {
  parsePrioritiesRecord,
  referenceProblems,
  validatePrioritiesRecord,
} from "../priorities/record.ts";
import {
  parseLaneWeights,
  readLaneWeights,
  weightsFilePath,
} from "../priorities/weights.ts";
import { record } from "./priorities-fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the weights file", () => {
  test("lives in the Jig home directory", () => {
    expect(weightsFilePath({ JIG_HOME: "/x/home" })).toBe(
      "/x/home/weights.local.yaml",
    );
  });

  test("a missing file means the built-in defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-weights-"));
    dirs.push(dir);
    const read = readLaneWeights(join(dir, "weights.local.yaml"));
    expect(read).toEqual({
      weights: { "bug-other": 15, core: 50, tactical: 25, peripheral: 10 },
      source: "defaults",
      problems: [],
    });
    expect(laneShares(read.weights)).toEqual({
      core: 0.5,
      tactical: 0.25,
      peripheral: 0.1,
      "bug-other": 0.15,
    });
  });

  test("a missing entry keeps its default, and the accounts section is left to its own reader", () => {
    const read = parseLaneWeights(
      "lanes:\n  core: 80\naccounts:\n  work: 100\n",
      "w.yaml",
    );
    expect(read.weights).toEqual({
      "bug-other": 15,
      core: 80,
      tactical: 25,
      peripheral: 10,
    });
    expect(read.problems).toEqual([]);
  });

  test("an invalid entry for a known lane takes only that lane out", () => {
    const read = parseLaneWeights(
      "lanes:\n  tactical: 101\n  core: -1\n  peripheral: lots\n",
      "w.yaml",
    );
    expect(read.weights).toEqual({
      "bug-other": 15,
      core: null,
      tactical: null,
      peripheral: null,
    });
    expect(read.problems).toHaveLength(3);
    expect(read.problems[0]).toContain("lanes.core");
  });

  test("an unknown lane name takes every weighted lane out", () => {
    const read = parseLaneWeights("lanes:\n  urgent: 10\n", "w.yaml");
    expect(Object.values(read.weights)).toEqual([null, null, null, null]);
    expect(read.problems[0]).toContain("unknown lane `urgent`");
  });

  test("a file that cannot be parsed fails closed for every weighted lane", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-weights-"));
    dirs.push(dir);
    const file = join(dir, "weights.local.yaml");
    writeFileSync(file, "lanes: [core: 50\n");
    const read = readLaneWeights(file);
    expect(Object.values(read.weights)).toEqual([null, null, null, null]);
    expect(read.problems[0]).toContain("is not YAML");
    expect(read.problems[0]).toContain(
      "every weighted lane is out of rotation",
    );
  });
});

describe("the priorities record", () => {
  test("a repository record validates with no site or individual record and no site fields", () => {
    expect(validatePrioritiesRecord(record())).toEqual([]);
    expect(referenceProblems([record()])).toEqual([]);
  });

  test("it rejects unknown fields, duplicate ids, empty selectors, negative values and shares above one", () => {
    const bad = {
      level: "repository",
      scope: "acme/widgets",
      revision: -1,
      capacityLimit: 3,
      objectives: [
        {
          id: "a",
          class: "core",
          purpose: "p",
          endState: "e",
          owner: "o",
          epics: [{ scope: "acme/widgets", keys: [] }],
          share: -0.1,
        },
        {
          id: "a",
          class: "core",
          purpose: "p",
          endState: "e",
          owner: "o",
          refs: [{ level: "site", scope: "hub", id: "x" }],
          share: 1.5,
          peripheralFloor: 1,
        },
      ],
    };
    const problems = validatePrioritiesRecord(bad).join("\n");
    for (const expected of [
      "unknown field `capacityLimit`",
      "unknown field `peripheralFloor`",
      'objectives[1].id "a" is a duplicate',
      "keys is empty",
      "selects nothing",
      "objectives[0].share is negative",
      "objectives[1].share is above one",
      "revision must be a whole number",
    ])
      expect(problems).toContain(expected);
  });

  test("a lane's shares may not total above one at a level", () => {
    const rec = record();
    const [a, b] = rec.objectives;
    const objectives = [
      { ...a, share: 0.6 },
      { ...b, id: "b", class: "core", share: 0.5 },
    ];
    expect(validatePrioritiesRecord({ ...rec, objectives })).toContain(
      "the core objectives' shares total 1.1, above one",
    );
  });

  test("an objective needs exactly one of epics and refs", () => {
    const rec = record();
    const [a] = rec.objectives;
    const both = {
      ...a,
      refs: [{ level: "site", scope: "hub", id: "x" }],
    };
    expect(
      validatePrioritiesRecord({ ...rec, objectives: [both] }).join(),
    ).toContain("exactly one of epics and refs");
  });

  test("a reference that names no objective read is incomplete input", () => {
    const individual = {
      level: "individual" as const,
      scope: "host",
      revision: 1,
      objectives: [
        {
          id: "mine",
          class: "core" as const,
          purpose: "p",
          endState: "e",
          owner: "alex",
          refs: [
            { level: "repository" as const, scope: "acme/widgets", id: "nope" },
          ],
        },
      ],
    };
    expect(referenceProblems([record(), individual])[0]).toContain(
      "references repository:acme/widgets:nope, which no record read holds",
    );
  });

  test("text that is not YAML is unreadable", () => {
    const parsed = parsePrioritiesRecord("level: [", "p.yaml");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure.code).toBe("unreadable");
  });
});
