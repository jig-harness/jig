/**
 * The icon vocabulary against the sets the records name. Each set is read
 * from where it is declared, not restated here: a list the code holds at run
 * time is imported, and a set declared only as a type is read from its
 * declaration's source text. So a word added to a recorded set with no icon
 * or word in the map fails here, and so does an entry left behind for a word
 * no set records any longer.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEED_ACTS } from "../../plugin/shared/acts.ts";
import { LANES as LANE_ORDER } from "../../plugin/skills/drive-pr/scripts/lib/merge-ready.ts";
import {
  ACCOUNT_ICONS,
  ACT_ICONS,
  CAUSE_ICONS,
  CONTROL_ICONS,
  EVERYONE_ICONS,
  FORGE_ICONS,
  GAUGE_ICONS,
  GROUP_ICONS,
  ICON_SETS,
  type IconWord,
  iconOf,
  LANE_ICONS,
  SOURCE_ICONS,
  STAGE_ICONS,
} from "./icons.ts";

const ROOT = join(import.meta.dir, "../..");

/** The files that declare the recorded sets declared only as types. */
const DECLARED_IN = [
  "plugin/dispatch/lib/dashboard-contract.ts",
  "plugin/dispatch/lib/types.ts",
  "plugin/dispatch/lib/launches.ts",
  "plugin/shared/decision-card.ts",
  "dashboard/src/view.ts",
].map((file) => readFileSync(join(ROOT, file), "utf8"));

/** The text of `type <name> = …;` in the files above. */
function declaration(name: string): string {
  for (const source of DECLARED_IN) {
    const at = source.search(new RegExp(`\\btype ${name} =`));
    if (at === -1) continue;
    const start = source.indexOf("=", at) + 1;
    return source.slice(start, source.indexOf(";", start));
  }
  throw new Error(`no declaration of type ${name}`);
}

/**
 * The string members of a union type: its literals, the members of each type
 * it names, and `Exclude<A, B>` as A's members less B's. Nothing else appears
 * in the declarations it reads; anything else fails, so a declaration in a
 * form it cannot read never passes as an empty set.
 */
function unionMembers(name: string): Set<string> {
  const tokens = declaration(name).match(/"[^"]*"|[A-Za-z_]\w*|[<>,|]/g) ?? [];
  let at = 0;
  const union = (): Set<string> => {
    const members = new Set<string>();
    if (tokens[at] === "|") at++;
    for (const m of term()) members.add(m);
    while (tokens[at] === "|") {
      at++;
      for (const m of term()) members.add(m);
    }
    return members;
  };
  const term = (): Set<string> => {
    const token = tokens[at++] ?? "";
    if (token.startsWith('"')) return new Set([token.slice(1, -1)]);
    if (token === "Exclude" && tokens[at] === "<") {
      at++;
      const from = union();
      if (tokens[at++] !== ",") throw new Error(`cannot read type ${name}`);
      const less = union();
      if (tokens[at++] !== ">") throw new Error(`cannot read type ${name}`);
      return new Set([...from].filter((m) => !less.has(m)));
    }
    if (/^[A-Z]\w*$/.test(token)) return unionMembers(token);
    throw new Error(`cannot read type ${name} at ${token}`);
  };
  const members = union();
  if (at !== tokens.length || members.size === 0)
    throw new Error(`cannot read type ${name}`);
  return members;
}

/** Every recorded set, as its own code holds it, beside the map's entries for it and the words the map adds of its own. */
const RECORDED: Array<{
  set: string;
  words: Iterable<string>;
  map: Readonly<Record<string, IconWord>>;
  added?: string[];
}> = [
  { set: "act", words: NEED_ACTS, map: ACT_ICONS },
  {
    set: "stage",
    words: [...unionMembers("Stage"), ...unionMembers("LaunchAction")],
    map: STAGE_ICONS,
  },
  {
    set: "queue source",
    words: unionMembers("QueueSource"),
    map: SOURCE_ICONS,
  },
  { set: "queue group", words: unionMembers("QueueGroup"), map: GROUP_ICONS },
  { set: "merge lane", words: LANE_ORDER, map: LANE_ICONS },
  {
    set: "load gauge",
    words: unionMembers("LoadGauge"),
    map: GAUGE_ICONS,
    added: ["over"],
  },
  {
    set: "account state",
    words: unionMembers("AccountState"),
    map: ACCOUNT_ICONS,
  },
  { set: "need cause", words: unionMembers("NeedCause"), map: CAUSE_ICONS },
  {
    set: "answer state",
    words: unionMembers("AnswerState"),
    map: EVERYONE_ICONS,
    added: ["waiting"],
  },
];

describe("reading a recorded set from its declaration", () => {
  it("reads literals, named types and Exclude", () => {
    expect([...unionMembers("FailureCause")].sort()).toEqual([
      "action-failing",
      "host-failing",
      "repository-failing",
      "ticks-failing",
    ]);
    const causes = unionMembers("NeedCause");
    expect(causes.has("assigner-cannot-write")).toBe(true);
    expect(causes.has("parked")).toBe(true);
    // Exclude takes these out of the notify causes it starts from.
    for (const left of ["waiting", "drifting", "ready", "ticks-failing"])
      expect(causes.has(left)).toBe(false);
  });

  it("fails a type it cannot find", () => {
    expect(() => unionMembers("NoSuchType")).toThrow("no declaration");
  });
});

describe("the icon vocabulary", () => {
  for (const { set, words, map, added = [] } of RECORDED) {
    it(`gives every ${set} an icon or a word`, () => {
      const recorded = [...words];
      const missing = recorded.filter(
        (w) => !Object.hasOwn(map, w) || (map[w]?.word ?? "") === "",
      );
      expect({ set, missing }).toEqual({ set, missing: [] });
    });

    it(`holds no ${set} the records no longer name`, () => {
      const recorded = new Set([...words, ...added]);
      const stray = Object.keys(map).filter((w) => !recorded.has(w));
      expect({ set, stray }).toEqual({ set, stray: [] });
    });
  }

  it("gives every entry a word, and an icon unless the design keeps it a word", () => {
    const wordOnly = ICON_SETS.flatMap((s) =>
      Object.entries(s.members)
        .filter(([, e]) => e.icon === null)
        .map(([key]) => `${s.title}: ${key}`),
    );
    expect(wordOnly).toEqual([
      "What a card is about: pull request",
      "Answers, for everyone: waiting",
      "Answers, in this browser: draft",
    ]);
    for (const s of ICON_SETS)
      for (const e of Object.values(s.members))
        expect(e.word.trim()).not.toBe("");
  });

  it("lists every set the page draws in the Help view's sets", () => {
    for (const { map } of RECORDED)
      expect(ICON_SETS.some((s) => s.members === map)).toBe(true);
    expect(ICON_SETS.some((s) => s.members === FORGE_ICONS)).toBe(true);
    expect(ICON_SETS.some((s) => s.members === CONTROL_ICONS)).toBe(true);
  });

  it("shares an icon where two sets share a word and its meaning", () => {
    expect(SOURCE_ICONS["re-armable"].icon).toBe(STAGE_ICONS.rearm.icon);
    expect(SOURCE_ICONS.held.icon).toBe(GROUP_ICONS.held.icon);
    expect(SOURCE_ICONS.merged.icon).toBe(FORGE_ICONS.merged.icon);
    // The act Merge asks a person to merge; it is not the merged standing.
    expect(ACT_ICONS.Merge.icon).not.toBe(FORGE_ICONS.merged.icon);
  });

  it("tells one member of a set from the next by its icon", () => {
    for (const s of ICON_SETS) {
      const drawn = Object.entries(s.members).filter(
        ([key, e]) => e.icon !== null && key !== "not read",
      );
      const icons = new Set(drawn.map(([, e]) => e.icon));
      expect({ set: s.title, distinct: icons.size }).toEqual({
        set: s.title,
        distinct: drawn.length,
      });
    }
  });

  it("draws a word the set does not hold as the word alone", () => {
    expect(iconOf(STAGE_ICONS, "hold")).toEqual({ icon: null, word: "hold" });
    expect(iconOf(STAGE_ICONS, "constructor")).toEqual({
      icon: null,
      word: "constructor",
    });
    expect(iconOf(STAGE_ICONS, "rearm")).toBe(STAGE_ICONS.rearm);
  });
});
