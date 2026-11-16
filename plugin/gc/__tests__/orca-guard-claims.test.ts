/**
 * The launch guard claim across collections: an `orca worktree rm` that gives
 * no answer keeps gc's admission, marked submitted, so Jig's plugin for Orca
 * keeps refusing launches into the worktree; a later collection takes the
 * claim over and asks again, or finds the worktree gone and releases it.
 * `jig gc` runs against the fake `orca` of `orca-fixture.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { admit } from "../../shared/orca-guard.ts";
import type { Receipt, ReceiptLine } from "../types.ts";
import {
  calls,
  type Fixture,
  gc,
  heartbeat,
  idle,
  line,
  setup,
} from "./orca-fixture.ts";

const GUARD_MODULE = resolve(import.meta.dir, "../../shared/orca-guard.ts");
const KEPT = "the launch guard claim stays";

function admissionFile(f: Fixture): string {
  const key = createHash("sha256").update(f.tree).digest("hex");
  return join(f.guard, "admissions", `${key}.json`);
}

function admissions(f: Fixture): string[] {
  const dir = join(f.guard, "admissions");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function admission(f: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(admissionFile(f), "utf8"));
}

/** The one line of a run that exits `status`. */
function only(result: ReturnType<typeof gc>, status: number): ReceiptLine {
  expectSpawnExit(result, status);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources).toHaveLength(1);
  return receipt.resources[0] as ReceiptLine;
}

function rmCalls(f: Fixture): string[] {
  return calls(f).filter((call) => call.startsWith("worktree rm "));
}

/**
 * A collector that admitted the worktree, marked its admission submitted and
 * died before calling `orca worktree rm`: its mark.
 */
function crashAfterMark(f: Fixture, repository = f.repo): string {
  const script = join(f.root, "crash-after-mark.ts");
  writeFileSync(
    script,
    `import { admit } from ${JSON.stringify(GUARD_MODULE)};
const [path, repository, root] = process.argv.slice(2);
const admitted = admit(path, repository, root);
if (!admitted.ok) { console.error(admitted.failure.reason); process.exit(3); }
const marked = admitted.value.submit();
if (!marked.ok) { console.error(marked.failure.reason); process.exit(4); }
console.log(admitted.value.submitted);
`,
  );
  const crashed = Bun.spawnSync(
    [process.execPath, script, f.tree, repository, f.guard],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(crashed, 0);
  return crashed.stdout.toString().trim();
}

describe.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote is served through a shell script as the SSH command, and the remove hook is one",
  ),
)("the launch guard claim of an Orca checkout", () => {
  test("an orca worktree rm that exits nonzero keeps the admission it was marked submitted under, and the next collection asks again", () => {
    const f = setup();
    idle(f);
    f.writeState({ rm: "exit", guard: f.guard });
    const failed = only(gc(f, ["--collect", "--json"]), 1);
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain("orca worktree rm failed (exit 1)");
    expect(failed.reason).toContain(KEPT);
    expect(failed.details).toMatchObject({ claim: "kept" });
    expect(existsSync(f.tree)).toBe(true);
    const atCall = readFileSync(join(f.root, "admission-at-rm.json"), "utf8");
    const kept = admission(f);
    expect(kept.submitted).toEqual(expect.any(String));
    expect(JSON.parse(atCall)).toEqual(kept);

    f.writeState({ guard: f.guard });
    const collected = line(gc(f, ["--collect", "--json"]));
    expect(collected.outcome).toBe("collected");
    expect(collected.reason).not.toContain(KEPT);
    expect(existsSync(f.tree)).toBe(false);
    expect(rmCalls(f)).toHaveLength(2);
    expect(admissions(f)).toEqual([]);
  }, 60_000);

  test("output from orca worktree rm that is not Orca's keeps the admission", () => {
    const f = setup();
    idle(f);
    f.writeState({ rm: "unreadable" });
    const failed = only(gc(f, ["--collect", "--json"]), 1);
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain("unreadable output");
    expect(failed.reason).toContain(KEPT);
    expect(admission(f).submitted).toEqual(expect.any(String));
  }, 60_000);

  test("a collector that died after the mark leaves a claim the next collection takes over, proves again and releases on the reply", () => {
    const f = setup();
    idle(f);
    crashAfterMark(f);
    f.writeState({ guard: f.guard });
    const collected = line(gc(f, ["--collect", "--json"]));
    expect(collected.outcome).toBe("collected");
    expect(collected.proof).toContain("pull request merged");
    expect(existsSync(f.tree)).toBe(false);
    expect(rmCalls(f)).toHaveLength(1);
    const atCall = JSON.parse(
      readFileSync(join(f.root, "admission-at-rm.json"), "utf8"),
    );
    expect(atCall.submitted).toEqual(expect.any(String));
    expect(atCall.holder.pid).not.toBe(process.pid);
    expect(admissions(f)).toEqual([]);
  }, 60_000);

  test("a taken-over claim stays submitted when this collection keeps the worktree before its own call", () => {
    const f = setup();
    idle(f);
    const mark = crashAfterMark(f);
    const before = admission(f);
    heartbeat(f, new Date());
    // A launch the plugin let through just before the claim was taken over.
    f.writeState({ launchAfterAdmission: f.guard });
    const kept = line(gc(f, ["--collect", "--json"]));
    expect(kept.outcome).toBe("refused");
    expect(kept.reason).toContain("within the 120 s settling window");
    expect(kept.reason).toContain(KEPT);
    expect(kept.details).toMatchObject({ claim: "kept" });
    expect(rmCalls(f)).toEqual([]);
    expect(existsSync(f.tree)).toBe(true);
    const after = admission(f);
    expect(after.submitted).toBe(mark);
    expect(after.holder).not.toEqual(before.holder);
  }, 60_000);

  test("a claim whose worktree went with a lost reply is released once the worktree is gone from Orca's list and the disk", () => {
    const f = setup();
    idle(f);
    f.writeState({ rm: "lost-reply" });
    const failed = only(gc(f, ["--collect", "--json"]), 1);
    expect(failed.outcome).toBe("failed");
    expect(failed.reason).toContain(KEPT);
    expect(existsSync(f.tree)).toBe(false);
    expect(admissions(f)).toHaveLength(1);

    // Orca's list cannot be read: the claim stays.
    f.writeState({ worktrees: [], fail: ["list"] });
    const unread = gc(f, ["--collect", "--json"]);
    expectSpawnExit(unread, 1);
    expect(admissions(f)).toHaveLength(1);

    f.writeState({ worktrees: [] });
    const reported = line(gc(f, ["--json"]));
    expect(reported).toMatchObject({
      resource: f.tree,
      outcome: "would-collect",
      details: { claim: "gone" },
    });
    expect(admissions(f)).toHaveLength(1);

    const released = line(gc(f, ["--collect", "--json"]));
    expect(released.outcome).toBe("collected");
    expect(released.reason).toContain("released the launch guard claim");
    expect(released.proof).toContain("gone from Orca's list and from the disk");
    expect(admissions(f)).toEqual([]);
    expect(rmCalls(f)).toHaveLength(1);
  }, 60_000);

  test("a claim whose worktree is gone but still registered with Git is the resource, and is released", () => {
    const f = setup();
    idle(f);
    crashAfterMark(f);
    rmSync(f.tree, { recursive: true, force: true });
    f.writeState({ worktrees: [] });
    const released = line(gc(f, ["--collect", "--json"]));
    expect(released).toMatchObject({ resource: f.tree, outcome: "collected" });
    expect(released.reason).toContain("released the launch guard claim");
    expect(admissions(f)).toEqual([]);
  }, 60_000);

  test("a dead collection's claim on a worktree that fails its idle proof is on the receipt line", () => {
    const f = setup();
    crashAfterMark(f);
    const reported = line(gc(f, ["--json"]));
    expect(reported.resource).toBe(f.tree);
    expect(reported.details).toMatchObject({
      claim: "standing",
      claimNote: expect.stringContaining("launch guard claim stands"),
    });
    expect(admissions(f)).toHaveLength(1);
  }, 60_000);

  test("a claim another repository's collection left on a gone worktree is not this repository's to release", () => {
    const f = setup();
    crashAfterMark(f, join(f.root, "other-repository"));
    const text = readFileSync(admissionFile(f), "utf8");
    f.command(["git", "worktree", "remove", "--force", f.tree]);
    f.writeState({ worktrees: [] });
    const result = gc(f, ["--collect", "--json"]);
    expectSpawnExit(result, 0);
    expect((JSON.parse(result.stdout.toString()) as Receipt).resources).toEqual(
      [],
    );
    expect(readFileSync(admissionFile(f), "utf8")).toBe(text);
  }, 60_000);

  test("a claim written before admissions named their repository is reported for a person, never released", () => {
    const f = setup();
    crashAfterMark(f);
    const { repository: _, incarnation: __, ...v1 } = admission(f);
    writeFileSync(admissionFile(f), JSON.stringify({ ...v1, v: 1 }));
    f.command(["git", "worktree", "remove", "--force", f.tree]);
    f.writeState({ worktrees: [] });
    const kept = line(gc(f, ["--collect", "--json"]));
    expect(kept).toMatchObject({
      resource: f.tree,
      outcome: "unverified",
      details: { claim: "gone" },
    });
    expect(kept.reason).toContain("named their repository");
    expect(admissions(f)).toHaveLength(1);
  }, 60_000);

  test("a claim on a worktree made again at its path is released, so the new worktree takes launches", () => {
    const f = setup();
    crashAfterMark(f);
    const file = admissionFile(f);
    f.command(["git", "worktree", "remove", "--force", f.tree]);
    f.command(["git", "worktree", "add", f.tree, "topic"]);
    const reported = JSON.parse(gc(f, ["--json"]).stdout.toString()) as Receipt;
    expect(
      reported.resources.find((entry) => entry.resource === file),
    ).toMatchObject({
      outcome: "would-collect",
      details: { claim: "superseded", orcaPath: f.tree },
    });
    const tree = reported.resources.find((entry) => entry.resource === f.tree);
    expect(tree?.details).not.toMatchObject({ claim: "standing" });
    expect(admissions(f)).toHaveLength(1);

    const result = gc(f, ["--collect", "--json"]);
    const released = (
      JSON.parse(result.stdout.toString()) as Receipt
    ).resources.find((entry) => entry.resource === file);
    expect(released?.outcome).toBe("collected");
    expect(released?.reason).toContain("released the launch guard claim");
    expect(admissions(f)).toEqual([]);
    expect(existsSync(f.tree)).toBe(true);
    expect(rmCalls(f)).toEqual([]);
  }, 60_000);

  test("a live collection's submitted admission is left alone, even once its worktree is gone", () => {
    const f = setup();
    const held = admit(f.tree, f.repo, f.guard);
    if (!held.ok) throw new Error(held.failure.reason);
    try {
      expect(held.value.submit().ok).toBe(true);
      const text = readFileSync(held.value.file, "utf8");
      f.command(["git", "worktree", "remove", f.tree]);
      f.writeState({ worktrees: [] });
      const result = gc(f, ["--collect", "--json"]);
      expectSpawnExit(result, 0);
      expect(
        (JSON.parse(result.stdout.toString()) as Receipt).resources,
      ).toEqual([]);
      expect(readFileSync(held.value.file, "utf8")).toBe(text);
    } finally {
      held.value.release();
    }
  }, 60_000);
});
