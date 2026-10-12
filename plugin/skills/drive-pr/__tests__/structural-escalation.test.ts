/**
 * structural-escalation.test.ts — an earlier change's `structuralEscalationDue`: the
 * durable per-round finding-path record, the recurrence predicate derived from
 * it, and the `drive-state.ts` commands that write and discharge it.
 *
 * Two layers, deliberately:
 *
 *   The PREDICATE (`structuralEscalationArmed`, `foldRoundPaths`,
 *   `normalizeRoundPaths`) is tested as a pure function over hand-built state,
 *   so the arming rule's edges — consecutive vs. merely repeated, discharge,
 *   re-arm — are asserted without a subprocess in the way.
 *
 *   The COMMANDS are tested through the real `drive-state.ts` CLI against a
 *   real state directory, because the thing that has to hold is that the
 *   command writes what the predicate reads. A predicate tested only against
 *   hand-built state is a predicate tested against a shape nothing produces.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ESCALATION_INVARIANT_MAX_LENGTH,
  foldRoundPaths,
  freshState,
  isUsableState,
  normalizeRoundPaths,
  normalizeRoundPathsUncapped,
  ROUND_PATH_MAX_LENGTH,
  ROUND_PATHS_MAX_PER_ROUND,
  ROUND_PATHS_WINDOW,
  structuralEscalationArmed,
  structuralEscalationInvariant,
} from "../scripts/lib/state/schema.ts";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

async function state(
  stateDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(
    [process.execPath, join(SCRIPTS, "drive-state.ts"), ...args],
    {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
}

function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "drive-pr-escalation-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("structuralEscalationArmed — the recurrence rule", () => {
  it("arms on the same file in two CONSECUTIVE rounds", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 1, paths: ["a.ts", "b.ts"] },
          { round: 2, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(true);
  });

  it("does NOT arm on disjoint files", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 1, paths: ["a.ts", "b.ts"] },
          { round: 2, paths: ["c.ts", "d.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(false);
  });

  // The whole reason the record is round-KEYED rather than a running set: a
  // file found in rounds 1 and 3 with a clean round 2 between them is not
  // evidence that a fix drew the next finding.
  it("does NOT arm on the same file in NON-consecutive rounds", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 1, paths: ["a.ts"] },
          { round: 2, paths: ["z.ts"] },
          { round: 3, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(false);
  });

  // The case above leaves the round-NUMBER comparison unexercised: rounds 1
  // and 3 are also non-adjacent in the array, so a predicate that compared
  // adjacent ENTRIES and ignored their round numbers still answers false.
  // Verified by mutation — deleting the `prev.round + 1` check kept the whole
  // suite green until this fixture existed.
  //
  // A GAP is reachable, which is why the check is load-bearing rather than
  // defensive: `record-paths` is best-effort (drive-status.ts records it
  // outside the round bump's hard-stop), so a failed write leaves round N with
  // no entry while N-1 and N+1 both have one. Those two are then adjacent in
  // the array while being two rounds apart, and a round nobody measured is not
  // a round that found the same file.
  it("does NOT arm on entries adjacent in the array but two rounds apart", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 1, paths: ["a.ts"] },
          { round: 3, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(false);
  });

  it("a single round can never arm it", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [{ round: 1, paths: ["a.ts"] }],
        lastEscalatedRound: 0,
      }),
    ).toBe(false);
  });

  it("an empty round breaks the chain rather than matching it", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 1, paths: ["a.ts"] },
          { round: 2, paths: [] },
          { round: 3, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(false);
  });

  it("an acknowledgment at the pair’s later round discharges it", () => {
    const roundPaths = [
      { round: 1, paths: ["a.ts"] },
      { round: 2, paths: ["a.ts"] },
    ];
    expect(
      structuralEscalationArmed({ roundPaths, lastEscalatedRound: 2 }),
    ).toBe(false);
  });

  // ARMED-UNTIL-DISCHARGED, mirroring reflectDue: an acknowledgment BEFORE the
  // pair's later round is not an acknowledgment of that pair.
  it("an acknowledgment before the pair’s later round does not discharge it", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 2, paths: ["a.ts"] },
          { round: 3, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 2,
      }),
    ).toBe(true);
  });

  it("RE-ARMS on the next round after a discharge — new evidence, same class", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 2, paths: ["a.ts"] },
          { round: 3, paths: ["a.ts"] },
          { round: 4, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 3,
      }),
    ).toBe(true);
  });

  it("an absent record is not armed, and does not throw", () => {
    expect(structuralEscalationArmed({})).toBe(false);
  });

  it("reads round order from the round numbers, not from array order", () => {
    expect(
      structuralEscalationArmed({
        roundPaths: [
          { round: 2, paths: ["a.ts"] },
          { round: 1, paths: ["a.ts"] },
        ],
        lastEscalatedRound: 0,
      }),
    ).toBe(true);
  });
});

// What `set-escalated --invariant` recorded, echoed back only while
// the duty it was recorded against is still armed.
describe("structuralEscalationInvariant — echo only while armed", () => {
  const armedRoundPaths = [
    { round: 1, paths: ["a.ts"] },
    { round: 2, paths: ["a.ts"] },
  ];

  it("echoes the recorded text when armed", () => {
    expect(
      structuralEscalationInvariant({
        roundPaths: armedRoundPaths,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "the guard wraps every step past the boundary",
      }),
    ).toBe("the guard wraps every step past the boundary");
  });

  it("is null when armed but no invariant was ever recorded", () => {
    expect(
      structuralEscalationInvariant({
        roundPaths: armedRoundPaths,
        lastEscalatedRound: 0,
      }),
    ).toBeNull();
  });

  it("is null when armed but the field is the empty string", () => {
    expect(
      structuralEscalationInvariant({
        roundPaths: armedRoundPaths,
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "",
      }),
    ).toBeNull();
  });

  // The case this predicate exists to prevent: a stored claim from a PRIOR,
  // already-discharged escalation must not resurface as if it were live
  // guidance for a round that owes nothing.
  it("is null when NOT armed, even with a recorded invariant present", () => {
    expect(
      structuralEscalationInvariant({
        roundPaths: [{ round: 1, paths: ["a.ts"] }],
        lastEscalatedRound: 0,
        lastEscalatedInvariant: "a stale claim from a discharged escalation",
      }),
    ).toBeNull();
  });

  it("an absent record is not armed and returns null, not a throw", () => {
    expect(structuralEscalationInvariant({})).toBeNull();
  });
});

describe("normalizeRoundPaths / foldRoundPaths — the stored shape", () => {
  it("de-duplicates and sorts, so set intersection is meaningful", () => {
    expect(normalizeRoundPaths(["b.ts", "a.ts", "b.ts"])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("drops empties, whitespace-only entries and newline-bearing paths", () => {
    expect(normalizeRoundPaths(["", "   ", "a\nb.ts", "ok.ts"])).toEqual([
      "ok.ts",
    ]);
  });

  // Regression: `.trim()` is used only to
  // DETECT a whitespace-only entry, never to transform the stored identity.
  // ` a.ts` and `a.ts` are two distinct, legitimate repository paths — storing
  // both as `a.ts` would alias them to the same recurrence key, arming
  // `structuralEscalationDue` on findings from two different files.
  it("preserves a legitimate path’s own leading/trailing whitespace rather than trimming it", () => {
    expect(normalizeRoundPaths([" a.ts", "a.ts"])).toEqual([" a.ts", "a.ts"]);
  });

  it("drops a path past the length cap rather than truncating it", () => {
    const long = `${"x".repeat(ROUND_PATH_MAX_LENGTH)}.ts`;
    expect(normalizeRoundPaths([long, "a.ts"])).toEqual(["a.ts"]);
  });

  // A re-read of one head must not become a second entry for one round —
  // otherwise a drive that pushed nothing arms an escalation against itself.
  it("REPLACES the entry for a round rather than appending a second", () => {
    const once = foldRoundPaths([], 1, ["a.ts"]);
    const twice = foldRoundPaths(once, 1, ["a.ts", "b.ts"]);
    expect(twice).toEqual([{ round: 1, paths: ["a.ts", "b.ts"] }]);
  });

  // The window bound applies exactly as before ONLY once every entry it
  // would evict is already ACKNOWLEDGED — `lastEscalatedRound` tracks one
  // round behind the one being folded, so by the time round R folds, every
  // earlier round has been "acknowledged" and is free to fall out of the
  // window.
  it("keeps only the newest ROUND_PATHS_WINDOW rounds once acknowledged", () => {
    let acc = foldRoundPaths([], 1, ["r1.ts"], 0);
    for (let r = 2; r <= ROUND_PATHS_WINDOW + 3; r++) {
      acc = foldRoundPaths(acc, r, [`r${r}.ts`], r - 1);
    }
    expect(acc.length).toBe(ROUND_PATHS_WINDOW);
    expect(acc[0]?.round).toBe(4);
    expect(acc[acc.length - 1]?.round).toBe(ROUND_PATHS_WINDOW + 3);
  });

  // The actual bug: a drive that runs
  // past ROUND_PATHS_WINDOW rounds while an early escalation sits
  // UNACKNOWLEDGED must not have that evidence evicted out from under
  // `structuralEscalationArmed` — the qualifying pair would silently
  // disappear with no `set-escalated` or `/reflect` ever having discharged
  // it. `lastEscalatedRound` stays at its default (0, never acknowledged)
  // through every fold here.
  it("retains an armed pair past ROUND_PATHS_WINDOW while unacknowledged", () => {
    let acc = foldRoundPaths([], 1, ["a.ts"]);
    acc = foldRoundPaths(acc, 2, ["a.ts"]); // the qualifying pair: (1, 2)
    for (let r = 3; r <= ROUND_PATHS_WINDOW + 3; r++) {
      acc = foldRoundPaths(acc, r, [`clean-${r}.ts`]); // disjoint, no new pair
    }
    // Round 1 must have survived — without it there is no (1, 2) pair left
    // for the predicate to see at all.
    expect(acc.some((e) => e.round === 1)).toBe(true);
    expect(
      structuralEscalationArmed({ roundPaths: acc, lastEscalatedRound: 0 }),
    ).toBe(true);
  });

  // The mirror case: once (1, 2) IS acknowledged, round 1 owes nothing
  // further and is free to fall out of the window like any other stale
  // entry — unacknowledged retention is not a license to keep everything
  // forever, once every round from here on is ALSO kept caught up (the same
  // "acknowledged as we go" shape as the window test above).
  it("an acknowledged pair is evicted normally once the window is caught up", () => {
    let acc = foldRoundPaths([], 1, ["a.ts"], 0);
    acc = foldRoundPaths(acc, 2, ["a.ts"], 1);
    for (let r = 3; r <= ROUND_PATHS_WINDOW + 3; r++) {
      acc = foldRoundPaths(acc, r, [`clean-${r}.ts`], r - 1);
    }
    expect(acc.some((e) => e.round === 1)).toBe(false);
    expect(acc.length).toBe(ROUND_PATHS_WINDOW);
  });

  // The uncapped sibling `record-paths` compares against to detect
  // truncation: same filtering as `normalizeRoundPaths`, minus the cap
  // itself, so a caller can tell "the cap dropped real evidence" from "there
  // was never more than the cap to begin with".
  it("normalizeRoundPathsUncapped applies the same filtering with no cap", () => {
    const many = Array.from(
      { length: ROUND_PATHS_MAX_PER_ROUND + 5 },
      (_, i) => `f${i}.ts`,
    );
    const uncapped = normalizeRoundPathsUncapped(many);
    expect(uncapped.length).toBe(ROUND_PATHS_MAX_PER_ROUND + 5);
    expect(normalizeRoundPaths(many).length).toBe(ROUND_PATHS_MAX_PER_ROUND);
    // Same de-dup/empty/newline/length filtering as the capped form.
    expect(normalizeRoundPathsUncapped(["b.ts", "a.ts", "b.ts", ""])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});

describe("isUsableState — the new fields are required, not tolerated", () => {
  it("accepts freshState", () => {
    expect(isUsableState(freshState(999), 999)).toBe(true);
  });

  // Pre-GA BWC is explicitly deferred (CLAUDE.md): a state file written before
  // an earlier change is REFUSED, so recovering one is a deliberate `drive-state.ts
  // reset` rather than a silent migration to a zeroed baseline that reads as
  // "never acknowledged".
  it("refuses a older state file (no roundPaths / lastEscalatedRound)", () => {
    const legacy = freshState(999) as Record<string, unknown>;
    delete legacy.roundPaths;
    delete legacy.lastEscalatedRound;
    expect(isUsableState(legacy, 999)).toBe(false);
  });

  it("refuses a hand-edited unsorted or duplicated path list", () => {
    const s = freshState(999) as Record<string, unknown>;
    // `rounds` set to cover the entry, so the failure below is isolated to
    // the path-list clause under test rather than incidentally tripping the
    // separate `round > s.rounds` invariant added below.
    s.rounds = 1;
    s.roundPaths = [{ round: 1, paths: ["b.ts", "a.ts"] }];
    expect(isUsableState(s, 999)).toBe(false);
    s.roundPaths = [{ round: 1, paths: ["a.ts", "a.ts"] }];
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("refuses a non-string path and a negative round", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 1;
    s.roundPaths = [{ round: 1, paths: [5] }];
    expect(isUsableState(s, 999)).toBe(false);
    s.roundPaths = [{ round: -1, paths: [] }];
    expect(isUsableState(s, 999)).toBe(false);
  });

  // Mutation check for the pair above: with the assertion's target restored,
  // the SAME fixture shape must pass — otherwise the two refusals could be
  // failing on some other clause and prove nothing.
  it("accepts the same shape once sorted, de-duplicated and non-negative", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 1;
    s.roundPaths = [{ round: 1, paths: ["a.ts", "b.ts"] }];
    expect(isUsableState(s, 999)).toBe(true);
  });

  // Collection-level invariants, restating what `foldRoundPaths` itself can
  // never produce — a hand-edited file violating any of these changes what
  // `structuralEscalationArmed`'s adjacency check is even looking at.
  it("refuses a round entry naming a round beyond the state’s own `rounds`", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 1;
    s.roundPaths = [{ round: 2, paths: ["a.ts"] }];
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("refuses a duplicate round entry, even with identical paths", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 2;
    s.roundPaths = [
      { round: 1, paths: ["a.ts"] },
      { round: 1, paths: ["a.ts"] },
    ];
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("refuses round entries out of ascending order", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 2;
    s.roundPaths = [
      { round: 2, paths: ["a.ts"] },
      { round: 1, paths: ["b.ts"] },
    ];
    expect(isUsableState(s, 999)).toBe(false);
  });

  // `foldRoundPaths` no longer caps the stored length outright — an entry
  // outside the window survives when it is still unacknowledged. So a
  // hand-edited file is only unproduceable when an entry OUTSIDE the window
  // is one the writer would already have been free to evict: acknowledged
  // (`round <= lastEscalatedRound`).
  it("refuses round entries beyond the window that are already acknowledged", () => {
    const s = freshState(999) as Record<string, unknown>;
    const entries = [];
    for (let r = 1; r <= ROUND_PATHS_WINDOW + 1; r++) {
      entries.push({ round: r, paths: [] });
    }
    s.rounds = ROUND_PATHS_WINDOW + 1;
    // Acknowledged through round 12 — round 1 has nothing left to justify
    // its survival outside the window.
    s.lastEscalatedRound = ROUND_PATHS_WINDOW;
    s.roundPaths = entries;
    expect(isUsableState(s, 999)).toBe(false);
  });

  // The mirror of the refusal above: the SAME shape, produced by a writer
  // that never acknowledged anything (freshState's default
  // `lastEscalatedRound: 0`), is exactly what `foldRoundPaths` would emit —
  // and must be accepted, not refused as "too many entries".
  it("accepts round entries beyond the window when still unacknowledged", () => {
    const s = freshState(999) as Record<string, unknown>;
    const entries = [];
    for (let r = 1; r <= ROUND_PATHS_WINDOW + 1; r++) {
      entries.push({ round: r, paths: [] });
    }
    s.rounds = ROUND_PATHS_WINDOW + 1;
    s.roundPaths = entries;
    expect(isUsableState(s, 999)).toBe(true);
  });

  // Mutation check: the exact same entries, one below the window cap, at a
  // `rounds` that covers every one of them, must pass — otherwise the four
  // refusals above could all be failing on some other clause.
  it("accepts exactly ROUND_PATHS_WINDOW ascending, in-bounds entries", () => {
    const s = freshState(999) as Record<string, unknown>;
    const entries = [];
    for (let r = 1; r <= ROUND_PATHS_WINDOW; r++) {
      entries.push({ round: r, paths: [] });
    }
    s.rounds = ROUND_PATHS_WINDOW;
    s.roundPaths = entries;
    expect(isUsableState(s, 999)).toBe(true);
  });

  // Round 0 is `freshState`'s own baseline, before `bump-round`/`bump-attempt`
  // ever counts a real round — `record-paths` now refuses to write one (see
  // the CLI-level probe below), so a stored entry naming it can only be
  // hand-edited or pre-guard, and admitting it would let it sit adjacent to
  // round 1's real entry.
  it("refuses a round-path entry naming round 0", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 1;
    s.roundPaths = [{ round: 0, paths: ["a.ts"] }];
    expect(isUsableState(s, 999)).toBe(false);
  });

  // Both acknowledging writers (`set-reflected`, `set-escalated`) assign
  // `lastEscalatedRound = s.rounds`, so a value beyond it is not
  // writer-producible — only a hand-edited or corrupted file. Left
  // unchecked, `{rounds: 2, lastEscalatedRound: 999}` would silence
  // `structuralEscalationArmed` for every pair ending at round 999 or
  // earlier, i.e. effectively forever.
  it("refuses a lastEscalatedRound beyond the state’s own `rounds`", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.rounds = 2;
    s.lastEscalatedRound = 999;
    expect(isUsableState(s, 999)).toBe(false);
  });

  // `lastEscalatedInvariant` follows the same REQUIRED-not-tolerated
  // stance as `lastEscalatedRound` above — a state file written before it
  // existed is refused rather than defaulted to `''`.
  it("refuses a older state file (no lastEscalatedInvariant)", () => {
    const legacy = freshState(999) as Record<string, unknown>;
    delete legacy.lastEscalatedInvariant;
    expect(isUsableState(legacy, 999)).toBe(false);
  });

  it("refuses a non-string lastEscalatedInvariant", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.lastEscalatedInvariant = 42;
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("refuses a lastEscalatedInvariant beyond ESCALATION_INVARIANT_MAX_LENGTH", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.lastEscalatedInvariant = "x".repeat(ESCALATION_INVARIANT_MAX_LENGTH + 1);
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("accepts a lastEscalatedInvariant at exactly the max length", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.lastEscalatedInvariant = "x".repeat(ESCALATION_INVARIANT_MAX_LENGTH);
    expect(isUsableState(s, 999)).toBe(true);
  });

  // Same newline ban as `hold.actor` and every other short free-text field
  // this schema treats as single-line — `set-escalated` refuses to WRITE one,
  // so a stored value carrying one can only be hand-edited.
  it("refuses a lastEscalatedInvariant containing a newline", () => {
    const s = freshState(999) as Record<string, unknown>;
    s.lastEscalatedInvariant = "first line\nsecond line";
    expect(isUsableState(s, 999)).toBe(false);
  });
});

describe("drive-state.ts — record-paths / escalation-due / set-escalated", () => {
  it("records a round’s anchors and arms on the same file next round", async () => {
    await withStateDir(async (dir) => {
      expect(
        (await state(dir, ["bump-round", "999", "--head", SHA_A])).stdout,
      ).toBe("1");
      await state(dir, [
        "record-paths",
        "999",
        "--path",
        "b.ts",
        "--path",
        "a.ts",
      ]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );

      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");

      // Stored sorted and de-duplicated, so the predicate's set comparison is
      // over what `normalizeRoundPaths` promises.
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout),
      ).toEqual([
        { round: 1, paths: ["a.ts", "b.ts"] },
        { round: 2, paths: ["a.ts"] },
      ]);
    });
  });

  it("disjoint files across rounds never arm it", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "z.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );
    });
  });

  it("set-escalated discharges it, and the NEXT round re-arms it", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");

      expect((await state(dir, ["set-escalated", "999"])).stdout).toBe("2");
      expect((await state(dir, ["escalated", "999"])).stdout).toBe("2");
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );

      await state(dir, ["bump-round", "999", "--head", SHA_C]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");
    });
  });

  // `--invariant` persists a claim alongside the acknowledgment,
  // and a LATER `set-escalated` with no `--invariant` REPLACES it with `''`
  // rather than preserving the earlier text — a round that acknowledges
  // without restating a claim leaves nothing for the next recurrence to echo.
  it("set-escalated --invariant persists the claim; omitting it later clears", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "the recovery guard wraps every step past the reset boundary",
      ]);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("the recovery guard wraps every step past the reset boundary");

      await state(dir, ["bump-round", "999", "--head", SHA_C]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");

      // Re-armed and re-acknowledged with NO --invariant this time.
      await state(dir, ["set-escalated", "999"]);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  it("set-escalated refuses an --invariant over the length cap rather than truncating it", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      const r = await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "x".repeat(ESCALATION_INVARIANT_MAX_LENGTH + 1),
      ]);
      expect(r.exitCode).toBe(2);
      // Refused BEFORE the write — the acknowledgment itself must not
      // silently go through with the text dropped.
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  it("set-escalated refuses an --invariant containing a newline", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      const r = await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "first line\nsecond line",
      ]);
      expect(r.exitCode).toBe(2);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  // an earlier change: validated and persisted on the RAW
  // value, never a trimmed copy — surrounding spaces survive verbatim
  // rather than being silently stripped before the echo-back contract sees
  // them.
  it("set-escalated persists an --invariant with surrounding spaces verbatim, untrimmed", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "  claim with surrounding spaces  ",
      ]);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("  claim with surrounding spaces  ");
    });
  });

  // an earlier change: a value that is ONLY newline-padded
  // ("\nclaim\n") must be refused outright, the same as an interior newline
  // — trimming first would have accepted it by stripping the very
  // characters the newline check exists to catch.
  it("set-escalated refuses an --invariant with only leading/trailing newlines, rather than trimming them away", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      const r = await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "\nclaim\n",
      ]);
      expect(r.exitCode).toBe(2);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  // an earlier change: without this guard, acknowledging
  // before any round exists sets `lastEscalatedRound` to the exact sentinel
  // (0) `freshState` starts from — indistinguishable from "never escalated"
  // — while still persisting `--invariant` text nobody can attribute to a
  // real recurrence. Mirrors `record-paths`'s own pre-existing guard.
  it("set-escalated refuses to acknowledge before any round has been counted", async () => {
    await withStateDir(async (dir) => {
      const r = await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "a claim with no recurrence to attach to",
      ]);
      expect(r.exitCode).toBe(2);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  // an earlier change: a counted round is not, by itself,
  // evidence of a real recurrence. Without this check, acknowledging a round
  // that never armed persists `lastEscalatedInvariant` under a
  // `lastEscalatedRound` that a LATER, genuine arming then echoes back as
  // though it were THAT arming's own acknowledgment.
  it("set-escalated refuses to acknowledge a counted round with no armed escalation", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      // Disjoint from round 1's path — never arms.
      await state(dir, ["record-paths", "999", "--path", "z.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );

      const r = await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "a claim with no recurrence to attach to",
      ]);
      expect(r.exitCode).toBe(2);
      const got = JSON.parse((await state(dir, ["get", "999"])).stdout);
      expect(got.lastEscalatedInvariant).toBe("");
      expect(got.lastEscalatedRound).toBe(0);
    });
  });

  // Regression: a drive that runs past
  // ROUND_PATHS_WINDOW rounds while every round lands on the SAME file stays
  // unacknowledged throughout, so `foldRoundPaths` retains every entry
  // (round > lastEscalatedRound=0 is true for all of them) — growing
  // `roundPaths` past the window by design. Calling `set-escalated` at that
  // point used to advance `lastEscalatedRound` WITHOUT re-pruning, writing a
  // state `isUsableState` immediately refused on the very next read (an entry
  // outside the window now had `round <= lastEscalatedRound`) — "all later
  // state commands require a reset." A plain `get` after `set-escalated` is
  // the simplest witness that the state stayed usable.
  //
  // An explicit timeout, matching the repo's other subprocess-heavy tests
  // (e.g. self-inflicted.test.ts's `CLI_TIMEOUT_MS`): the loop below alone
  // launches 2 * (ROUND_PATHS_WINDOW + 3) = 30 sequential `drive-state.ts`
  // subprocesses before the assertions even start, which exceeds Bun's
  // default 5s per-test timeout on a slower or concurrently loaded runner.
  it("set-escalated past the window prunes in the same write, leaving state usable", async () => {
    await withStateDir(async (dir) => {
      const head = (r: number) => r.toString(16).padStart(40, "0");
      for (let r = 1; r <= ROUND_PATHS_WINDOW + 3; r++) {
        await state(dir, ["bump-round", "999", "--head", head(r)]);
        await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      }
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout).length,
      ).toBeGreaterThan(ROUND_PATHS_WINDOW);

      const setResult = await state(dir, ["set-escalated", "999"]);
      expect(setResult.exitCode).toBe(0);

      // The witness: any subsequent command must still read a USABLE
      // state, not "exists but is not usable drive state" demanding a
      // reset.
      const getResult = await state(dir, ["get", "999"]);
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stderr).not.toContain("is not usable drive state");
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );

      // And the window bound is restored now that everything up to the
      // new lastEscalatedRound is acknowledged — the same shape as the
      // ordinary window test above, just reached via set-escalated
      // instead of a fold.
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout).length,
      ).toBe(ROUND_PATHS_WINDOW);
    });
  }, 60_000);

  // A /reflect is the deeper step-back and subsumes the narrow one. The
  // reverse must NOT hold, which the assertion after it pins.
  it("set-reflected discharges the escalation too; set-escalated does not discharge the reflect", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe("true");

      await state(dir, ["set-reflected", "999"]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );
      expect((await state(dir, ["escalated", "999"])).stdout).toBe("2");
    });

    await withStateDir(async (dir) => {
      // Armed, exactly like the first half above — `set-escalated` now
      // refuses an unarmed acknowledgment, so this half must
      // still exercise a SUCCESSFUL call to mean anything.
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect((await state(dir, ["set-escalated", "999"])).exitCode).toBe(0);
      // Untouched by set-escalated — 0, not 2.
      expect((await state(dir, ["reflected", "999"])).stdout).toBe("0");
    });
  });

  // A `/reflect` is a step back from the whole class, not a
  // restatement of one file's prior `set-escalated --invariant` claim — so
  // `set-reflected` clears it, rather than letting a later recurrence echo a
  // narrow sentence the reflect may never have revisited.
  it("set-reflected clears a prior set-escalated invariant", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      await state(dir, ["bump-round", "999", "--head", SHA_B]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);

      await state(dir, [
        "set-escalated",
        "999",
        "--invariant",
        "a claim that a later reflect should not be seen as reaffirming",
      ]);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).not.toBe("");

      await state(dir, ["set-reflected", "999"]);
      expect(
        JSON.parse((await state(dir, ["get", "999"])).stdout)
          .lastEscalatedInvariant,
      ).toBe("");
    });
  });

  // The single false positive this signal cannot afford: one round's findings
  // read twice must not look like two rounds finding the same file.
  it("a second record-paths on an unmoved head replaces, never appends", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      // Same head → bump-round is a no-op → still round 1.
      expect(
        (await state(dir, ["bump-round", "999", "--head", SHA_A])).stdout,
      ).toBe("1");
      await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout),
      ).toEqual([{ round: 1, paths: ["a.ts"] }]);
      expect((await state(dir, ["escalation-due", "999"])).stdout).toBe(
        "false",
      );
    });
  });

  // Explicit, never inferred from "no --path was given": an empty --path list
  // is a real answer (a round that found nothing on any file), so it must not
  // be the trigger for blocking on whatever descriptor happens to be attached.
  it("accepts newline-delimited paths on stdin behind an explicit --stdin", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      const proc = Bun.spawn(
        [
          process.execPath,
          join(SCRIPTS, "drive-state.ts"),
          "record-paths",
          "999",
          "--stdin",
        ],
        {
          env: { ...process.env, DRIVE_PR_STATE_DIR: dir },
          stdin: new Response("b.ts\na.ts\n"),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await proc.exited;
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout),
      ).toEqual([{ round: 1, paths: ["a.ts", "b.ts"] }]);
    });
  });

  // The cap is silent in the STORED shape by construction — sort, then slice
  // — so the only place truncation can be surfaced at all is a diagnostic at
  // write time.
  it("warns on stderr, without failing, when a round exceeds the path cap", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      const many = Array.from(
        { length: ROUND_PATHS_MAX_PER_ROUND + 5 },
        (_, i) => ["--path", `f${i}.ts`],
      ).flat();
      const r = await state(dir, ["record-paths", "999", ...many]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("exceeding the");
      expect(r.stderr).toContain("5 dropped");
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout)[0].paths
          .length,
      ).toBe(ROUND_PATHS_MAX_PER_ROUND);
    });
  });

  it("stays silent on stderr when a round is within the path cap", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      const r = await state(dir, [
        "record-paths",
        "999",
        "--path",
        "a.ts",
        "--path",
        "b.ts",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toContain("exceeding the");
    });
  });

  it("no --path and no --stdin records an EMPTY round, and never blocks", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      const r = await state(dir, ["record-paths", "999"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ round: 1, paths: [] }]);
    });
  });

  it("refuses --path together with --stdin rather than silently picking one", async () => {
    await withStateDir(async (dir) => {
      await state(dir, ["bump-round", "999", "--head", SHA_A]);
      const r = await state(dir, [
        "record-paths",
        "999",
        "--stdin",
        "--path",
        "a.ts",
      ]);
      expect(r.exitCode).toBe(2);
    });
  });

  // On fresh state `rounds` is 0 (`freshState`'s own baseline) until
  // `bump-round`/`bump-attempt` counts a real one. Calling `record-paths`
  // directly before that — skipping the `bump-round` every probe above does
  // first — used to write `{round: 0, paths: [...]}`, which then sat
  // adjacent to round 1's real entry the moment counting began
  //. `drive-status.ts`'s own path always bumps
  // first, so this only ever refuses a direct, out-of-order call.
  it("refuses to record anchors before any round has been counted", async () => {
    await withStateDir(async (dir) => {
      const r = await state(dir, ["record-paths", "999", "--path", "a.ts"]);
      expect(r.exitCode).toBe(2);
      expect(
        JSON.parse((await state(dir, ["round-paths", "999"])).stdout),
      ).toEqual([]);
    });
  });
});
