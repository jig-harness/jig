/**
 * Picking on a card as pure functions: rows numbered with the recommendation
 * first, each row's answer (the pick or the person's own words, whichever was
 * made last), a decision framed or parked again dropping what was kept for
 * it, the decision the keys act on, and the one comment Copy takes.
 */
import { describe, expect, it } from "bun:test";
import type { LineDecision } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { ParkedDecision } from "../../plugin/shared/decisions/park.ts";
import {
  boundToPark,
  cardCommit,
  currentIndex,
  decisionRows,
  type KeptAnswer,
  keptAnswerOf,
  lastPicked,
  nextOpen,
  rowAnswer,
  withoutPick,
  withPick,
  withText,
} from "./picking.ts";

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);

function typed(
  cls: string,
  options: { id: string; name: string; reversible?: boolean }[],
  recommended: string,
  interplay?: ParkedDecision["interplay"],
): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: cls,
    call: {
      id: "a",
      question: "Which way?",
      recommended,
      why: "it is the smaller change",
      options: options.map((o) => ({
        ...o,
        summary: `${o.name} changes this`,
        pay: [`${o.name} costs that`],
      })),
    },
    steps: [],
    alreadyDone: "The rest is done.",
    ...(interplay === undefined ? {} : { interplay }),
  };
}

function decision(
  key: string,
  d: ParkedDecision,
  digest = "3fa9c2d1e0b4",
  parkedAt = "2026-11-03T07:05:00.000Z",
): LineDecision {
  return {
    key,
    kind: "thread",
    digest,
    parkedAt,
    decision: d,
    lines: [],
    question: d.call.question,
    recommendation: null,
    decisionClass: d.class,
    options: d.call.options.map((o) => ({
      name: o.name,
      changes: o.summary,
      costs: o.pay.join("\n"),
      recommended: o.id === d.call.recommended,
    })),
    steps: [],
  };
}

const KEEP = typed(
  "scope",
  [
    { id: "r", name: "Remove" },
    { id: "k", name: "Keep" },
  ],
  "k",
);
const DROP = typed(
  "destructive",
  [
    { id: "n", name: "Do not drop" },
    { id: "d", name: "Drop", reversible: false },
  ],
  "n",
  [{ from: "PRRT_b", to: "PRRT_a", text: "dropping first makes keeping moot" }],
);

describe("the rows", () => {
  it("numbers each decision's options with the recommendation as 1, and marks the guarded ones", () => {
    const [keep, drop] = decisionRows([
      decision("PRRT_a", KEEP),
      decision("PRRT_b", DROP, "0123456789ab"),
    ]);
    expect(keep?.options.map((o) => [o.number, o.name, o.guarded])).toEqual([
      [1, "Keep", false],
      [2, "Remove", false],
    ]);
    expect(drop?.options.map((o) => [o.number, o.name, o.guarded])).toEqual([
      [1, "Do not drop", true],
      [2, "Drop", true],
    ]);
    expect(drop?.act).toBe("Authorize");
    expect(drop?.options[1]?.reversible).toBe(false);
  });

  it("shows interplay beside both decisions it names", () => {
    const [keep, drop] = decisionRows([
      decision("PRRT_a", KEEP),
      decision("PRRT_b", DROP),
    ]);
    expect(keep?.interplay).toEqual([
      "PRRT_b → PRRT_a: dropping first makes keeping moot",
    ]);
    expect(drop?.interplay).toEqual(keep?.interplay ?? []);
  });

  it("guards an option the line marks as not reversible when the decision itself is not carried", () => {
    const d = decision("PRRT_a", KEEP);
    const { decision: _typed, ...line } = d;
    const [row] = decisionRows([
      {
        ...line,
        options: (d.options ?? []).map((o) =>
          o.name === "Remove"
            ? { ...o, details: [{ label: "Reversible", text: "No" }] }
            : o,
        ),
      },
    ]);
    expect(row?.options.find((o) => o.name === "Remove")?.guarded).toBe(true);
    expect(row?.options.find((o) => o.name === "Keep")?.guarded).toBe(false);
  });

  it("keeps one row per key", () => {
    expect(
      decisionRows([decision("PRRT_a", KEEP), decision("PRRT_a", KEEP)]),
    ).toHaveLength(1);
  });
});

describe("a row's answer", () => {
  const [row] = decisionRows([decision("PRRT_a", KEEP)]);
  if (row === undefined) throw new Error("no row");
  const keep = row.options[0];
  const remove = row.options[1];
  if (keep === undefined || remove === undefined) throw new Error("no options");

  it("counts the pick or the own words, whichever was made last", () => {
    const picked = withPick(row, null, remove, T0);
    expect(rowAnswer(row, picked).active).toBe("pick");
    const worded = withText(row, picked, "free", "neither, ask", T0 + 1);
    const read = rowAnswer(row, worded);
    expect(read.active).toBe("free");
    expect(read.pick?.name).toBe("Remove");
    const again = withPick(row, worded, keep, T0 + 2);
    expect(rowAnswer(row, again).active).toBe("pick");
    expect(rowAnswer(row, again).free).toBe("neither, ask");
  });

  it("keeps a note apart from the own words, so clearing a pick leaves the note a draft", () => {
    const noted = withText(
      row,
      withPick(row, null, remove, T0),
      "note",
      "after the migration",
      T0 + 1,
    );
    const cleared = withoutPick(row, noted, T0 + 2);
    const read = rowAnswer(row, cleared);
    expect(read.active).toBeNull();
    expect(read.note).toBe("after the migration");
    expect(read.free).toBe("");
  });

  it("forgets a row whose last answer is cleared", () => {
    expect(withoutPick(row, withPick(row, null, keep, T0), T0 + 1)).toBeNull();
    expect(withText(row, null, "free", "  ", T0)).toBeNull();
  });

  it("drops a pick made for another framing, and says so", () => {
    const old = withText(
      row,
      withPick(row, null, keep, T0),
      "note",
      "for one release",
      T0,
    );
    const reframed = {
      ...row,
      framing: { ...row.framing, digest: "ffffffffffff" },
    };
    const read = rowAnswer(reframed, old);
    expect(read.pick).toBeNull();
    expect(read.active).toBeNull();
    expect(read.dropped).toContain(
      "your pick of Keep and your note were dropped",
    );
    // Picking again builds on nothing from the earlier framing.
    const fresh = withPick(reframed, old, remove, T0 + 1);
    expect(fresh.note).toBeUndefined();
    expect(fresh.framing.digest).toBe("ffffffffffff");
  });

  it("drops a pick when the same wording is parked again", () => {
    const old = withPick(row, null, keep, T0);
    const reparked = {
      ...row,
      framing: { ...row.framing, parkedAt: "2026-11-03T09:00:00.000Z" },
    };
    expect(rowAnswer(reparked, old).dropped).toContain("your pick of Keep");
  });

  it("holds back an answer that cannot be sent, and says why", () => {
    const long = withText(
      row,
      withPick(row, null, keep, T0),
      "note",
      "x".repeat(501),
      T0,
    );
    expect(rowAnswer(row, long).fault).toContain("the note:");
    const broken = withText(row, null, "free", "two <!-- lines", T0);
    expect(rowAnswer(row, broken).fault).toContain("hidden marker");
  });

  it("reads back only what this page wrote", () => {
    const kept: KeptAnswer = withPick(row, null, keep, T0);
    expect(keptAnswerOf(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
    expect(keptAnswerOf({ text: "a reply draft", at: T0 })).toBeNull();
    expect(keptAnswerOf("nonsense")).toBeNull();
  });
});

describe("which decision the keys act on", () => {
  const rows = decisionRows([
    decision("PRRT_a", KEEP, "aaaaaaaaaaaa"),
    decision("PRRT_b", DROP, "bbbbbbbbbbbb"),
    decision("PRRT_c", KEEP, "cccccccccccc"),
  ]);
  const none = rows.map((r) => rowAnswer(r, null));
  const firstPicked = rows.map((r, i) =>
    rowAnswer(
      r,
      i === 0 && r.options[0] !== undefined
        ? withPick(r, null, r.options[0], T0)
        : null,
    ),
  );

  it("is the held one, by key and digest, wherever it now stands", () => {
    expect(
      currentIndex(rows, none, { key: "PRRT_c", digest: "cccccccccccc" }),
    ).toBe(2);
    expect(
      currentIndex([...rows].reverse(), none, {
        key: "PRRT_c",
        digest: "cccccccccccc",
      }),
    ).toBe(0);
  });

  it("is the first with no pick once the held one is gone or framed again", () => {
    expect(currentIndex(rows, firstPicked, null)).toBe(1);
    expect(
      currentIndex(rows, firstPicked, { key: "PRRT_x", digest: null }),
    ).toBe(1);
    expect(
      currentIndex(rows, firstPicked, {
        key: "PRRT_a",
        digest: "000000000000",
      }),
    ).toBe(1);
  });

  it("moves on to the next decision with no pick, round the card", () => {
    expect(nextOpen(firstPicked, 0)).toBe(1);
    expect(nextOpen(firstPicked, 2)).toBe(1);
    expect(nextOpen(firstPicked.slice(0, 1), 0)).toBe(0);
  });

  it("names the decision picked last, for undo", () => {
    expect(lastPicked(none)).toBeNull();
    const [a, b] = rows;
    if (a?.options[0] === undefined || b?.options[1] === undefined)
      throw new Error("no options");
    const answers = [
      rowAnswer(a, withPick(a, null, a.options[0], T0 + 5)),
      rowAnswer(b, withPick(b, null, b.options[1], T0)),
    ];
    expect(lastPicked(answers)).toBe(0);
  });
});

describe("what Copy takes", () => {
  it("copies the recommended option with the digest from a card of one decision with nothing picked", () => {
    const rows = decisionRows([decision("PRRT_a", KEEP)]);
    const commit = cardCommit(
      rows,
      rows.map((r) => rowAnswer(r, null)),
    );
    expect(commit.label).toBe("approval");
    expect(commit.text).toBe("answer PRRT_a: approve [3fa9c2d1e0b4]");
  });

  it("copies the starting line where an approval with nothing picked would be guarded or ambiguous", () => {
    const guarded = decisionRows([decision("PRRT_b", DROP)]);
    expect(
      cardCommit(
        guarded,
        guarded.map((r) => rowAnswer(r, null)),
      ).text,
    ).toBe("answer PRRT_b: ");
    const two = decisionRows([
      decision("PRRT_a", KEEP),
      decision("PRRT_c", KEEP),
    ]);
    expect(
      cardCommit(
        two,
        two.map((r) => rowAnswer(r, null)),
      ),
    ).toMatchObject({
      label: "answer line",
      text: "answer PRRT_a: \n\nanswer PRRT_c: ",
    });
  });

  it("copies one comment that answers both decisions of a card, and leaves out one with no answer", () => {
    const rows = decisionRows([
      decision("PRRT_a", KEEP, "aaaaaaaaaaaa"),
      decision("PRRT_b", DROP, "bbbbbbbbbbbb"),
      decision("PRRT_c", KEEP, "cccccccccccc"),
    ]);
    const [a, b] = rows;
    if (a?.options[1] === undefined || b?.options[0] === undefined)
      throw new Error("no options");
    const kept = [
      withText(
        a,
        withPick(a, null, a.options[1], T0),
        "note",
        "this release only",
        T0,
      ),
      withPick(b, null, b.options[0], T0),
      null,
    ];
    const commit = cardCommit(
      rows,
      rows.map((r, i) => rowAnswer(r, kept[i] ?? null)),
    );
    expect(commit.text).toBe(
      "answer PRRT_a: choose Remove [aaaaaaaaaaaa]\nnote PRRT_a: this release only\n\nanswer PRRT_b: approve [bbbbbbbbbbbb]",
    );
    expect(commit.guarded.map((g) => [g.key, g.option.name])).toEqual([
      ["PRRT_b", "Do not drop"],
    ]);
    expect(commit.picked).toBe(2);
  });

  it("writes own words with the digest, and leaves a pick that is only a draft out", () => {
    const rows = decisionRows([decision("PRRT_b", DROP)]);
    const [b] = rows;
    if (b?.options[1] === undefined) throw new Error("no options");
    const kept = withText(
      b,
      withPick(b, null, b.options[1], T0),
      "free",
      "not before the backup",
      T0 + 1,
    );
    const commit = cardCommit(rows, [rowAnswer(b, kept)]);
    expect(commit.text).toBe(
      "answer PRRT_b: not before the backup [3fa9c2d1e0b4]",
    );
    expect(commit.guarded).toEqual([]);
    expect(commit.free).toBe(1);
  });
});

describe("what a review of the card found", () => {
  const [drop] = decisionRows([decision("PRRT_b", DROP)]);
  const [keep] = decisionRows([decision("PRRT_a", KEEP)]);
  if (drop === undefined || keep === undefined) throw new Error("no rows");
  const [keepIt, removeIt] = keep.options;
  if (keepIt === undefined || removeIt === undefined)
    throw new Error("no options");

  it("holds back own words the readers would count as approving, and says to pick instead", () => {
    const read = rowAnswer(drop, withText(drop, null, "free", "Approve.", T0));
    expect(read.active).toBe("free");
    expect(read.fault).toBe(
      "your own words read as approving Do not drop; pick that option on the row instead",
    );
    expect(cardCommit([drop], [read]).faults).toHaveLength(1);
  });

  it("holds back own words the readers would count as choosing an option, in any spelling they fold", () => {
    const read = rowAnswer(
      drop,
      withText(drop, null, "free", "choose **DROP**", T0),
    );
    expect(read.fault).toContain("read as choosing Drop");
    // Words that name no option stay free, and count.
    expect(
      rowAnswer(drop, withText(drop, null, "free", "choose whichever", T0))
        .fault,
    ).toBeNull();
  });

  it("never copies an approval for a decision whose pick was dropped by a new framing", () => {
    const old = withPick(keep, null, removeIt, T0);
    const reframed = {
      ...keep,
      digest: "ffffffffffff",
      framing: { ...keep.framing, digest: "ffffffffffff" },
    };
    const commit = cardCommit([reframed], [rowAnswer(reframed, old)]);
    expect(commit.label).toBe("answer line");
    expect(commit.text).toBe("answer PRRT_a: ");
  });

  it("drops the note when another option is picked, and keeps it when the same one is", () => {
    const [k, r] = keep.options;
    if (k === undefined || r === undefined) throw new Error("no options");
    const noted = withText(
      keep,
      withPick(keep, null, k, T0),
      "note",
      "for one release",
      T0,
    );
    expect(withPick(keep, noted, k, T0 + 1).note?.text).toBe("for one release");
    expect(withPick(keep, noted, r, T0 + 1).note).toBeUndefined();
    expect(rowAnswer(keep, withPick(keep, noted, r, T0 + 1)).note).toBe("");
  });

  it("keeps a pick made on a line that kept no park time", () => {
    const older = { ...keep, framing: { ...keep.framing, parkedAt: null } };
    const kept = withPick(older, null, keepIt, T0);
    const read = rowAnswer(keep, kept);
    expect(read.dropped).toBeNull();
    expect(read.pick?.name).toBe("Keep");
    // The next change records the park time the line now carries.
    expect(withText(keep, kept, "note", "x", T0 + 1)?.framing).toEqual(
      keep.framing,
    );
  });

  it("holds back own words that name another framing's digest", () => {
    const read = rowAnswer(
      keep,
      withText(keep, null, "free", "Use the plan [aaaaaaaaaaaa]", T0),
    );
    expect(read.fault).toContain("[aaaaaaaaaaaa]");
    // The row's own digest in the words is no other framing.
    expect(
      rowAnswer(
        keep,
        withText(keep, null, "free", "Use the plan [3fa9c2d1e0b4]", T0),
      ).fault,
    ).toBeNull();
  });

  it("binds a pick made before park times to the first park time seen, so a later park drops it", () => {
    const older = { ...keep, framing: { ...keep.framing, parkedAt: null } };
    const kept = withPick(older, null, keepIt, T0);
    const bound = boundToPark(keep, kept);
    expect(bound?.framing).toEqual(keep.framing);
    const [again] = decisionRows([
      decision("PRRT_a", KEEP, "3fa9c2d1e0b4", "2026-11-04T07:05:00.000Z"),
    ]);
    if (again === undefined) throw new Error("no row");
    expect(rowAnswer(again, bound).pick).toBeNull();
    expect(rowAnswer(again, bound).dropped).not.toBeNull();
    // Nothing to bind once the park time is known, or while the row knows none.
    expect(boundToPark(keep, bound)).toBeNull();
    expect(boundToPark(older, kept)).toBeNull();
  });

  it("takes only own words for a record the readers resolve no choice for", () => {
    const base = decision("PRRT_a", KEEP);
    const { decision: _typed, ...legacy } = base;
    const [row] = decisionRows([
      {
        ...legacy,
        options: (base.options ?? []).map((o) => ({
          ...o,
          recommended: false,
        })),
      },
    ]);
    if (row === undefined) throw new Error("no row");
    expect(row.structured).toBe(false);
    const [first] = row.options;
    if (first === undefined) throw new Error("no option");
    expect(rowAnswer(row, withPick(row, null, first, T0)).pick).toBeNull();
    // The readers take its words as free text, so naming an option is not a choice to hold back.
    expect(
      rowAnswer(row, withText(row, null, "free", `choose ${first.name}`, T0))
        .fault,
    ).toBeNull();
    expect(keep.structured).toBe(true);
  });
});
