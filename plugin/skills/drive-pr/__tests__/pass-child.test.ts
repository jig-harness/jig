/**
 * pass-child.test.ts — `lib/pass-child.ts`'s "is a pass currently running
 * under this driver" probe.
 *
 * TWO LAYERS, TWO TESTING STRATEGIES. `findPassChild` is the pure
 * exclusion-list-plus-tree-walk — tested here against SYNTHETIC `ProcRow[]`
 * fixtures, never a spawned process, so the recognizer's own decisions (which
 * argv counts as "this repo's own helper script") are asserted deterministically
 * regardless of what else happens to be running on the machine the suite
 * executes on. `hasPassChild` is the thin real-`ps` wrapper around it — tested
 * against REAL spawned processes, because the one thing worth proving
 * end-to-end is that a genuine `ps -A -o pid=,ppid=,args=` invocation round-
 * trips through `parsePassChildRows` into the same answer the pure walk would
 * give for an equivalent synthetic fixture.
 *
 * WHY A REAL SUBPROCESS TREE, NOT `process.pid`. `hasPassChild` walks pid's
 * descendants using a `ps` call that is ITSELF spawned as a child of the
 * CURRENT process. Using this test runner's own `process.pid` as the
 * "driver" under test would therefore always find `ps`'s own invocation as a
 * live, non-excluded descendant of itself — a self-measurement artifact, not
 * a fact about the driver. Every integration case below instead spawns an
 * INDEPENDENT child process tree and probes THAT pid, so `hasPassChild`'s own
 * `ps` subprocess (a child of the test runner) is a sibling to the fixture
 * tree, never inside it.
 */

import { describe, expect, it } from "bun:test";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPassChild,
  hasPassChild,
  type ProcRow,
  parsePassChildRows,
} from "../scripts/lib/pass-child.ts";

const HAS_BASH = (() => {
  try {
    accessSync("/bin/bash", fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
})();
// `hasPassChild` relies on POSIX `ps`; the fixtures below additionally need
// bash's `exec -a` to plant a chosen argv[0] onto a long-lived process — both
// are POSIX-only, matching `lib/pass-child.ts`'s own scope (no `/proc`
// dependency, but no Windows support either, same as `drives.ts --stop`).
const posixIt = process.platform !== "win32" && HAS_BASH ? it : it.skip;

describe("parsePassChildRows", () => {
  it("parses pid, ppid and the remainder of the line as args", () => {
    const rows = parsePassChildRows(
      "  1   0 /sbin/launchd\n" + ' 42   1 claude -p "/drive-pr 1234"\n',
    );
    expect(rows).toEqual([
      { pid: 1, ppid: 0, args: "/sbin/launchd" },
      { pid: 42, ppid: 1, args: 'claude -p "/drive-pr 1234"' },
    ]);
  });

  it("skips lines that do not start with two integers", () => {
    const rows = parsePassChildRows(
      "PID  PPID ARGS\n" + "  1   0 ok\n" + "garbage\n" + "\n",
    );
    expect(rows).toEqual([{ pid: 1, ppid: 0, args: "ok" }]);
  });

  it("keeps embedded whitespace in args intact", () => {
    const rows = parsePassChildRows('  5   1 codex exec --flag "a value"\n');
    expect(rows).toEqual([
      { pid: 5, ppid: 1, args: 'codex exec --flag "a value"' },
    ]);
  });
});

describe("findPassChild — the pure exclusion-list-plus-walk", () => {
  const DRIVER = 100;

  it("no descendants at all → false", () => {
    expect(
      findPassChild(DRIVER, [{ pid: DRIVER, ppid: 1, args: "drive.ts" }]),
    ).toBe(false);
  });

  it("a single descendant that IS a skill helper script → false", () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts --once",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a helper script run from the plugin install, of any of the three skills → false", () => {
    for (const skill of ["drive-pr", "resolve-review-comments", "do-item"]) {
      const rows: ProcRow[] = [
        { pid: DRIVER, ppid: 1, args: "drive.ts" },
        {
          pid: 101,
          ppid: DRIVER,
          args: `bun /home/dev/.claude/plugins/cache/groundwork/groundwork/0.3.0/skills/${skill}/scripts/helper.ts --once`,
        },
      ];
      expect(findPassChild(DRIVER, rows)).toBe(false);
    }
  });

  it("a single descendant that is NOT a skill helper script → true", () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      { pid: 101, ppid: DRIVER, args: 'claude -p "/drive-pr 1234"' },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a helper-script child whose OWN child is NOT a helper script → still false (pruned, not a whole-tree walk)", () => {
    // Inverted from this suite's own earlier assertion (`true`)
    // review round 2, M3(b). The old behaviour descended into an excluded
    // helper's children and found this `git push` "not a skill script,
    // therefore a pass" — but everything a helper spawns is helper work
    // (`drive-status.ts`/`ci-hold.ts` each make several real `gh` calls),
    // and the measured consequence was a genuinely wedged drive (an
    // unbounded `sleep(10); continue;` loop with no pass and no progress)
    // flapping between WEDGED and HEALTHY across consecutive `--doctor`
    // runs depending only on whether one of its helpers' own `gh`
    // grandchildren happened to be alive at the instant of the `ps` probe.
    // Pruning at the helper closes it without risk: the pass is always a
    // DIRECT child of the driver, never nested under one of the driver's
    // own helper calls, so nothing this walk now skips could ever have
    // been the pass.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/guarded-push.ts",
      },
      { pid: 102, ppid: 101, args: "git push origin HEAD" },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a genuine pass and a helper are both direct children — the pass is found regardless of the helper sibling", () => {
    // The pruning fix above removes DESCENT into a helper's children; it
    // must not also stop this walk from noticing a DIFFERENT, non-nested
    // direct child that is a real pass.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
      { pid: 102, ppid: DRIVER, args: 'claude -p "/drive-pr 1234"' },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("every descendant a helper script, several levels deep → false", () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
      {
        pid: 102,
        ppid: 101,
        args: "/repo/.claude/skills/resolve-review-comments/scripts/await-round.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it('drives.ts and drive.ts themselves are excluded, not just the "helper" scripts', () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drives.ts --json",
      },
      {
        pid: 102,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive.ts 999 -- claude -p x",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a scripts/lib/*.ts path does NOT match the exclusion — lib modules are never invoked directly, so this counts as a pass", () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/lib/proc.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it('a scripts/__tests__/**.ts fixture path does NOT match the exclusion, so a test can construct "this counts as a pass"', () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/__tests__/fixtures/fake-pass.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("102 nested under helper 101 is never reached at all — pruning, not a deep walk that happens to land on false", () => {
    // Superseded by the M3(b) pruning fix: 101 is a helper, so its own
    // children (102) are never pushed onto the stack regardless of what
    // 102's argv says or how it is wired to 101 — this fixture's pid-102
    // entry is inert. What used to be a "does a deep cyclic walk terminate"
    // case is now, honestly, just "a lone excluded direct child → false"
    // (see the sibling "every descendant a helper script" test above) —
    // kept as its own case only to pin that a NESTED, potentially-cyclic
    // entry cannot resurrect the pre-pruning behaviour by accident.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
      {
        pid: 102,
        ppid: 101,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-state.ts get 1",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a duplicate direct-child entry for the same pid is de-duplicated, not double-processed", () => {
    // The `visited` set's remaining job post-pruning: the walk can no
    // longer loop forever (nothing is ever pushed past `pid`'s own direct
    // children, so the stack is bounded by that list's length regardless of
    // what it contains), but a `ps` snapshot listing the SAME pid twice for
    // the same parent — a torn read, or two lines racing the same instant —
    // must not be treated as two independent processes. Both duplicate rows
    // here are helpers, so the fixture also has to prove the duplication
    // itself changes nothing: this must still read `false`, not `true` from
    // processing the same row an extra time.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("an unrelated process tree (different ppid lineage) is not walked at all", () => {
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      { pid: 999, ppid: 1, args: 'claude -p "/some/other/pr"' },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a REAL, direct pass is still recognized when its own prompt/argument merely MENTIONS a helper script path as data (review finding)", () => {
    // The regex used to run unanchored across the whole command line, so a
    // real pass — a direct child of the driver, exactly the shape a genuine
    // pass always has — was misclassified as an excluded helper the moment
    // its own argv happened to contain a helper-shaped substring anywhere
    // past the executable position, e.g. inside a quoted prompt. Anchoring
    // the check to the first two tokens (the executable position) fixes it:
    // `claude` and `-p` are neither one a helper path, so this must still
    // read as a pass regardless of what the REST of the line says.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: 'claude -p "please check .claude/skills/drive-pr/scripts/drive-state.ts"',
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a checkout under a path containing a space is still recognized as a helper invocation (review finding)", () => {
    // `ps ... args=` is flattened display text with no preserved argv
    // boundaries. Splitting on "the first two whitespace-delimited tokens"
    // cuts `bun /tmp/My Repo/.claude/skills/drive-pr/scripts/drive-state.ts
    // progress 4733 --phase pass-spawned` into `bun` and `/tmp/My` — neither
    // matches `OWN_HELPER_SCRIPT` — misreading this genuine helper
    // invocation as a live pass and classifying stale progress HEALTHY
    // instead of WEDGED.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "bun /tmp/My Repo/.claude/skills/drive-pr/scripts/drive-state.ts progress 4733 --phase pass-spawned",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a real pass started via a recognized runtime whose own flags merely mention a helper path is still recognized as a pass", () => {
    // Confirms the runtime-basename + absolute-path-start check is not a
    // free pass for anything spawned via `bun`/`node`: the content right
    // after the runtime token must itself look like the start of the script
    // path, not an unrelated flag that merely leads to a mention deeper in
    // the line.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "node -e \"require('/repo/.claude/skills/drive-pr/scripts/drive-state.ts')\"",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a real pass whose FIRST argument is its OWN absolute script path is still recognized as a pass, even though a later argument mentions a helper path (review finding)", () => {
    // `afterRuntime.startsWith('/')` alone only checks the first character
    // after the runtime token — it does not confirm that the absolute path
    // right there IS the one leading into `OWN_HELPER_SCRIPT`'s own match
    // with nothing else in between. `/repo/pass.ts` is a real pass's own
    // entrypoint (not a helper script), and `--prompt
    // /repo/.claude/skills/drive-pr/scripts/drive-state.ts` is merely a
    // flag value mentioning a helper path as DATA — the same class of
    // mention `OWN_HELPER_SCRIPT`'s own unanchored-match fix (above) exists
    // to exclude, just past a runtime token instead of at the front.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "node /repo/pass.ts --prompt /repo/.claude/skills/drive-pr/scripts/drive-state.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a real pass whose SECOND argument is a bare positional path mentioning a helper is still recognized as a pass, with no flag involved (review finding, round 7)", () => {
    // The sibling of the fixture above, minus the `--prompt` flag: `node
    // /repo/pass.ts /repo/.claude/skills/drive-pr/scripts/drive-state.ts`.
    // The flag guard (`isFlagged`) never fires here because nothing in the
    // remainder is flag-shaped, so a fix that only special-cased flags left
    // this positional-argument sibling accepting `/repo/pass.ts` (the real
    // pass) as if it were our own helper. The general fix checks whether
    // `after` (`/repo/pass.ts /repo`) itself restarts with a fresh absolute
    // path before reaching the match — it does, at " /repo" — which is true
    // of ANY different program's own trailing argv, flag-shaped or not.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "node /repo/pass.ts /repo/.claude/skills/drive-pr/scripts/drive-state.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a real pass whose SECOND argument is a bare RELATIVE positional path mentioning a helper is still recognized as a pass (review finding, round 9)", () => {
    // The sibling of the round-7 fixture above, with a RELATIVE second
    // argument instead of an absolute one: `node /repo/pass.ts
    // repo/.claude/skills/drive-pr/scripts/drive-state.ts`. `after` (`
    // /repo/pass.ts repo`) still starts with `/` and has no flag, and the
    // round-7 fix's own `hasFreshPathRestart` only detected a FRESH
    // ABSOLUTE restart, so a relative continuation slipped through and
    // `/repo/pass.ts` — the real pass — was still misread as our own
    // helper. The general fix recognizes that `/repo/pass.ts` (`before`,
    // at the boundary right before `repo`) already ends in `.ts` — a
    // complete script path in its own right — so whatever follows,
    // relative or not, is a separate argument.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "node /repo/pass.ts repo/.claude/skills/drive-pr/scripts/drive-state.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a real pass invoked with NO runtime interpreter, whose bare positional argument mentions a helper path, is still recognized as a pass", () => {
    // The same class of bug as the round-7/round-9 fixtures, without a
    // `node`/`bun` prefix at all: `/repo/pass.ts
    // repo/.claude/skills/drive-pr/scripts/drive-state.ts` directly. Before
    // the general `.ts`-terminated-path signal, `RUNTIME_BASENAME` never
    // matching `before` meant the primary check never fired, but the
    // OUTER `freshPathRestart` tracking (guarding the final embedded-space
    // shebang fallback) ALSO only recognized an absolute restart — a
    // relative one left `freshPathRestart` false and the fallback wrongly
    // accepted `/repo/pass.ts` as a single embedded-space path continuing
    // into the match.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/pass.ts repo/.claude/skills/drive-pr/scripts/drive-state.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a checkout directory whose OWN name embeds a period is still recognized as a helper invocation (review finding)", () => {
    // A prior fix for the space-containing-checkout-path defect (test above)
    // used "does a `.` followed by word characters appear before the match"
    // to reject a mentioned-not-executed path. That test is satisfied by an
    // ordinary directory name that happens to embed a period too —
    // `/tmp/My.Worktree Repo` — which made this exact own-helper invocation
    // misread as a live pass, the same class of bug the space-tolerance fix
    // exists to close. The replacement guard (a CLI-flag-shaped token) does
    // not fire on a plain path segment.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "bun /tmp/My.Worktree Repo/.claude/skills/drive-pr/scripts/drive-state.ts progress 4733 --phase pass-spawned",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a runtime installed under a path containing a space is still recognized as a helper invocation (review finding)", () => {
    // The first-whitespace split lands inside the RUNTIME's own path here
    // ("John Doe"), not at the true runtime/script boundary — `runtimeToken`
    // becomes `/Users/John`, which never matches `RUNTIME_BASENAME`, so the
    // old code misread this genuine helper invocation as a live pass. Every
    // whitespace run in `prefix` is now tried as a candidate split, so the
    // boundary right after `bun` is found regardless of what precedes it.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/Users/John Doe/.bun/bin/bun /repo/.claude/skills/drive-pr/scripts/drive-status.ts --once",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a directly executed helper whose checkout root contains a space, with no runtime involved at all, is still recognized (review finding)", () => {
    // No runtime token precedes this shebang execution, so every candidate
    // split in `prefix` ("/tmp/My Repo") fails `RUNTIME_BASENAME` — the old
    // code fell through to `false` (not a helper) the moment `prefix`
    // contained any whitespace at all. The fallback now accepts a single
    // absolute shebang path whose checkout root embeds a space, since no
    // boundary here restarts a FRESH path (`Repo` never begins with `/`).
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/tmp/My Repo/.claude/skills/drive-pr/scripts/drive-status.ts --once",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(false);
  });

  it("a top-level script belonging to a DIFFERENT skill is not excluded — only drive-pr and resolve-review-comments are (review finding, round 8)", () => {
    // `drive.ts` accepts an arbitrary pass argv, so a caller may legitimately
    // run another skill's own top-level script as the pass command. A
    // skill-name wildcard in `OWN_HELPER_SCRIPT` would prune this live
    // process as if it were routine drive-pr/resolve-review-comments
    // bookkeeping, letting a genuinely healthy driver read as WEDGED.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/repo/.claude/skills/some-other-skill/scripts/run.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });

  it("a different program invoked via an absolute path, with our helper path as a later bare argument, is still recognized as a pass", () => {
    // Confirms the checkout-root-with-embedded-space fallback does not
    // over-admit: `/usr/bin/cat` has no whitespace of its own, so `prefix`
    // ("/usr/bin/cat /repo") looks superficially like the accepted shape
    // above, but the boundary after `cat` restarts a FRESH absolute path
    // ("/repo...") with no runtime to justify it — the same signal that
    // rejects a real different script's own invocation.
    const rows: ProcRow[] = [
      { pid: DRIVER, ppid: 1, args: "drive.ts" },
      {
        pid: 101,
        ppid: DRIVER,
        args: "/usr/bin/cat /repo/.claude/skills/drive-pr/scripts/drive-status.ts",
      },
    ];
    expect(findPassChild(DRIVER, rows)).toBe(true);
  });
});

describe("hasPassChild — the real ps integration", () => {
  posixIt("no descendant at all → false", async () => {
    // `sleep` spawned DIRECTLY, with no shell in between, so the pid under
    // test provably has no children — `sleep` forks nothing.
    //
    // Deliberately NOT `sh -c 'sleep 30'` relying on the shell exec-replacing
    // itself for a single simple command: that optimisation is a shell
    // implementation detail, not a POSIX guarantee, and a shell that forks
    // instead leaves a real `sleep` child that this probe correctly reports
    // as a pass — so the test failed on Linux (the majordomo gates host)
    // while passing on macOS, asserting the shell's behaviour rather than
    // this function's.
    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(await hasPassChild(child.pid)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  posixIt("a real, non-helper-script descendant → true", async () => {
    // `& wait` forces bash to actually fork the `sleep` rather than
    // tail-call it, so the spawned pid keeps a genuine child alive.
    const child = Bun.spawn(["/bin/bash", "-c", "sleep 30 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(await hasPassChild(child.pid)).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  posixIt(
    "a descendant whose argv IS a skill helper script path → false",
    async () => {
      // `exec -a NAME cmd` (bash) runs `cmd` with argv[0] replaced by NAME —
      // the cheapest way to make a REAL, long-lived process whose `ps`-visible
      // argv is an absolute helper-script path, without actually invoking a
      // real script (and its side effects).
      const child = Bun.spawn(
        [
          "/bin/bash",
          "-c",
          'exec -a "/repo/.claude/skills/drive-pr/scripts/drive-status.ts" sleep 30',
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        await new Promise((r) => setTimeout(r, 200));
        expect(await hasPassChild(child.pid)).toBe(false);
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  it("a ps that cannot be spawned at all degrades to null, never false", async () => {
    const savedPath = process.env.PATH;
    // An EMPTY DIRECTORY on PATH, not an empty STRING: POSIX `execvp` falls
    // back to a default system path (`confstr(_CS_PATH)`, typically
    // `/bin:/usr/bin`) when handed `PATH=''`, so `ps` is still found and this
    // fixture would prove nothing — the same distinction `drives.test.ts`'s
    // own `--stop` ps-unavailable fixture already draws. `null` must never
    // collapse to `false` (a positive claim of "no pass"), which
    // `classifyDrive` would otherwise be able to read as WEDGED evidence
    // over a probe that never actually ran. `process.pid` (the test runner's
    // own) is fine to target here specifically BECAUSE the spawn fails
    // before any tree walk happens — the self-measurement hazard the module
    // header warns about only applies once `ps` actually runs.
    const empty = mkdtempSync(join(tmpdir(), "pass-child-noPATH-"));
    try {
      process.env.PATH = empty;
      expect(await hasPassChild(process.pid)).toBeNull();
    } finally {
      process.env.PATH = savedPath;
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
