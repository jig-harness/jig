import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFactory } from "./factory.ts";
import { parseSkills } from "./skills.ts";
import { parseWalkthrough } from "./walkthrough.ts";

const root = join(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const stations = parseFactory(read("FACTORY.md")).line.map((s) => s.name);
const skills = new Set(
  parseSkills(read("plugin/README.md"))
    .filter((s) => !s.agent)
    .map((s) => s.name),
);
const yaml = read("website/src/data/walkthrough.yaml");
const run = parseWalkthrough(yaml, stations, skills);

describe("the recorded run", () => {
  test("carries its date and its pull request of Jig's own", () => {
    expect(run.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run.pr.url).toBe(
      `https://github.com/jig-harness/jig/pull/${run.pr.number}`,
    );
    expect(run.pr.change.length).toBeGreaterThan(20);
  });

  test("names, at every event, a station of FACTORY.md's line", () => {
    expect(stations.length).toBeGreaterThan(0);
    for (const e of run.events) expect(stations, e.what).toContain(e.station);
  });

  test("runs from the pull request opening to a person's merge and the follow-up after it", () => {
    const at = (station: string) =>
      run.events.findIndex((e) => e.station === station);
    expect(at("Open")).toBe(0);
    const merge = run.events.findIndex(
      (e) => e.station === "Merge" && e.by.kind === "person",
    );
    expect(at("Drive")).toBeGreaterThanOrEqual(0);
    expect(merge).toBeGreaterThan(at("Drive"));
    expect(run.events.slice(merge).some((e) => e.station === "Follow up")).toBe(
      true,
    );
    expect(run.events.some((e) => e.by.kind === "dispatcher")).toBe(true);
  });
});

describe("parseWalkthrough refuses", () => {
  const event = (fields: string) =>
    `date: "2026-11-02"\npr:\n  number: 409\n  url: https://github.com/jig-harness/jig/pull/409\n  change: A change of some length to the plugin.\nevents:\n  - at: "2026-11-02T14:27Z"\n    by: agent\n    what: An agent opens it.\n    record: the timeline\n${fields}`;

  test("nothing in a well-formed run", () => {
    expect(() =>
      parseWalkthrough(event("    station: Open\n"), stations, skills),
    ).not.toThrow();
  });

  test("a station the factory does not have", () => {
    expect(() =>
      parseWalkthrough(event("    station: Deploy\n"), stations, skills),
    ).toThrow(/not a station of the line/);
  });

  test("an actor the page cannot draw", () => {
    const text = event("    station: Open\n").replace("by: agent", "by: a-bot");
    expect(() => parseWalkthrough(text, stations, skills)).toThrow(
      /plugin skill/,
    );
  });

  test("a run without its pull request or its date", () => {
    const text = event("    station: Open\n");
    expect(() =>
      parseWalkthrough(text.replace("pull/409", "pull/410"), stations, skills),
    ).toThrow(/pr\.url/);
    expect(() =>
      parseWalkthrough(
        text.replace('date: "2026-11-02"\n', ""),
        stations,
        skills,
      ),
    ).toThrow(/date/);
  });

  test("impossible calendar dates and clock times", () => {
    const text = event("    station: Open\n");
    for (const date of ["2026-99-99", "2026-02-29", "2026-04-31"])
      expect(() =>
        parseWalkthrough(text.replaceAll("2026-11-02", date), stations, skills),
      ).toThrow(/date/);
    for (const at of [
      "2026-02-30T14:27Z",
      "2026-11-02T24:00Z",
      "2026-11-02T14:60Z",
    ])
      expect(() =>
        parseWalkthrough(
          text.replace("2026-11-02T14:27Z", at),
          stations,
          skills,
        ),
      ).toThrow(/UTC time/);
    expect(() =>
      parseWalkthrough(
        `${text}    until: "2026-11-02T99:99Z"\n`,
        stations,
        skills,
      ),
    ).toThrow(/UTC time/);
  });

  test("a named plugin agent presented as a skill", () => {
    const text = event("    station: Open\n").replace(
      "by: agent",
      "by: review-arbiter",
    );
    expect(() => parseWalkthrough(text, stations, skills)).toThrow(
      /plugin skill/,
    );
  });

  test("events out of time order", () => {
    const text = `${event("    station: Open\n")}  - at: "2026-11-02T14:00Z"\n    station: Drive\n    by: drive-pr\n    what: Earlier.\n    record: the ledger\n`;
    expect(() => parseWalkthrough(text, stations, skills)).toThrow(
      /time order/,
    );
  });
});
