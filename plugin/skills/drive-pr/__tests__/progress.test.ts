/**
 * progress.test.ts — `DriveState.lastProgressAt`/`quotaPark`,
 * `withProgress`, and the `drive-state.ts` verbs that stamp (or deliberately
 * do NOT stamp) them.
 *
 * WHY A SEPARATE FILE rather than folding this into `drive-pr.test.ts`
 * (already 17k+ lines and the repo's own highest-churn file — see
 * `references/consistency.md`). This is a self-contained new
 * concern with its own fixture needs (a `freshState`-based state file, not
 * the giant file's shared reviewer/PR-snapshot fixtures), and keeping it
 * separate means a future change to progress semantics touches one small
 * file instead of adding another chapter to the largest one in the skill.
 *
 * SCHEMA-LEVEL TESTS build state objects directly (no subprocess) and drive
 * `isUsableState`/`withProgress` as pure functions. CLI-LEVEL tests spawn
 * `drive-state.ts` for real, the same pattern `drive-pr.test.ts`'s own
 * `state` helper uses, with a `freshState`-seeded fixture file so every
 * required field is present by construction rather than hand-enumerated
 * (the hand-enumeration risk this avoids: a fixture missing a field this
 * suite doesn't yet know about silently fails `isUsableState` for a reason
 * unrelated to what the test is actually about).
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DriveState,
  freshState,
  isUsableState,
  withProgress,
} from "../scripts/lib/state/schema.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const DRIVE_STATE = join(SCRIPTS, "drive-state.ts");
const DRIVE = join(SCRIPTS, "drive.ts");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  // Scrubs any inherited GIT_* from the suite's own invocation (a git hook,
  // in particular) — the identical hazard `drives.test.ts`'s own `cleanEnv`
  // and `drive-pr.test.ts`'s `gitCleanEnv` document: `resolveActor()` runs
  // `git rev-parse` in the spawned child, and a leaked `GIT_DIR` would
  // resolve it against the wrong repository.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "progress-test-"));
}

function seedState(dir: string, overrides: Partial<DriveState> = {}): void {
  const state: DriveState = { ...freshState(999), ...overrides };
  writeFileSync(join(dir, "drive-pr-999.json"), JSON.stringify(state));
}

function readState(dir: string): DriveState {
  return JSON.parse(
    readFileSync(join(dir, "drive-pr-999.json"), "utf8"),
  ) as DriveState;
}

async function driveState(
  stateDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([DRIVE_STATE, ...args], {
    env: cleanEnv({ DRIVE_PR_STATE_DIR: stateDir }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
}

describe("lib/state/schema.ts — lastProgressAt / quotaPark shape", () => {
  it("freshState defaults to never-progressed, never-parked", () => {
    const s = freshState(999);
    expect(s.lastProgressAt).toBe("");
    expect(s.quotaPark).toBeNull();
  });

  it('isUsableState requires lastProgressAt: "" or a Date.parse-able string', () => {
    const s = freshState(999);
    expect(isUsableState({ ...s, lastProgressAt: "" }, 999)).toBe(true);
    expect(
      isUsableState({ ...s, lastProgressAt: "2026-09-12T00:00:00.000Z" }, 999),
    ).toBe(true);
    expect(isUsableState({ ...s, lastProgressAt: "not a date" }, 999)).toBe(
      false,
    );
    expect(isUsableState({ ...s, lastProgressAt: 123 }, 999)).toBe(false);
  });

  it("a state file missing lastProgressAt/quotaPark entirely is REFUSED, not defaulted", () => {
    const s = freshState(999) as Record<string, unknown>;
    delete s.lastProgressAt;
    delete s.quotaPark;
    expect(isUsableState(s, 999)).toBe(false);
  });

  it("isUsableState validates quotaPark shape: vendor/window non-empty and newline-free, resetAt/at Date.parse-able", () => {
    const s = freshState(999);
    const validPark = {
      vendor: "claude",
      window: "short",
      resetAt: "2026-09-12T13:00:00.000Z",
      at: "2026-09-12T12:00:00.000Z",
    };
    expect(isUsableState({ ...s, quotaPark: validPark }, 999)).toBe(true);
    expect(
      isUsableState({ ...s, quotaPark: { ...validPark, resetAt: null } }, 999),
    ).toBe(true);
    for (const bad of [
      { ...validPark, vendor: "" },
      { ...validPark, vendor: "a\nb" },
      { ...validPark, window: "" },
      { ...validPark, resetAt: "not a date" },
      { ...validPark, at: "not a date" },
      { ...validPark, at: undefined },
    ]) {
      expect(isUsableState({ ...s, quotaPark: bad }, 999)).toBe(false);
    }
  });

  it("withProgress stamps lastProgressAt, sets phase when given, and clears quotaPark", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const s: DriveState = {
      ...freshState(999),
      phase: "old-phase",
      quotaPark: {
        vendor: "claude",
        window: "short",
        resetAt: null,
        at: "2026-09-12T11:00:00.000Z",
      },
    };
    const next = withProgress(s, "round-advanced", now);
    expect(next.lastProgressAt).toBe(now.toISOString());
    expect(next.phase).toBe("round-advanced");
    expect(next.quotaPark).toBeNull();
  });

  it("withProgress with an empty phase preserves the prior phase rather than blanking it", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    const s: DriveState = { ...freshState(999), phase: "push-landed" };
    const next = withProgress(s, "", now);
    expect(next.phase).toBe("push-landed");
    expect(next.lastProgressAt).toBe(now.toISOString());
  });
});

describe("drive-state.ts progress", () => {
  it("stamps lastProgressAt and phase", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const r = await driveState(dir, [
        "progress",
        "999",
        "--phase",
        "pass-spawned",
      ]);
      expect(r.exitCode).toBe(0);
      const s = readState(dir);
      expect(s.lastProgressAt).not.toBe("");
      expect(Number.isFinite(Date.parse(s.lastProgressAt))).toBe(true);
      expect(s.phase).toBe("pass-spawned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty --phase with exit 2", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const r = await driveState(dir, ["progress", "999"]);
      expect(r.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a --phase outside the closed set with exit 2, and does not stamp", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const before = readState(dir).lastProgressAt;
      const r = await driveState(dir, ["progress", "999", "--phase", "typo"]);
      expect(r.exitCode).toBe(2);
      // A misspelled or unauthorized phase must never persist — otherwise it
      // is indistinguishable from the real `pass-spawned` event it was
      // meant to name.
      expect(readState(dir).lastProgressAt).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears a previously recorded quota park", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir, {
        quotaPark: {
          vendor: "codex",
          window: "weekly",
          resetAt: null,
          at: new Date().toISOString(),
        },
      });
      await driveState(dir, ["progress", "999", "--phase", "round-advanced"]);
      expect(readState(dir).quotaPark).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drive-state.ts quota-park", () => {
  it("records vendor/window/resetAt and does NOT stamp progress", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const r = await driveState(dir, [
        "quota-park",
        "999",
        "--vendor",
        "claude",
        "--window",
        "short",
        "--reset-at",
        "2026-09-12T13:00:00.000Z",
      ]);
      expect(r.exitCode).toBe(0);
      const s = readState(dir);
      // The three caller-supplied fields are pinned exactly; `at` is the
      // verb's OWN clock read, so it is asserted to be a real, parseable
      // instant rather than echoed back from the value under test — a
      // `toEqual` carrying `at: s.quotaPark?.at` would assert nothing about
      // it at all (and does not type-check, since `at` is required).
      expect(s.quotaPark?.vendor).toBe("claude");
      expect(s.quotaPark?.window).toBe("short");
      expect(s.quotaPark?.resetAt).toBe("2026-09-12T13:00:00.000Z");
      expect(Number.isFinite(Date.parse(s.quotaPark?.at ?? ""))).toBe(true);
      // Parking is progress's opposite (module header, `schema.ts`) — the
      // stamp must stay untouched.
      expect(s.lastProgressAt).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--reset-at is optional — an unresolvable reset records null", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      await driveState(dir, [
        "quota-park",
        "999",
        "--vendor",
        "codex",
        "--window",
        "weekly",
      ]);
      expect(readState(dir).quotaPark?.resetAt).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires --vendor and --window", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      expect(
        (await driveState(dir, ["quota-park", "999", "--window", "short"]))
          .exitCode,
      ).toBe(2);
      expect(
        (await driveState(dir, ["quota-park", "999", "--vendor", "claude"]))
          .exitCode,
      ).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unparsable --reset-at", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const r = await driveState(dir, [
        "quota-park",
        "999",
        "--vendor",
        "claude",
        "--window",
        "short",
        "--reset-at",
        "not-a-date",
      ]);
      expect(r.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lastProgressAt is written ONLY by genuine progress events", () => {
  it("bump-round (a genuine head advance) stamps progress; a same-head re-bump does not move it again", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      await driveState(dir, ["bump-round", "999", "--head", SHA_A]);
      const first = readState(dir).lastProgressAt;
      expect(first).not.toBe("");

      // A tiny wait so a second, DIFFERENT stamp would be detectably later —
      // otherwise a sub-millisecond re-run could coincidentally produce the
      // same ISO string and this assertion would pass for the wrong reason.
      await new Promise((r) => setTimeout(r, 5));
      await driveState(dir, ["bump-round", "999", "--head", SHA_A]);
      expect(readState(dir).lastProgressAt).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bump-round on a NEW head re-stamps progress to a later instant", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      await driveState(dir, ["bump-round", "999", "--head", SHA_A]);
      const first = readState(dir).lastProgressAt;
      await new Promise((r) => setTimeout(r, 5));
      await driveState(dir, ["bump-round", "999", "--head", SHA_B]);
      const second = readState(dir).lastProgressAt;
      expect(second).not.toBe(first);
      expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bump-attempt (a pass retry on an UNCHANGED head — never a round advance) leaves lastProgressAt untouched", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      await driveState(dir, ["bump-round", "999", "--head", SHA_A]);
      const afterRound = readState(dir).lastProgressAt;
      expect(afterRound).not.toBe("");

      await new Promise((r) => setTimeout(r, 5));
      const r1 = await driveState(dir, [
        "bump-attempt",
        "999",
        "--head",
        SHA_A,
      ]);
      expect(r1.exitCode).toBe(0);
      const r2 = await driveState(dir, [
        "bump-attempt",
        "999",
        "--head",
        SHA_A,
      ]);
      expect(r2.exitCode).toBe(0);
      // Neither a fresh bump-attempt nor a repeat is a progress event — the
      // acceptance criterion this test exists to pin.
      expect(readState(dir).lastProgressAt).toBe(afterRound);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release-held --all, past the contended-claim check, stamps progress", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir, {
        held: [
          {
            key: "PRRT_a",
            kind: "thread",
            outcome: "accepted",
            round: 1,
            commentUrl: "https://example.invalid/x",
            actor: "wt-deadbeefdeadbeef",
          },
        ],
      });
      const r = await driveState(dir, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(0);
      const s = readState(dir);
      expect(s.held).toEqual([]);
      expect(s.lastProgressAt).not.toBe("");
      expect(s.phase).toBe("held-drained");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release-held --key on a PRESENT key stamps progress too", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir, {
        held: [
          {
            key: "PRRT_solo",
            kind: "thread",
            outcome: "accepted",
            round: 1,
            commentUrl: "https://example.invalid/solo",
            actor: "wt-deadbeefdeadbeef",
          },
        ],
      });
      const r = await driveState(dir, [
        "release-held",
        "999",
        "--key",
        "PRRT_solo",
      ]);
      expect(r.exitCode).toBe(0);
      const s = readState(dir);
      expect(s.held).toEqual([]);
      expect(s.lastProgressAt).not.toBe("");
      expect(s.phase).toBe("held-drained");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release-held --all on an ALREADY-EMPTY batch is a genuine no-op — no progress stamp", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir); // no `held` override — starts empty
      const before = readState(dir).lastProgressAt;
      const r = await driveState(dir, ["release-held", "999", "--all"]);
      expect(r.exitCode).toBe(0);
      // Nothing changed, so this must read exactly like the `--key
      // --if-present` no-op above — a repeated or spurious `--all` call must
      // not manufacture progress that conceals a real stall from `--doctor`.
      expect(readState(dir).lastProgressAt).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release-held --key on a MISSING key with --if-present is a genuine no-op — no progress stamp", async () => {
    const dir = freshStateDir();
    try {
      seedState(dir);
      const before = readState(dir).lastProgressAt;
      const r = await driveState(dir, [
        "release-held",
        "999",
        "--key",
        "PRRT_missing",
        "--if-present",
      ]);
      expect(r.exitCode).toBe(0);
      expect(readState(dir).lastProgressAt).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drive.ts — the claim-refresh timer never opens the state store (structural)", () => {
  // A GENUINE progress event is stamped through the named `progress`/
  // `bump-round`/etc. verbs ABOVE — never by the background heartbeat that
  // keeps a driver's LOCK claim fresh. This is a structural property of
  // `touchLock`/`startHeartbeat`'s own function bodies, not something an
  // end-to-end test could observe directly (the timer's whole job is to run
  // independently of any round), so it is pinned by reading the source: under
  // "parse or pin" (parse a structured format, or pin its exact text), a text
  // scan over a KNOWN, small function body — bounded by its own opening/closing
  // brace count reaching zero, not by an arbitrary line window — is the pin,
  // not a guess at where the function happens to end today.
  const source = readFileSync(DRIVE, "utf8");

  function extractFunctionBody(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    if (start === -1) {
      throw new Error(
        `extractFunctionBody: no 'function ${name}(' in drive.ts`,
      );
    }
    const braceStart = source.indexOf("{", start);
    if (braceStart === -1) {
      throw new Error(`extractFunctionBody: no body found for ${name}`);
    }
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(braceStart, i + 1);
      }
    }
    throw new Error(`extractFunctionBody: unbalanced braces for ${name}`);
  }

  // The `openStore`/`store.` checks alone would still PASS a heartbeat that
  // shelled out to `drive-state.ts progress` directly (`run(tsArgv(driveState,
  // ['progress', ...]))`) instead of touching the store in-process — that call
  // mentions neither.
  // Closing the gap needs the ACTUAL infrastructure such a call would need:
  // the `driveState` script-path variable, the `tsArgv` argv-builder, and
  // the quoted verb name itself. A bare `.not.toContain('progress')` was
  // tried first and rejected — `touchLock`'s own comments use the English
  // word "progress" ("no sleep in progress"), which is not evidence of
  // anything and made that assertion fail on the UNMODIFIED function.
  function assertNoProgressStampInfrastructure(body: string): void {
    expect(body).not.toContain("openStore");
    expect(body).not.toMatch(/\bstore\./);
    expect(body).not.toContain("driveState");
    expect(body).not.toContain("tsArgv");
    expect(body).not.toContain("'progress'");
  }

  it("touchLock never references openStore, a state store call, or a progress-stamping subprocess", () => {
    assertNoProgressStampInfrastructure(extractFunctionBody("touchLock"));
  });

  it("noteTakeover, which touchLock calls, never references openStore, a state store call, or a progress-stamping subprocess", () => {
    assertNoProgressStampInfrastructure(extractFunctionBody("noteTakeover"));
  });

  it("startHeartbeat never references openStore, a state store call, or a progress-stamping subprocess", () => {
    assertNoProgressStampInfrastructure(extractFunctionBody("startHeartbeat"));
  });

  // The denylist above is a readable diagnostic, not the actual gate — under
  // "parse or pin" (parse a structured format, or pin its exact text), a fixed
  // substring list is defeated indefinitely: a one-line call to a
  // DIFFERENTLY-NAMED helper (e.g. a `stampHeartbeatProgress()` defined
  // elsewhere in this file that itself calls `store.update` or shells out to
  // `drive-state.ts progress`) would contain none of the five forbidden
  // substrings and pass while the invariant this whole `describe` block exists
  // to protect is broken. An AST/call-graph-aware assertion would have to
  // resolve an unbounded chain of intermediate helper calls to close this for
  // good, so the tractable alternative the same rule sanctions is a VERBATIM
  // pin: these two bodies, captured byte-for-byte below, so ANY new statement —
  // under any name — shows up as a diff against a known-good snapshot rather
  // than a silent pass. A change to either function (even an unrelated comment
  // edit) now requires deliberately updating the pin, which is the point: it
  // forces a human to look.
  const TOUCH_LOCK_GOLDEN = `{
  if (lock.nonce === undefined) return; // never taken
  const claim = join(lock.dir, claimName(lock.nonce));
  const now = Date.now() / 1000;
  try {
    utimesSync(claim, now, now);
    return;
  } catch {
    if (existsSync(claim)) return; // transient: the claim is still ours
  }
  // Our GENERATION is gone, so another driver recovered this path while we
  // believed we held it. A drive that keeps going from here is the second
  // driver the lock exists to prevent, so record it and let the loop stop;
  // \`release\` will not touch the successor's lock, because the only name it
  // removes is ours.
  noteTakeover(lock);
}`;

  const NOTE_TAKEOVER_GOLDEN = `{
  if (compromised !== "") return;
  compromised = lock.what;
  void stopActivePass(\`the \${lock.what} lock was recovered by another driver\`);
  quotaSleepAbort?.abort();
}`;

  const START_HEARTBEAT_GOLDEN = `{
  const timer = setInterval(() => {
    for (const lock of locks) touchLock(lock);
    if (compromised === "" && activePass === null) {
      refreshAccountIdentity(locks, passArgv);
    }
  }, heartbeatRefreshMs());
  timer.unref?.();
}`;

  it("touchLock body is byte-for-byte the reviewed snapshot — closes the differently-named-helper gap the denylist above cannot", () => {
    expect(extractFunctionBody("touchLock")).toBe(TOUCH_LOCK_GOLDEN);
  });

  it("noteTakeover body is byte-for-byte the reviewed snapshot — touchLock's one callee is pinned like touchLock itself", () => {
    expect(extractFunctionBody("noteTakeover")).toBe(NOTE_TAKEOVER_GOLDEN);
  });

  it("startHeartbeat body is byte-for-byte the reviewed snapshot — closes the differently-named-helper gap the denylist above cannot", () => {
    expect(extractFunctionBody("startHeartbeat")).toBe(START_HEARTBEAT_GOLDEN);
  });

  it("sanity: extractFunctionBody actually finds a non-trivial body (guards against a silently-passing empty match)", () => {
    // Fail closed: a parser that "found nothing" must not
    // read as a clean result — assert the extracted body has real content,
    // so a rename of `touchLock`/`startHeartbeat` reddens this test instead
    // of leaving the two checks above vacuously true forever.
    expect(extractFunctionBody("touchLock").length).toBeGreaterThan(80);
    expect(extractFunctionBody("startHeartbeat").length).toBeGreaterThan(80);
  });
});
