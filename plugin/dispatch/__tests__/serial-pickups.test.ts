/**
 * Serialized areas hold pickups: which planned pickup is held, behind which
 * piece of work and in which area, with unknown footprints read
 * conservatively on both sides (serial-pickups.ts, reachesArea in overlap.ts).
 */
import { describe, expect, it } from "bun:test";
import {
  type Footprint,
  type InFlight,
  reachesArea,
  UNKNOWN_FOOTPRINT,
} from "../lib/overlap.ts";
import {
  type SerialCandidate,
  serialPickupHolds,
} from "../lib/serial-pickups.ts";

const GLOBS: Record<string, string[]> = {
  migrations: ["db/migrations/**"],
  schema: ["db/schema.sql"],
  docs: ["docs/**"],
  db: ["db/**"],
  deps: ["package.json", "bun.lock"],
};
const globs = (area: string) => GLOBS[area] ?? [];
const model = { areaGlobs: globs };

const known = (
  files: string[],
  dirs: string[] = [],
  areas: string[] = [],
): Footprint => ({ known: true, files, dirs, areas });

const pr = (n: number, footprint: Footprint): InFlight => ({
  kind: "pull request",
  ref: `#${n}`,
  url: null,
  state: "open",
  footprint,
  quiet: false,
});

const pickup = (key: string, footprint: Footprint): InFlight => ({
  kind: "pickup",
  ref: key,
  url: null,
  state: "running",
  footprint,
  quiet: false,
});

const candidate = (target: string, footprint: Footprint): SerialCandidate => ({
  target,
  keys: [target],
  footprint,
});

const SERIALIZED = ["migrations", "schema"];

function holds(
  candidates: SerialCandidate[],
  inFlight: InFlight[],
  own?: (keys: readonly string[]) => ReadonlySet<string>,
) {
  return serialPickupHolds({
    areas: SERIALIZED,
    globs,
    candidates,
    inFlight,
    ...(own === undefined ? {} : { own }),
  });
}

describe("reachesArea", () => {
  it("reads a file in the area, a directory holding or held by its globs, and an area whose globs meet it", () => {
    expect(
      reachesArea(known(["db/migrations/001.sql"]), "migrations", model),
    ).toBe(true);
    expect(reachesArea(known(["db/seed.sql"]), "migrations", model)).toBe(
      false,
    );
    // A directory above the area holds it; one inside it is held by it.
    expect(reachesArea(known([], ["db/"]), "migrations", model)).toBe(true);
    expect(
      reachesArea(known([], ["db/migrations/2026/"]), "migrations", model),
    ).toBe(true);
    expect(reachesArea(known([], ["docs/"]), "migrations", model)).toBe(false);
    // A directory written among the files counts as one.
    expect(reachesArea(known(["db/"]), "schema", model)).toBe(true);
    // The area itself, and another area whose globs meet it.
    expect(
      reachesArea(known([], [], ["migrations"]), "migrations", model),
    ).toBe(true);
    expect(reachesArea(known([], [], ["db"]), "migrations", model)).toBe(true);
    expect(reachesArea(known([], [], ["docs"]), "migrations", model)).toBe(
      false,
    );
    // An area of root files is reached only by an area whose globs match one of them.
    expect(reachesArea(known([], [], ["docs"]), "deps", model)).toBe(false);
    expect(reachesArea(known([], [], ["deps"]), "deps", model)).toBe(true);
    expect(reachesArea(known(["bun.lock"]), "deps", model)).toBe(true);
    // An unknown footprint reaches nothing: it cannot exclude, which the hold reads separately.
    expect(reachesArea(UNKNOWN_FOOTPRINT, "migrations", model)).toBe(false);
  });
});

describe("serialPickupHolds", () => {
  it("holds a pickup that reaches an area an open pull request touches, and names the area and the pull request", () => {
    const held = holds(
      [
        candidate("#12", known(["db/migrations/002.sql"])),
        candidate("#13", known(["docs/guide.md"])),
      ],
      [pr(20, known(["db/migrations/001.sql", "src/app.ts"]))],
    );
    expect([...held]).toEqual([
      [
        "#12",
        {
          area: "migrations",
          behind: "#20",
          unknown: null,
          reason: "held: serialized behind #20 in migrations",
        },
      ],
    ]);
  });

  it("holds nothing where the work in flight touches no serialized area, or touches only another one", () => {
    const held = holds(
      [candidate("#12", known(["db/migrations/002.sql"]))],
      [
        pr(20, known(["docs/guide.md"])),
        pickup("#30", known(["db/schema.sql"])),
      ],
    );
    expect(held.size).toBe(0);
  });

  it("holds a pickup behind a running pickup whose footprint reaches the area, by its coarse match", () => {
    const held = holds(
      [candidate("#12", known([], [], ["migrations"]))],
      [pickup("#30", known([], ["db/"]))],
    );
    expect(held.get("#12")?.reason).toBe(
      "held: serialized behind #30 in migrations",
    );
  });

  it("holds an unknown candidate while any serialized area is occupied, and says its footprint is unknown", () => {
    const held = holds(
      [candidate("#14", UNKNOWN_FOOTPRINT)],
      [pr(20, known(["db/schema.sql"]))],
    );
    expect(held.get("#14")).toEqual({
      area: "schema",
      behind: "#20",
      unknown: "candidate",
      reason: "held: serialized behind #20 in schema, footprint unknown",
    });
    // With nothing in any serialized area, an unknown candidate is free.
    expect(
      holds(
        [candidate("#14", UNKNOWN_FOOTPRINT)],
        [pr(20, known(["docs/a.md"]))],
      ).size,
    ).toBe(0);
  });

  it("lets unknown work in flight occupy every serialized area, and names whose footprint is unknown", () => {
    const held = holds(
      [
        candidate("#12", known(["db/schema.sql"])),
        candidate("#13", known(["docs/guide.md"])),
      ],
      [pr(20, UNKNOWN_FOOTPRINT)],
    );
    expect(held.get("#12")?.reason).toBe(
      "held: serialized behind #20 in schema, #20's footprint unknown",
    );
    expect(held.get("#12")?.unknown).toBe("occupant");
    // A pickup that reaches no serialized area is not held by unknown work.
    expect(held.has("#13")).toBe(false);
  });

  it("holds an unknown candidate behind unknown work in flight: neither can exclude the area", () => {
    const held = holds(
      [candidate("#14", UNKNOWN_FOOTPRINT)],
      [pickup("#30", UNKNOWN_FOOTPRINT)],
    );
    expect(held.get("#14")).toMatchObject({
      area: "migrations",
      behind: "#30",
      unknown: "candidate",
    });
  });

  it("prefers work whose footprint reaches the area over work whose footprint is unknown", () => {
    const held = holds(
      [candidate("#12", known(["db/schema.sql"]))],
      [pr(20, UNKNOWN_FOOTPRINT), pr(21, known(["db/schema.sql"]))],
    );
    expect(held.get("#12")?.reason).toBe(
      "held: serialized behind #21 in schema",
    );
  });

  it("reads a batch's partly unknown footprint as unable to exclude an area, on either side", () => {
    const partly = { ...known(["docs/a.md"]), incomplete: true as const };
    const asCandidate = holds(
      [candidate("#15", partly)],
      [pr(20, known(["db/migrations/001.sql"]))],
    );
    expect(asCandidate.get("#15")?.reason).toBe(
      "held: serialized behind #20 in migrations, footprint unknown",
    );
    const asWork = holds(
      [candidate("#12", known(["db/migrations/002.sql"]))],
      [pickup("#30", partly)],
    );
    expect(asWork.get("#12")?.reason).toBe(
      "held: serialized behind #30 in migrations, #30's footprint unknown",
    );
  });

  it("counts a pickup planned ahead and not held in flight for those after it, so two in one area never both start", () => {
    const held = holds(
      [
        candidate("#12", known(["db/migrations/002.sql"])),
        candidate("#13", known(["db/migrations/003.sql"])),
        candidate("#14", UNKNOWN_FOOTPRINT),
        candidate("#15", known(["docs/guide.md"])),
      ],
      [],
    );
    expect(held.has("#12")).toBe(false);
    expect(held.get("#13")?.reason).toBe(
      "held: serialized behind #12 in migrations",
    );
    expect(held.get("#14")?.reason).toBe(
      "held: serialized behind #12 in migrations, footprint unknown",
    );
    expect(held.has("#15")).toBe(false);
  });

  it("does not let a held pickup occupy the area for the pickups after it", () => {
    const held = holds(
      [
        candidate("#12", known(["db/migrations/002.sql"])),
        candidate("#13", known(["db/schema.sql"])),
      ],
      [pr(20, known(["db/migrations/001.sql"]))],
    );
    expect(held.get("#12")?.behind).toBe("#20");
    expect(held.has("#13")).toBe(false);
  });

  it("never holds a pickup behind a pull request of its own item", () => {
    const held = holds(
      [candidate("#12", known(["db/migrations/002.sql"]))],
      [pr(20, known(["db/migrations/002.sql"]))],
      (keys) => new Set(keys.includes("#12") ? ["#20"] : []),
    );
    expect(held.size).toBe(0);
  });
});
