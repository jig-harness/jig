import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachineConfig } from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
function read(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "jig-serve-"));
  dirs.push(dir);
  const file = join(dir, "dispatch.yaml");
  writeFileSync(file, JSON.stringify(value));
  return readMachineConfig(file);
}

describe("the host's served people", () => {
  it("reads tracker identities and forge logins, and defaults to no people", () => {
    const people = [
      {
        name: "maintainer",
        forge: ["person", "person-work"],
        tracker: { github: "person", linear: "person@example.com" },
      },
    ];
    const config = read({ serve: people });
    expect(config.ok && config.value?.serve).toEqual(people);
    const empty = read({});
    expect(empty.ok && empty.value?.serve).toEqual([]);
  });
  it("refuses unknown keys and ambiguous identities instead of widening the host's reach", () => {
    for (const serve of [
      [
        {
          name: "person",
          forge: [],
          tracker: { github: "person" },
          extra: true,
        },
      ],
      [{ name: "person", forge: ["person"], tracker: { unknown: "person" } }],
      [
        {
          name: "person",
          forge: ["person", "PERSON"],
          tracker: { github: "person" },
        },
      ],
      [{ name: "person", forge: ["person"], tracker: { github: "" } }],
      [
        { name: "a", forge: ["person"], tracker: { github: "a" } },
        { name: "b", forge: ["PERSON"], tracker: { github: "b" } },
      ],
      [
        { name: "a", forge: ["a"], tracker: { github: "person" } },
        { name: "b", forge: ["b"], tracker: { github: "PERSON" } },
      ],
    ])
      expect(read({ serve }).ok).toBe(false);
  });
});
