/**
 * scripts-proc.test.ts — how `lib/proc.ts`'s `run()` ends a child: a
 * cancellation delivered to a script reaches its deadlined child and the
 * thread mutation in flight, and the output cap and the deadline stop
 * capturing a runaway child through the SIGKILL grace.
 *
 * Each probe spawns a separate process and signals or outlasts it, so these
 * are end-to-end by necessity — run with `--timeout 30000`.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "../../../shared/guarded-git-spawn.ts";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  SCRIPTS,
  IN_FLIGHT_SEC,
  OUTLIVE_IN_FLIGHT_MS,
  checkedSpawn,
  binDir,
  repoDir,
  gitCleanEnv,
  thread,
  writeFixture,
  useStubForge,
} from "./scripts-harness.ts";

useStubForge();

// ── Cancellation forwarding (TASK) ──────────────────────────────────────

/**
 * A deadlined child is DETACHED into its own process group so the deadline can
 * kill the whole tree. That isolation also puts it beyond the reach of a signal
 * delivered to this process, or to its group — so without `lib/proc.ts`'s
 * source-time forwarding, terminating `await-round.ts` / `converge.ts` /
 * `reply-to-thread.ts` leaves the in-flight `gh` running to completion and the
 * GraphQL mutation lands after the operator believes the operation was
 * cancelled.
 *
 * These are the only probes in this file that assert on a signal, so they are
 * end-to-end by necessity: the claim is about what a SEPARATE process does when
 * the kernel delivers it a TERM, which no in-process assertion can reach. Each
 * spawns a fixture that starts a deadlined grandchild, waits for that
 * grandchild to prove itself live, TERMs the fixture, and asserts on what the
 * grandchild did NOT go on to do.
 */
describe.skipIf(process.platform === "win32")(
  "cancellation reaches a deadlined child (TASK)",
  () => {
    const PROC = join(SCRIPTS, "lib", "proc.ts");

    /** Wait up to five seconds for `path` to appear; throw `failure` if not. */
    async function awaitMarker(path: string, failure: string): Promise<void> {
      for (let i = 0; i < 200 && !existsSync(path); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!existsSync(path)) throw new Error(failure);
    }

    interface Probe {
      /** Did the grandchild run to completion after the fixture was killed? */
      completed: boolean;
      /** Did the fixture's OWN handler run? */
      ownHandlerRan: boolean;
      /** Signal the fixture died from, if any. */
      signal: string | null;
      code: number | null;
    }

    /**
     * Run one probe. `ownHandler` installs a caller handler in the fixture, so a
     * single fixture covers both the forwarding claim and the guarantee that
     * a caller's own handlers survive.
     */
    async function probe(opts: { ownHandler: boolean }): Promise<Probe> {
      const dir = mkdtempSync(join(tmpdir(), "rrc-cancel-"));
      const live = join(dir, "live");
      const completed = join(dir, "completed");
      const ownRan = join(dir, "own-handler-ran");
      // The grandchild announces itself LIVE before sleeping, so the probe never
      // races the spawn: a TERM delivered before the child existed would leave
      // nothing to forward to and pass vacuously.
      const script = `: > ${JSON.stringify(live)}; sleep ${IN_FLIGHT_SEC}; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(PROC)};`,
          `import { writeFileSync } from 'node:fs';`,
          opts.ownHandler
            ? `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(ownRan)}, ''); process.exit(9); });`
            : "",
          `await run(['bash', '-c', ${JSON.stringify(script)}], { timeoutSec: 60 });`,
        ].join("\n"),
      );

      const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        stdio: "ignore",
      });
      const ended = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(live); i++) await sleep(25);
      const wasLive = existsSync(live);
      child.kill("SIGTERM");
      const exit = await ended;
      // Outlive the grandchild's own sleep: the assertion is that it never
      // completes, which is only meaningful once it would have.
      await sleep(OUTLIVE_IN_FLIGHT_MS);

      const result: Probe = {
        completed: existsSync(completed),
        ownHandlerRan: existsSync(ownRan),
        signal: exit.signal,
        code: exit.code,
      };
      rmSync(dir, { recursive: true, force: true });
      // Folded into the returned shape rather than asserted here, so a fixture
      // that never got its child running fails the caller's expectation loudly
      // instead of silently satisfying `completed: false`.
      if (!wasLive) throw new Error("probe grandchild never became live");
      return result;
    }

    it("kills the in-flight child instead of letting it complete", async () => {
      const r = await probe({ ownHandler: false });
      expect({ completed: r.completed, signal: r.signal }).toEqual({
        completed: false,
        // Re-raised: with no caller handler the forwarding removes itself and
        // signals this process again, so it dies from the TERM exactly as it
        // would have with no handler installed. That is what keeps a
        // cancellation unmaskable by a caller that swallowed the RunResult.
        signal: "SIGTERM",
      });
    });

    it("preserves the caller's own handler while still killing the child", async () => {
      const r = await probe({ ownHandler: true });
      expect({
        completed: r.completed,
        ownHandlerRan: r.ownHandlerRan,
        code: r.code,
      }).toEqual({
        completed: false,
        ownHandlerRan: true,
        // The caller's handler owns the outcome once it exists — no re-raise, and
        // its own exit code, not the signal's.
        code: 9,
      });
    });

    it("keeps forwarding a second signal when the caller handler does not exit", async () => {
      // Regression for the bug this TASK hardening fixed: `forward` used to
      // remove itself unconditionally after the FIRST occurrence of a signal,
      // regardless of whether other listeners were still present. A caller that
      // handles or debounces a signal without exiting — modelled here by an own
      // handler that never calls `process.exit()` — silently regained the
      // original unforwarded-cancellation bug for every signal after the first.
      // Two deadlined children run in sequence so the SECOND SIGTERM has a live
      // tracked group to prove was (or was not) forwarded.
      const dir = mkdtempSync(join(tmpdir(), "rrc-cancel-repeat-"));
      const liveA = join(dir, "liveA");
      const completedA = join(dir, "completedA");
      const liveB = join(dir, "liveB");
      const completedB = join(dir, "completedB");
      const phase2 = join(dir, "phase2-ready");
      const scriptA = `: > ${JSON.stringify(liveA)}; sleep ${IN_FLIGHT_SEC}; : > ${JSON.stringify(completedA)}`;
      const scriptB = `: > ${JSON.stringify(liveB)}; sleep ${IN_FLIGHT_SEC}; : > ${JSON.stringify(completedB)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(PROC)};`,
          `import { writeFileSync } from 'node:fs';`,
          `process.on('SIGTERM', () => {});`,
          `async function main() {`,
          `  await run(['bash', '-c', ${JSON.stringify(scriptA)}], { timeoutSec: 60 });`,
          `  writeFileSync(${JSON.stringify(phase2)}, '');`,
          `  await run(['bash', '-c', ${JSON.stringify(scriptB)}], { timeoutSec: 60 });`,
          `}`,
          `main();`,
        ].join("\n"),
      );

      const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        stdio: "ignore",
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        await awaitMarker(liveA, "fixture child A never became live");
        child.kill("SIGTERM");

        await awaitMarker(
          phase2,
          "fixture did not resume after the first SIGTERM",
        );

        await awaitMarker(liveB, "fixture child B never became live");
        child.kill("SIGTERM");

        // Outlive child B's own sleep: the assertion is that it never
        // completes, which is only meaningful once it would have.
        await sleep(OUTLIVE_IN_FLIGHT_MS);

        expect(existsSync(completedA)).toBe(false);
        expect(existsSync(completedB)).toBe(false);
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The consequential case, asserted at its own emission site rather than only
    // through the library: a reply that posts after the operator cancelled is a
    // thread classified — and a reviewer-scoring sample corrupted — on an
    // operation they believe never ran.
    it("does not let reply-to-thread.ts's mutation land after cancellation", async () => {
      const fix = writeFixture({ threads: [thread("PRRT_x")] });
      writeFileSync(join(fix.dir, "graphql-slow"), "");
      const started = join(fix.dir, "graphql-started");

      const child = spawn(
        process.execPath,
        [join(SCRIPTS, "reply-to-thread.ts"), "PRRT_x"],
        {
          cwd: repoDir,
          stdio: ["pipe", "ignore", "ignore"],
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            RRC_FIX: fix.dir,
            GH_CALL_TIMEOUT: "60",
          },
        },
      );
      child.stdin?.end("**accepted** — fixed in abc1234.\n");
      const ended = new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(started); i++) await nap(25);
      // Non-vacuous: the mutation must actually be IN FLIGHT when the TERM lands,
      // or "it never posted" would be true for the wrong reason.
      expect(existsSync(started)).toBe(true);

      child.kill("SIGTERM");
      await ended;
      // Outlive the stub's own delay: the claim is that the post never happens,
      // which is only meaningful once it otherwise would have.
      await nap(OUTLIVE_IN_FLIGHT_MS);

      // Read straight off the stub's own record rather than through
      // `postedBodies` (which is scoped to the reply-to-thread describe): the
      // claim here is that NO document was posted at all, so the absence of the
      // file is the whole assertion.
      expect(
        readdirSync(fix.dir).filter((f) => f.startsWith("graphql-input-")),
      ).toEqual([]);
    });
  },
);

// ── Cancellation forwarding — the gh.ts sibling path (TASK) ─────────────

/**
 * `ghOrExit()` used to spawn `gh` with `spawnSync`: the child was not
 * detached, and the parent could not run a JS signal handler while blocked in
 * the syscall, so a SIGTERM delivered to `resolve-thread.ts` /
 * `unresolve-thread.ts` directly (not through drive-pr's `run()`, which
 * detaches and forwards — see the TASK block above) killed the parent at
 * kernel level and left the `gh` mutation running to completion. Same shape
 * as the TASK probe: start a deadlined mutation, wait for it to be
 * IN FLIGHT, TERM the script, and assert the mutation never landed.
 */
describe.skipIf(process.platform === "win32")(
  "cancellation reaches gh.ts mutations directly (TASK)",
  () => {
    async function probeMutationCancelled(
      script: "resolve-thread.ts" | "unresolve-thread.ts",
    ): Promise<void> {
      const fix = writeFixture({ threads: [thread("PRRT_x")] });
      writeFileSync(join(fix.dir, "graphql-slow"), "");
      const started = join(fix.dir, "graphql-started");

      const child = spawn(process.execPath, [join(SCRIPTS, script), "PRRT_x"], {
        cwd: repoDir,
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          RRC_FIX: fix.dir,
          GH_CALL_TIMEOUT: "60",
        },
      });
      const ended = new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(started); i++) await nap(25);
      // Non-vacuous: the mutation must actually be IN FLIGHT when the TERM
      // lands, or "it never landed" would be true for the wrong reason.
      expect(existsSync(started)).toBe(true);

      child.kill("SIGTERM");
      await ended;
      // Outlive the stub's own delay: the claim is that the mutation never
      // lands, which is only meaningful once it otherwise would have.
      await nap(OUTLIVE_IN_FLIGHT_MS);

      expect(
        readdirSync(fix.dir).filter((f) => f.startsWith("graphql-mutation-")),
      ).toEqual([]);
    }

    it("does not let resolve-thread.ts's mutation land after a direct TERM", async () => {
      await probeMutationCancelled("resolve-thread.ts");
    });

    it("does not let unresolve-thread.ts's mutation land after a direct TERM", async () => {
      await probeMutationCancelled("unresolve-thread.ts");
    });
  },
);

// ── Buffer cap ──────────────────────────────────────────────────────────────

/**
 * `run()`'s `data` handlers used to accumulate stdout/stderr with no bound at
 * all once `ghOrExit` moved off `spawnSync`'s own `maxBuffer`. A child that
 * keeps writing is killed on a byte trigger the same way a hung one is killed
 * on a clock — this proves the trigger actually fires and actually stops the
 * child, with a `maxBufferBytes` override small enough to hit in-test rather
 * than the real 64 MiB default.
 *
 * "Later chunks are excluded" is asserted directly off `onChunk`'s per-chunk
 * captured/discarded record, not inferred from a captured byte-count bound —
 * a real OS pipe's read chunking varies enough in practice (a single burst
 * measured ~250 KiB here) that any fixed bound is either loose enough to miss
 * a partial regression or tight enough to flake on legitimate variance.
 * Counting discarded chunks sidesteps both.
 */
describe.skipIf(process.platform === "win32")(
  "run()'s output cap kills a runaway child (TASK)",
  () => {
    const MAX_BUFFER_BYTES_TEST = 8192;
    // A sanity ceiling only — not the primary proof (see `discardedChunks`
    // below) — wide enough that legitimate OS pipe chunking variance across
    // machines never trips it, while still ruling out the catastrophic
    // regression class: an UNGUARDED child left running for the same
    // two-second SIGKILL grace this probe exercises captures on the order of a
    // HUNDRED MEGABYTES (measured), thousands of times past this ceiling.
    const SANITY_CEILING = MAX_BUFFER_BYTES_TEST + 4 * 1024 * 1024;

    /**
     * @param ignoreTerm When true, the child traps and swallows SIGTERM so only
     *   the escalation's SIGKILL two seconds later actually ends it — the exact
     *   window in which unguarded capture used to keep growing.
     */
    async function probeBufferCap(opts: {
      ignoreTerm: boolean;
    }): Promise<{ result: Record<string, unknown>; completed: boolean }> {
      const dir = mkdtempSync(join(tmpdir(), "rrc-buffer-"));
      const completed = join(dir, "completed");
      // Writes 1 KiB chunks forever until killed; `completed` only appears if
      // the loop is allowed to finish on its own, which the cap must prevent.
      // A `while` counter at a count high enough that a fast CI runner cannot
      // finish it naturally within the ~2s SIGKILL grace, not `for i in
      // $(seq 1 1000000)`: nothing throttles a discarded-past-the-cap child's
      // write rate (the pipe is drained continuously, just not captured), so a
      // sufficiently fast machine completed 1,000,000 tight-loop iterations —
      // `completed` existed — inside the grace window, failing the assertion
      // that `ignoreTerm: true` is never allowed to finish on its own
      // (measured in CI, not locally). A count also high enough that
      // `$(seq ...)` would materialise the whole number list before the loop's
      // first write, which the `while` form avoids.
      const trap = opts.ignoreTerm ? "trap '' TERM; " : "";
      const script = `${trap}i=0; while [ "$i" -lt 100000000 ]; do printf '%01024d' 0; i=$((i + 1)); done; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(join(SCRIPTS, "lib", "proc.ts"))};`,
          `let discardedChunks = 0;`,
          `let discardedBytes = 0;`,
          `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
          `  timeoutSec: 60,`,
          `  maxBufferBytes: ${MAX_BUFFER_BYTES_TEST},`,
          `  onChunk: (_stream, bytes, captured) => {`,
          `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
          `  },`,
          `});`,
          `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
        ].join("\n"),
      );

      const out = checkedSpawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        encoding: "utf8",
        timeout: 15_000,
      });
      const result = JSON.parse(out);
      const stillCompleted = existsSync(completed);
      rmSync(dir, { recursive: true, force: true });
      return { result, completed: stillCompleted };
    }

    it("kills the child and reports bufferExceeded once captured output crosses the cap", async () => {
      const { result, completed } = await probeBufferCap({ ignoreTerm: false });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed,
      }).toEqual({
        code: 1,
        timedOut: false,
        bufferExceeded: true,
        completed: false,
      });
      expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
    });

    it("discards every chunk offered after the cap trips, even when the child ignores SIGTERM through the SIGKILL grace", async () => {
      const { result, completed } = await probeBufferCap({ ignoreTerm: true });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed,
      }).toEqual({
        code: 1,
        timedOut: false,
        bufferExceeded: true,
        completed: false,
      });
      // The child kept writing for the whole two-second grace before SIGKILL
      // landed, so `onChunk` must have SEEN further chunks arrive — and this is
      // the direct proof they were rejected rather than captured: not "capture
      // happened to stay small", but "chunks offered past the cap were counted
      // and discarded".
      expect(result.discardedChunks as number).toBeGreaterThan(0);
      expect(result.discardedBytes as number).toBeGreaterThan(0);
      expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
    });

    it("also stops capturing once the DEADLINE (not the buffer cap) trips, through its own SIGKILL grace", async () => {
      // The capture guard used to key only on `bufferExceeded`, so a child that
      // hits the DEADLINE first kept being captured for the whole two-second
      // deadline escalation — an 8 KiB cap stayed unenforced against a
      // multi-megabyte post-timeout flood.
      //
      // A THROTTLED writer, not the tight loop the buffer-cap probes above use:
      // an earlier version of this probe let that tight loop run unthrottled
      // under a 1 GiB `maxBufferBytes` so only the deadline (never 1 GiB) could
      // trigger — but the loop's own measured ~100+ MB/s rate meant `r.stdout`
      // legitimately retained tens to hundreds of megabytes for the whole test,
      // real memory pressure this suite doesn't need, and on a fast enough or
      // memory-constrained runner it could OOM, or cross even 1 GiB before the
      // 1-second deadline and flip `bufferExceeded` instead of `timedOut`,
      // failing the very assertion below it. A small, slow, bounded write
      // rate proves the exact same thing — chunks arriving during the
      // deadline's escalation are discarded — without either risk: total
      // captured output here is on the order of kilobytes, several orders of
      // magnitude under any buffer cap this test would plausibly configure.
      const dir = mkdtempSync(join(tmpdir(), "rrc-buffer-"));
      const completed = join(dir, "completed");
      // ~50 writes/sec of 64 bytes each — keeps going (SIGTERM trapped) through
      // the full 1s deadline and the grace after it, but never accumulates more than a few
      // hundred bytes before the deadline and a similar amount discarded after.
      const script = `trap '' TERM; while true; do printf '%064d' 0; sleep 0.02; done; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(join(SCRIPTS, "lib", "proc.ts"))};`,
          `let discardedChunks = 0;`,
          `let discardedBytes = 0;`,
          `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
          `  timeoutSec: 1,`,
          `  onChunk: (_stream, bytes, captured) => {`,
          `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
          `  },`,
          `});`,
          `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
        ].join("\n"),
      );

      const out = checkedSpawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        // The deadline's grace shortened from its production two seconds:
        // still long enough for the throttled writer to offer chunks in it.
        env: { ...gitCleanEnv(), RRC_DEADLINE_GRACE_MS: "500" },
        encoding: "utf8",
        timeout: 15_000,
      });
      const result = JSON.parse(out);
      const stillCompleted = existsSync(completed);
      rmSync(dir, { recursive: true, force: true });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed: stillCompleted,
      }).toEqual({
        code: 124,
        timedOut: true,
        bufferExceeded: false,
        completed: false,
      });
      // The child kept writing through the deadline's own grace, so `onChunk`
      // must have seen — and discarded — further chunks.
      expect(result.discardedChunks as number).toBeGreaterThan(0);
      expect(result.discardedBytes as number).toBeGreaterThan(0);
      // Sanity, not the primary proof: at ~50 writes/sec this stays a few
      // hundred bytes over the deadline and its grace, nowhere near a real cap.
      expect(result.stdoutLength as number).toBeLessThan(64 * 1024);
    });
  },
);
