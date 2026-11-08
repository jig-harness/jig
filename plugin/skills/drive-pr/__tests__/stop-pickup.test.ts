/**
 * stop-pickup.ts: what a drive armed after a stall, a spent CI-repair
 * budget or a pass deadline tells its first pass, and whether it takes the
 * tree's edits as the stopped drive's. Run in a subprocess, which alone gets the handoff
 * directory the narrative is read from.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import type { DriveEvent } from "../scripts/lib/state/events.ts";
import { NARRATIVE_MARKER } from "../scripts/lib/state/handoff.ts";
import { SCRIPTS, tmpRoot, useDrivePrSuite } from "./drive-pr-harness.ts";

useDrivePrSuite();

interface Pickup {
  notice: string;
  inheritsEdits: boolean;
}

async function pickupAfter(
  events: DriveEvent[],
  narrative: string[] = [],
): Promise<Pickup> {
  const handoff = mkdtempSync(join(tmpRoot, "stop-pickup-"));
  writeFileSync(
    join(handoff, "pr-drive-7.md"),
    ["# handoff", "", NARRATIVE_MARKER, ...narrative, ""].join("\n"),
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const m = await import(process.env.JIG_TEST_MODULE); const a = await import(process.env.JIG_TEST_ACTOR); const h = await import(process.env.JIG_TEST_MIRROR); const here = (await a.resolveActor()) + "@" + h.hostLabel(); const s = JSON.parse(process.env.JIG_TEST_STATE); s.events = s.events.map((e) => (e.tree === "HERE" ? { ...e, tree: here } : e)); console.log(JSON.stringify(await m.stopPickup("7", s)));',
    ],
    {
      env: {
        ...process.env,
        DRIVE_PR_HANDOFF_DIR: handoff,
        JIG_TEST_MODULE: join(SCRIPTS, "lib", "driver", "stop-pickup.ts"),
        JIG_TEST_ACTOR: join(SCRIPTS, "lib", "state", "actor.ts"),
        JIG_TEST_MIRROR: join(SCRIPTS, "lib", "state", "ledger-mirror.ts"),
        JIG_TEST_STATE: JSON.stringify({ ...freshState(7), events }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
  return JSON.parse(stdout) as Pickup;
}

/** `tree` "HERE" is the tree the pickup runs in. */
const stop = (
  cause: string,
  leftWork?: boolean,
  tree = "HERE",
): DriveEvent => ({
  at: "2026-11-07T10:00:00.000Z",
  round: 4,
  kind: "stop",
  cause,
  ...(leftWork === undefined ? {} : { leftWork, tree }),
});

describe("stopPickup", () => {
  it("hands a stall's recorded decisions to the next drive, and the work it left", async () => {
    const r = await pickupAfter(
      [stop("14", true)],
      ["Blocked: finish-round.ts exit 3 (REFUSED_UNCLEAN), the tree is dirty."],
    );
    expect(r.notice).toStartWith("RE-ARMED AFTER A STALL");
    expect(r.notice).toContain("Blocked: finish-round.ts exit 3");
    expect(r.notice).toContain("It left work in this tree");
    expect(r.inheritsEdits).toBe(true);
  });

  it("leaves the tree's edits a person's when the stall left work in another tree", async () => {
    const r = await pickupAfter([stop("14", true, "wt-0123456789abcdef@h")]);
    expect(r.notice).toContain("It left work in another tree");
    expect(r.inheritsEdits).toBe(false);
  });

  it("leaves the tree's edits a person's when the stop never measured its tree", async () => {
    const r = await pickupAfter([stop("14")]);
    expect(r.inheritsEdits).toBe(false);
  });

  it("leaves the tree's edits a person's when the stall measured no work", async () => {
    const r = await pickupAfter([stop("14", false)]);
    expect(r.notice).toStartWith("RE-ARMED AFTER A STALL");
    expect(r.notice).toContain("recorded nothing");
    expect(r.notice).not.toContain("It left work");
    expect(r.inheritsEdits).toBe(false);
  });

  it("hands a pass deadline's work in this tree to the next drive, and only that tree's", async () => {
    const here = await pickupAfter([stop("15", true)]);
    expect(here.notice).toStartWith("RE-ARMED AFTER A PASS DEADLINE");
    expect(here.notice).toContain("It left work in this tree");
    expect(here.inheritsEdits).toBe(true);
    const elsewhere = await pickupAfter([
      stop("15", true, "wt-0123456789abcdef@h"),
    ]);
    expect(elsewhere.notice).toContain("It left work in another tree");
    expect(elsewhere.inheritsEdits).toBe(false);
    const clean = await pickupAfter([stop("15", false)]);
    expect(clean.notice).toStartWith("RE-ARMED AFTER A PASS DEADLINE");
    expect(clean.inheritsEdits).toBe(false);
  });

  it("names a spent CI-repair budget", async () => {
    const r = await pickupAfter([stop("21")]);
    expect(r.notice).toStartWith(
      "RE-ARMED AFTER THE CI-REPAIR BUDGET WAS SPENT",
    );
    expect(r.inheritsEdits).toBe(false);
  });

  it("says nothing after any other stop, or the last of several", async () => {
    for (const events of [
      [],
      [stop("1")],
      [stop("unknown")],
      [stop("14", true), stop("0")],
    ]) {
      const r = await pickupAfter(events);
      expect(r).toEqual({ notice: "", inheritsEdits: false });
    }
  });
});
