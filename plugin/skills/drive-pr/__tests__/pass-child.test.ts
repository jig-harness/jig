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
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPassChild,
  hasPassChild,
  type ProcRow,
  parsePassChildRows,
} from "../scripts/lib/pass-child.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  captureProcessTree,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";

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
          args: `bun /home/dev/.claude/plugins/cache/jig/jig/0.3.0/skills/${skill}/scripts/helper.ts --once`,
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
    // Inverted from this suite's own earlier assertion (`true`). The old
    // behaviour descended into an excluded helper's children and found this
    // `git push` "not a skill script, therefore a pass" — but everything a
    // helper spawns is helper work
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

  it("a REAL, direct pass is still recognized when its own prompt/argument merely MENTIONS a helper script path as data", () => {
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

  it("a checkout under a path containing a space is still recognized as a helper invocation", () => {
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

  it("a real pass whose FIRST argument is its OWN absolute script path is still recognized as a pass, even though a later argument mentions a helper path", () => {
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

  it("a real pass whose SECOND argument is a bare positional path mentioning a helper is still recognized as a pass, with no flag involved", () => {
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

  it("a real pass whose SECOND argument is a bare RELATIVE positional path mentioning a helper is still recognized as a pass", () => {
    // The sibling of the absolute-positional fixture above, with a RELATIVE
    // second argument instead of an absolute one: `node /repo/pass.ts
    // repo/.claude/skills/drive-pr/scripts/drive-state.ts`. `after` (`
    // /repo/pass.ts repo`) still starts with `/` and has no flag, and the
    // earlier fix's own `hasFreshPathRestart` only detected a FRESH ABSOLUTE
    // restart, so a relative continuation slipped through and
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
    // The same class of bug as the two positional-argument fixtures, without a
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

  it("a checkout directory whose OWN name embeds a period is still recognized as a helper invocation", () => {
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

  it("a runtime installed under a path containing a space is still recognized as a helper invocation", () => {
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

  it("a directly executed helper whose checkout root contains a space, with no runtime involved at all, is still recognized", () => {
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

  it("a top-level script belonging to a DIFFERENT skill is not excluded — only drive-pr and resolve-review-comments are", () => {
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

describe("hasPassChild — the native process table integration", () => {
  const busy = "setInterval(() => {}, 1000)";
  const ready = async (file: string) => {
    const deadline = Date.now() + 20_000;
    while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(file)).toBe(true);
  };
  const stop = async (child: ReturnType<typeof Bun.spawn>) => {
    try {
      const targets = await captureProcessTree(child.pid);
      if (targets) await signalIdentityTargets(targets, "SIGKILL");
    } finally {
      // The fixture owns this handle even when a native snapshot is unreadable.
      child.kill("SIGKILL");
    }
  };
  it("no descendant at all → false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pass-child-none-"));
    const file = join(dir, "ready");
    const child = Bun.spawn([
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(file)}, ""); ${busy}`,
    ]);
    try {
      await ready(file);
      // The first native CIM query can reach its own bound while Windows starts
      // the provider. Unknown remains unknown until a readable snapshot arrives.
      const deadline = Date.now() + 20_000;
      let observed = await hasPassChild(child.pid);
      while (observed === null && Date.now() < deadline) {
        await Bun.sleep(50);
        observed = await hasPassChild(child.pid);
      }
      expect(observed).toBe(false);
    } finally {
      await stop(child);
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  for (const helper of [false, true]) {
    it(helper
      ? "a genuine helper child is excluded"
      : "a real non-helper child is found", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pass-child-tree-"));
      const scripts = join(
        dir,
        "skills",
        helper ? "drive-pr" : "another-skill",
        "scripts",
      );
      mkdirSync(scripts, { recursive: true });
      const file = join(dir, "ready");
      const script = join(scripts, "fixture.ts");
      writeFileSync(
        script,
        `require("node:fs").writeFileSync(${JSON.stringify(file)}, ""); ${busy}`,
      );
      const child = Bun.spawn([
        process.execPath,
        "-e",
        `Bun.spawn([process.execPath,${JSON.stringify(script)}], {stdout:"ignore",stderr:"ignore"}); ${busy}`,
      ]);
      try {
        await ready(file);
        expect(await hasPassChild(child.pid)).toBe(!helper);
      } finally {
        await stop(child);
        await child.exited;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it("an unavailable native probe returns null, never false", () => {
    const empty = mkdtempSync(join(tmpdir(), "pass-child-noPATH-"));
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const {hasPassChild}=await import(${JSON.stringify(fileURLToPath(new URL("../scripts/lib/pass-child.ts", import.meta.url)))}); console.log(JSON.stringify(await hasPassChild(process.pid)))`,
        ],
        {
          env: { ...process.env, PATH: empty },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(result, 0);
      expect(result.stdout.toString().trim()).toBe("null");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("Windows helper command lines", () => {
  for (const command of [
    "C:\\bun\\bun.exe C:\\Repo\\skills\\drive-pr\\scripts\\drive-status.ts",
    '"C:\\Program Files\\bun.exe" "C:\\My Repo\\skills\\drive-pr\\scripts\\drive-status.ts" --json',
  ]) {
    it(`excludes ${command}`, () =>
      expect(findPassChild(1, [{ pid: 2, ppid: 1, args: command }])).toBe(
        false,
      ));
  }
  it("a quoted Windows pass argument mentioning a helper remains a pass", () => {
    expect(
      findPassChild(1, [
        {
          pid: 2,
          ppid: 1,
          args: '"C:\\Program Files\\bun.exe" "C:\\My Repo\\pass.ts" relative\\skills\\drive-pr\\scripts\\drive-status.ts',
        },
      ]),
    ).toBe(true);
  });
});
