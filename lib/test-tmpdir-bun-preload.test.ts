/**
 * Watch-mode containment for the preload adapter.
 *
 * `bun test --watch` reuses one process across file-change cycles, so a
 * module-level scope released by `afterAll` could stay exhausted for every
 * cycle after the first: unscoped, leaking into the real system tmpdir. It
 * does not: Bun re-evaluates the ENTIRE preload module, top-level code
 * included, on every watch cycle, so a fresh scope is created before each
 * cycle's tests run. This pins that measured behavior so a future Bun upgrade
 * that changes reload semantics is caught rather than silently reintroducing
 * the leak.
 *
 * Synchronizes on the child's own stdout rather than fixed sleeps:
 * a loaded host can make either watch cycle take longer than a guessed
 * delay, which would either read cycle 1's output before it's flushed or
 * read into cycle 2 before triggering it — neither failure means bun's
 * reload semantics regressed.
 */

import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ReadableStreamReadResult } from "node:stream/web";
import { scopeTestTmpdir } from "./test-tmpdir.ts";

const PRELOAD_PATH = join(import.meta.dir, "test-tmpdir-bun-preload.ts");
const CYCLE_MARKER = "CYCLE_ROOT=";
// `[^\r\n]+`, not `\S+`: a real temp path can contain whitespace (a macOS
// user directory, a Windows profile path), which `\S+` would truncate,
// making `isContainedIn` below report a false containment break. The line
// terminator is required: a read can end mid-line, and a partial path must not
// count as a marker until the rest of it arrives.
const CYCLE_MARKER_RE = new RegExp(`${CYCLE_MARKER}([^\\r\\n]+)\\r?\\n`, "g");

const PROBE_SOURCE = `import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
test('probe', () => {
  console.log('${CYCLE_MARKER}' + tmpdir());
  expect(1).toBe(1);
});
`;

/**
 * True when `child` is genuinely inside `parent` — unlike a raw
 * `startsWith`, which a sibling directory sharing a name prefix (e.g.
 * `${parent}-escaped/...`) would satisfy without being contained at all
 */
function isContainedIn(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Reads `stream` until at least `count` `CYCLE_MARKER` lines have appeared in
 * the accumulated output (across however many calls share `state`), or
 * `deadlineMs` elapses. Returns every root seen so far — the caller decides
 * whether that count is enough.
 */
async function readMarkersUntil(
  reader: { read(): Promise<ReadableStreamReadResult<Uint8Array>> },
  decoder: TextDecoder,
  state: { output: string },
  count: number,
  deadlineMs: number,
): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const roots = [...state.output.matchAll(CYCLE_MARKER_RE)].map(
      (m) => m[1] ?? "",
    );
    if (roots.length >= count) return roots;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return roots;

    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => null),
    ]);
    if (result === null) {
      return [...state.output.matchAll(CYCLE_MARKER_RE)].map((m) => m[1] ?? "");
    }
    const { value, done } = result;
    if (done)
      return [...state.output.matchAll(CYCLE_MARKER_RE)].map((m) => m[1] ?? "");
    state.output += decoder.decode(value, { stream: true });
  }
}

const outerScope = scopeTestTmpdir();
afterAll(() => outerScope.release());

// Each watch cycle gets its own deadline so a slow one doesn't starve the
// other; the enclosing test timeout must comfortably exceed BOTH of those
// plus setup/teardown, or a host slow enough to need every second of both
// per-cycle deadlines still times out the whole test even though neither
// cycle itself was late.
const PER_CYCLE_DEADLINE_MS = 15_000;
const TEST_TIMEOUT_MS = 2 * PER_CYCLE_DEADLINE_MS + 15_000;

async function removeAfterExit(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "") ||
        Date.now() >= deadline
      )
        throw error;
      // Windows can retain directory handles briefly after the child exits.
      // Yield between attempts instead of relying on synchronous retry options.
      await Bun.sleep(100);
    }
  }
}

it(
  "the preload scopes every watch cycle, not just the first",
  async () => {
    // A dedicated fake "system" tmpdir for the CHILD process, so the
    // assertions below are about what this test controls rather than
    // whatever this outer process's own scope happens to be.
    const fakeSystemTmpdir = mkdtempSync(join(outerScope.root, "fake-system."));
    const fixtureDir = mkdtempSync(join(outerScope.root, "watch-fixture."));
    // A JSON string literal is a valid TOML basic string (backslash, quote and
    // control-character escapes are shared), so a checkout path containing any
    // of them cannot end the value early or corrupt the fixture.
    writeFileSync(
      join(fixtureDir, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(PRELOAD_PATH)}]\n`,
    );
    writeFileSync(join(fixtureDir, "probe.test.ts"), PROBE_SOURCE);

    const proc = Bun.spawn(["bun", "test", "--watch", "probe.test.ts"], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        TMPDIR: fakeSystemTmpdir,
        TMP: fakeSystemTmpdir,
        TEMP: fakeSystemTmpdir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const state = { output: "" };

    try {
      // Cycle 1: wait for the initial run's marker rather than guessing how
      // long it takes.
      const afterCycle1 = await readMarkersUntil(
        reader,
        decoder,
        state,
        1,
        PER_CYCLE_DEADLINE_MS,
      );
      expect(afterCycle1.length).toBe(1);

      // Trigger cycle 2 the same way a developer editing the file would.
      writeFileSync(
        join(fixtureDir, "probe.test.ts"),
        `${PROBE_SOURCE}// touch\n`,
      );
      const roots = await readMarkersUntil(
        reader,
        decoder,
        state,
        2,
        PER_CYCLE_DEADLINE_MS,
      );

      expect(roots.length).toBe(2);
      const [cycle1 = "", cycle2 = ""] = roots;

      // Both cycles must be genuinely CONTAINED under the fake system tmpdir
      // the child was launched with — a raw `startsWith` would pass for a
      // sibling directory whose name happens to share the prefix (e.g.
      // `${fakeSystemTmpdir}-escaped/...`), which is not containment.
      expect(isContainedIn(fakeSystemTmpdir, cycle1)).toBe(true);
      expect(isContainedIn(fakeSystemTmpdir, cycle2)).toBe(true);

      // What a regression in this reload behavior would look like: cycle 2
      // falling back to the restored (unscoped) value instead of a fresh
      // root — caught by the two assertions above — and/or the two cycles
      // collapsing to the same root.
      expect(cycle1).not.toBe(cycle2);
    } finally {
      // A timed-out readMarkersUntil() call can leave a `reader.read()`
      // still pending — releaseLock() throws in that case. Process
      // termination and directory cleanup must happen regardless, so they
      // are never gated on it.
      try {
        reader.releaseLock();
      } catch {
        // Swallowed: proc.kill() below settles the pending read either way.
      }
      proc.kill();
      await proc.exited;
      await removeAfterExit(fixtureDir);
      await removeAfterExit(fakeSystemTmpdir);
    }
  },
  TEST_TIMEOUT_MS,
);
