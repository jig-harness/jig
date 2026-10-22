import { scopedStateDir } from "./scoped-state-dir.ts";
import { plantRetirableQuarantine } from "./reap-entry-fixture.ts";
/**
 * reap-state.test.ts — the sweep of drive-pr's artifacts in its per-clone
 * state directory (by default `~/.local/state/jig/drive-pr/<cloneKey>/`).
 *
 * What these tests are FOR is worth stating explicitly, because the script's
 * failure modes are asymmetric.
 *
 * Retiring a family too EARLY deletes a live driver's state out from under it,
 * and the blast radius is a lost parked human decision — the exact failure the
 * whole lock/lease apparatus exists to prevent. So every fail-closed branch
 * gets its own test with the gate genuinely unsatisfiable (a `gh` that errors,
 * a lease that is live, an mtime inside the guard), never a stand-in that
 * merely happens to reach the same line.
 *
 * Retiring too LATE costs one more weekly run, so the tests do not pin "this
 * family must go" beyond the cases the predicate is specified for.
 *
 * `gh` is a real executable on a scratch PATH rather than a mocked module:
 * `ghCall` is a deliberate chokepoint with its own guardrail test asserting
 * every outbound call goes through it, and a module mock would pass whether or
 * not the script actually routed through the deadline. `git worktree list` is
 * answered by a REAL temp repository for the same reason — the actor predicate
 * is `sha256(toplevel)`, and a fake that echoes a canned path would prove the
 * hashing agrees with itself rather than with `lib/state/actor.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, delimiter, basename } from "node:path";
import {
  anchorOf,
  classify,
  isSnapshotArtifact,
} from "../scripts/lib/state/artifacts.ts";
import { MIGRATED_MARKER_FILENAME } from "../scripts/lib/state/legacy-state.ts";
import { sweepLockQuarantine } from "../scripts/lib/state/lock.ts";
import {
  anchorStillNeedsCompaction,
  computeAlreadyRelocated,
  entryCountWarningFor,
  resolveRealPathBestEffort,
  retirementStillSafe,
} from "../scripts/reap-state.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  compactsDirectoryFences,
  skipLargeCensus,
} from "./reap-state-platform.ts";

const REAP = join(import.meta.dir, "..", "scripts", "reap-state.ts");
const DAY_MS = 86_400_000;

let root: string;
let repo: string;
let repoKey: string;

/**
 * A scratch PATH whose only `gh` is a shim this suite controls.
 *
 * Keyed by the behaviour wanted, one directory per behaviour, so a test never
 * has to rewrite a shim another test is concurrently spawning.
 */
function shimDir(name: string, tools: Record<string, string>): string {
  const dir = join(root, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  for (const [tool, body] of Object.entries(tools)) {
    const p = join(dir, tool);
    writeFakeProgram(
      p,
      `#!/bin/sh\n${tool === "git" ? `if [ "$1" = rev-parse ]; then exec ${JSON.stringify(Bun.which("git"))} "$@"; fi\n` : ""}${body}\n`,
    );
  }
  return dir;
}

function ghShim(name: string, body: string): string {
  return shimDir(name, { gh: body });
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // A suite invoked from a git hook inherits GIT_DIR/GIT_INDEX_FILE, and the
    // `git worktree list` below would then answer for the REAL repository —
    // the same hazard drive-pr.test.ts documents on its own scratch repos.
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  // The reaper also expires local trace days, independently of stateDir.
  return {
    ...env,
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
    ...extra,
  };
}

async function runReap(
  args: string[],
  opts: {
    stateDir: string;
    ghDir?: string;
    cwd?: string;
    env?: Record<string, string>;
  },
) {
  const env = cleanEnv({
    DRIVE_PR_STATE_DIR: opts.stateDir,
    ...(opts.ghDir === undefined
      ? {}
      : { PATH: `${opts.ghDir}${delimiter}${process.env.PATH ?? ""}` }),
    ...opts.env,
  });
  const proc = Bun.spawn([process.execPath, REAP, ...args], {
    cwd: opts.cwd ?? repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function reapJson(
  args: string[],
  opts: { stateDir: string; ghDir?: string; cwd?: string },
) {
  const r = await runReap(["--json", ...args], opts);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as {
    entries: number;
    previousSnapshot: { entries: number; timestampMs: number } | null;
    growthPerDay: number | null;
    entryCountWarning: string | null;
    retire: { id: string; entries: number; reason: string }[];
    keep: { id: string; entries: number; reason: string }[];
    untouched: { foreignLocks: number; unrecognised: number };
    anchorsCompactable: number;
    anchorsCompacted: number;
    entriesRemoved: number;
    entriesRetirable: number;
    revalidationSkipped: { id: string; entries: number; reason: string }[];
  };
}

/** Backdate every entry in `dir` (non-recursively) by `days`. */
function backdate(dir: string, days: number): void {
  const t = new Date(Date.now() - days * DAY_MS);
  for (const n of readdirSync(dir)) utimesSync(join(dir, n), t, t);
}

/**
 * `readdirSync`, minus this reaper's own persisted growth-rate snapshot
 * — every `--delete` run (re)writes it, regardless of whether
 * any family was actually touched, so a test asserting "this specific
 * family's own entries are gone/unchanged" needs to look past that
 * unrelated, always-present bookkeeping file rather than assert the
 * directory is byte-for-byte what it was older.
 */
function entriesOf(dir: string): string[] {
  return readdirSync(dir).filter(
    (n) =>
      n !== ".reap-state-snapshot.json" &&
      // The delete-run lock's own `createLock` family (live lock, its
      // `.recovering` gate, and any quarantine either mints) — every
      // `--delete` invocation in these tests takes and releases it as a
      // side effect, and `anchorOf` recognises the whole family the same
      // way `isReapOwnArtifact` does in the script itself (not exported,
      // since it is exactly this one literal anchor — see `deleteLock`'s
      // own doc comment in reap-state.ts).
      anchorOf(n) !== ".reap-state-delete",
  );
}

/**
 * Plant one quarantine directory in `lock.ts`'s own shape — an `owner.<hex>`
 * marker plus a `tombstone` file — so a compaction assertion is checking the
 * real transition (directory → single empty file at the SAME path) rather than
 * an empty directory that would compact trivially.
 */
function plantQuarantine(stateDir: string, name: string): string {
  const p = join(stateDir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "owner.deadbeefdeadbeefdeadbeef"), "");
  writeFileSync(join(p, "tombstone"), "broken by pid 1\n");
  return p;
}

/** A lease record `readLease` accepts, live or long-dead as asked. */
function leaseJson(
  actor: string,
  pr: string,
  opts: { pid: number; lastSeen: string },
): string {
  return JSON.stringify({
    holder: "session",
    pid: opts.pid,
    host: hostname(),
    platform: process.platform,
    actor,
    worktree: "/elsewhere/tree",
    startedAt: opts.lastSeen,
    lastSeen: opts.lastSeen,
    command: "bump-round",
    generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sessionStarted: "",
    pr,
    revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
}

let n = 0;
function freshStateDir(): string {
  const dir = join(root, `state-${n++}`);
  mkdirSync(dir, { recursive: true });
  return scopedStateDir(dir, repo);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "reap-state-test-"));
  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  // A REAL repository, so `git worktree list --porcelain` answers with a real
  // toplevel and the actor predicate is exercised against the same derivation
  // `lib/state/actor.ts` uses, not a fixture of it.
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "test"],
    ["commit", "-q", "--allow-empty", "-m", "root"],
  ]) {
    const p = Bun.spawn(["git", ...args], {
      cwd: repo,
      env: cleanEnv({}),
      stdout: "ignore",
      stderr: "ignore",
    });
    await p.exited;
  }
  const tl = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: repo,
    env: cleanEnv({}),
    stdout: "pipe",
    stderr: "ignore",
  });
  const toplevel = (await new Response(tl.stdout).text()).trim();
  await tl.exited;
  repoKey = `wt-${createHash("sha256").update(toplevel).digest("hex").slice(0, 16)}`;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const GH_MERGED = () => ghShim("merged", 'echo \'{"state":"MERGED"}\'');
const GH_OPEN = () => ghShim("open", 'echo \'{"state":"OPEN"}\'');
const GH_GONE = () =>
  ghShim("gone", 'echo "no pull requests found" >&2; exit 1');
const GH_BROKEN = () =>
  ghShim("broken", 'echo "dial tcp: connection refused" >&2; exit 1');

describe("anchorOf — lock.ts’s suffix grammar", () => {
  it("recovers the anchor from every shape a lock produces", () => {
    expect(anchorOf("drive-pr-1.json.lock")).toBe("drive-pr-1.json");
    expect(
      anchorOf("drive-pr-1.json.lock.stale.owner.abcdef0123456789abcdef01"),
    ).toBe("drive-pr-1.json");
    expect(anchorOf("drive-pr-1.json.lock.recovering")).toBe("drive-pr-1.json");
    expect(
      anchorOf(
        "drive-pr-1.json.lock.recovering.stale.owner.abcdef0123456789abcdef01",
      ),
    ).toBe("drive-pr-1.json");
  });

  it("unwraps a compaction staging leftover to the family it was staging", () => {
    // Not merely "returns something": a killed compaction's leftover belongs
    // to the SAME family as the entry it was staging, so it retires with that
    // family instead of surviving as an orphan nothing can name an owner for.
    expect(
      anchorOf(
        ".compacting.drive-pr-1.json.lock.stale.owner.abcdef0123456789abcdef01.0123456789abcdef01234567",
      ),
    ).toBe("drive-pr-1.json");
    expect(
      anchorOf(
        ".compacting.drive-pr-1.json.lock.recovering.stale.owner.abcdef0123456789abcdef01.0123456789abcdef01234567",
      ),
    ).toBe("drive-pr-1.json");
  });

  it("rejects a staging wrapper around a payload the protocol never stages", () => {
    // `compactQuarantineEntry` is only ever called on a `.stale.*`/
    // `.recovering.stale.*` entry — never the bare, LIVE `<anchor>.lock` or
    // `<anchor>.lock.recovering` paths — so a genuine staging payload always
    // carries a `.stale.<generation>` suffix. A foreign
    // `.compacting.<anchor>.lock.<24-hex>` wraps what LOOKS like a bare live
    // lock path, which this protocol never produces, and must not resolve to
    // a real anchor.
    expect(
      anchorOf(".compacting.drive-pr-1.json.lock.0123456789abcdef01234567"),
    ).toBeNull();
    expect(
      anchorOf(
        ".compacting.drive-pr-1.json.lock.recovering.0123456789abcdef01234567",
      ),
    ).toBeNull();
  });

  it("answers null for a name that is not part of a lock", () => {
    expect(anchorOf("drive-pr-1.json")).toBeNull();
    expect(anchorOf("drive-pr-1.log")).toBeNull();
    expect(anchorOf("packed-refs")).toBeNull();
  });

  it("backtracks past a `.lock` occurrence whose tail is not one of the documented shapes", () => {
    // `a.lock.b.lock`'s FIRST `.lock` has tail `.b.lock`, which matches none of
    // the documented suffix shapes — the fixed grammar requires the WHOLE
    // remainder to be empty, `.recovering`, `.stale.<gen>`, or
    // `.recovering.stale.<gen>`, so this split point is rejected and the engine
    // backtracks to the LAST `.lock`, whose (empty) tail is the plain
    // `<anchor>.lock` shape. Anchor "a.lock.b", not "a".
    expect(anchorOf("a.lock.b.lock")).toBe("a.lock.b");
  });

  it("rejects a suffix the lock protocol never produces, even though it starts with `.lock`", () => {
    // The bug this pins: the OLD grammar's `(?:\..*)?` tail accepted ANY dotted
    // suffix, so a foreign file like this — never written by
    // createLock/compactQuarantineEntry — was silently attributed to the PR
    // family and would be deleted the moment that family retired, contradicting
    // "this script only ever removes entries it can name the owner of."
    expect(anchorOf("drive-pr-1.json.lock.manual-backup")).toBeNull();
  });

  it("still recognises the `unowned-<mtime>` generation form, not just `owner.<hex>`", () => {
    // `lock.ts`'s own `generationOf` produces `unowned-<mtime>` when a
    // displaced holder left no owner marker to read — a regex narrowed to
    // `owner\.[0-9a-f]+` alone (the reviewer's own suggested one-liner on
    // this exact finding) would have silently stopped recognising this
    // shape, turning every such quarantine entry into `unrecognised` forever.
    expect(anchorOf("drive-pr-1.json.lock.stale.unowned-1234567890123")).toBe(
      "drive-pr-1.json",
    );
    expect(
      anchorOf("drive-pr-1.json.lock.recovering.stale.unowned-1234567890123"),
    ).toBe("drive-pr-1.json");
  });
});

describe("classify — which entries this script will and will not touch", () => {
  const CORPUS = [
    // per-PR anchors and their quarantine
    "drive-pr-4172.json",
    "drive-pr-4172.json.lock",
    "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    "drive-pr-4172.json.lock.recovering.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb",
    "drive-pr-4172.log",
    "drive-pr-4172.ready-claim",
    "drive-pr-4172.ready-claim.released.99999",
    "drive-pr-4172.held-claim.aaa.0123456789abcdef",
    "drive-arm-4172.out",
    "pr-drive-lease-4172-wt-0123456789abcdef.json",
    "pr-drive-lease-4172-wt-0123456789abcdef.json.lock.stale.owner.cccccccccccccccccccccccc",
    "drive-pr-remote-lock-4172.lock.recovering.stale.owner.dddddddddddddddddddddddd",
    ".drive-pr-4172.orphan-warned",
    ".drive-pr-4172.orphan-warned.abandoned.99999",
    "drive-pr-4172.json.a1b2c3",
    "pr-drive-lease-4172-wt-0123456789abcdef.json.a1b2c3",
    // per-worktree anchor and its quarantine
    "drive-tree-lease-wt-0123456789abcdef.json",
    "drive-tree-lease-wt-0123456789abcdef.json.lock.stale.owner.eeeeeeeeeeeeeeeeeeeeeeee",
    "drive-tree-lease-wt-0123456789abcdef.json.a1b2c3",
    // drive.ts's own source-named locks — a DIFFERENT protocol
    "pr-drive-4172.lock",
    "pr-drive-worktree-0123456789abcdef.lock",
    // git's own, and a store this script does not own
    "packed-refs",
    "HEAD",
    "skill-suite-green",
    "worktrees",
    // this reaper's own growth-rate snapshot, and its atomic-write temp-file
    // shape — neither is a backlog entry
    ".reap-state-snapshot.json",
    ".reap-state-snapshot.json.a1b2c3",
    // legacy-state.ts's migration marker — present in
    // every healthy migrated clone, not backlog either
    MIGRATED_MARKER_FILENAME,
  ];

  it("groups every drive-pr entry under the family whose lifecycle governs it", () => {
    const { families } = classify(CORPUS);
    const pr = families.get("pr:4172");
    const actor = families.get("actor:wt-0123456789abcdef");
    expect(pr?.names.sort()).toEqual(
      [
        "drive-pr-4172.json",
        "drive-pr-4172.json.lock",
        "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
        "drive-pr-4172.json.lock.recovering.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb",
        "drive-pr-4172.log",
        "drive-pr-4172.ready-claim",
        "drive-pr-4172.ready-claim.released.99999",
        "drive-pr-4172.held-claim.aaa.0123456789abcdef",
        "drive-arm-4172.out",
        "pr-drive-lease-4172-wt-0123456789abcdef.json",
        "pr-drive-lease-4172-wt-0123456789abcdef.json.lock.stale.owner.cccccccccccccccccccccccc",
        "drive-pr-remote-lock-4172.lock.recovering.stale.owner.dddddddddddddddddddddddd",
        ".drive-pr-4172.orphan-warned",
        ".drive-pr-4172.orphan-warned.abandoned.99999",
        "drive-pr-4172.json.a1b2c3",
        "pr-drive-lease-4172-wt-0123456789abcdef.json.a1b2c3",
      ].sort(),
    );
    expect(actor?.names.sort()).toEqual([
      "drive-tree-lease-wt-0123456789abcdef.json",
      "drive-tree-lease-wt-0123456789abcdef.json.a1b2c3",
      "drive-tree-lease-wt-0123456789abcdef.json.lock.stale.owner.eeeeeeeeeeeeeeeeeeeeeeee",
    ]);
  });

  it("collapses a family’s whole lock history onto the anchors it can compact", () => {
    const { families } = classify(CORPUS);
    expect([...(families.get("pr:4172")?.anchors ?? [])].sort()).toEqual([
      "drive-pr-4172.json",
      "drive-pr-remote-lock-4172",
      "pr-drive-lease-4172-wt-0123456789abcdef.json",
    ]);
    // The plain per-PR entries contribute no anchor: they carry no lock, so
    // there is nothing under them for `sweepLockQuarantine` to compact, and
    // passing one would have it derive a `<name>.lock` that never existed.
    expect(families.get("pr:4172")?.anchors.has("drive-pr-4172.log")).toBe(
      false,
    );
  });

  it("classifies drive.ts’s source-named locks as foreign, never as a family", () => {
    const { families, foreign } = classify(CORPUS);
    expect(foreign.sort()).toEqual([
      "pr-drive-4172.lock",
      "pr-drive-worktree-0123456789abcdef.lock",
    ]);
    // Critically NOT folded into pr:4172 — it shares the PR number but not the
    // protocol, and compacting or deleting it is that protocol's business.
    expect(families.get("pr:4172")?.names.includes("pr-drive-4172.lock")).toBe(
      false,
    );
  });

  it("leaves everything it cannot name an owner for unrecognised", () => {
    const { unrecognised } = classify(CORPUS);
    expect(unrecognised.sort()).toEqual(
      ["HEAD", "skill-suite-green", "packed-refs", "worktrees"].sort(),
    );
  });

  it("treats its own snapshot file AND its atomic-write temp-file shape as neither a family member nor unrecognised", () => {
    // A bare `=== SNAPSHOT_FILENAME` check let `.reap-state-snapshot.json.<6-
    // hex>` — the `atomicWrite` staging leftover from a crash before its
    // rename, or a concurrent read racing an in-flight write — fall into
    // `unrecognised`, inflating the reported entry count and growth rate.
    const { families, foreign, unrecognised } = classify(CORPUS);
    expect(unrecognised).not.toContain(".reap-state-snapshot.json");
    expect(unrecognised).not.toContain(".reap-state-snapshot.json.a1b2c3");
    expect(foreign).not.toContain(".reap-state-snapshot.json");
    expect(foreign).not.toContain(".reap-state-snapshot.json.a1b2c3");
    for (const f of families.values()) {
      expect(f.names).not.toContain(".reap-state-snapshot.json");
      expect(f.names).not.toContain(".reap-state-snapshot.json.a1b2c3");
    }
  });

  it("treats legacy-state.ts’s migration marker as neither a family member nor unrecognised", () => {
    // Without excluding it, `classify` had no way to tell this marker —
    // permanently present in every migrated default state directory — apart
    // from real backlog, so every healthy migrated clone reported an
    // "unrecognised" entry.
    const { families, foreign, unrecognised } = classify(CORPUS);
    expect(unrecognised).not.toContain(MIGRATED_MARKER_FILENAME);
    expect(foreign).not.toContain(MIGRATED_MARKER_FILENAME);
    for (const f of families.values()) {
      expect(f.names).not.toContain(MIGRATED_MARKER_FILENAME);
    }
  });

  describe("isSnapshotArtifact", () => {
    it("matches the exact snapshot filename", () => {
      expect(isSnapshotArtifact(".reap-state-snapshot.json")).toBe(true);
    });

    it("matches the atomic-write temp-file shape — six hex digits, `fsutil.ts`’s tempSuffix()", () => {
      expect(isSnapshotArtifact(".reap-state-snapshot.json.a1b2c3")).toBe(true);
    });

    it("rejects a name that merely starts with the snapshot filename", () => {
      // Guards the regex's own anchoring: a name this protocol never
      // produced must not be silently swallowed alongside the real shapes.
      expect(isSnapshotArtifact(".reap-state-snapshot.json.backup")).toBe(
        false,
      );
      expect(isSnapshotArtifact(".reap-state-snapshot.json.old")).toBe(false);
      expect(isSnapshotArtifact("other-file.json")).toBe(false);
    });
  });

  it("rejects a foreign held-claim name that lacks the producer’s trailing digest", () => {
    // The reviewer's own example: `claimKeyForPath` (lib/state/claims.ts)
    // always appends a 16-hex-char digest — `<sanitized-key>.<16-hex>` — so
    // a name like `held-claim.notes`, with nothing hex-like after it, was
    // never produced by this protocol. Accepting it anyway silently
    // attributed a foreign file to the family and deleted it when that
    // family retired.
    const { families, unrecognised } = classify([
      "drive-pr-4172.json",
      "drive-pr-4172.held-claim.notes",
    ]);
    expect(unrecognised).toEqual(["drive-pr-4172.held-claim.notes"]);
    expect(
      families.get("pr:4172")?.names.includes("drive-pr-4172.held-claim.notes"),
    ).toBe(false);
  });

  it("still recognises a genuine held-claim name (sanitized key + 16-hex digest)", () => {
    const { families } = classify([
      "drive-pr-4172.json",
      "drive-pr-4172.held-claim.some_key.0123456789abcdef",
      "drive-pr-4172.held-claim.some_key.0123456789abcdef.released.99999",
    ]);
    expect(families.get("pr:4172")?.names).toEqual(
      expect.arrayContaining([
        "drive-pr-4172.held-claim.some_key.0123456789abcdef",
        "drive-pr-4172.held-claim.some_key.0123456789abcdef.released.99999",
      ]),
    );
  });
});

describe("retirementStillSafe — the immediate-before-delete revalidation", () => {
  // A retirement decision is computed once for the WHOLE batch before any
  // deletion starts, and compaction alone can take minutes on a large backlog —
  // so `main`'s deletion loop re-checks this immediately before each family's
  // own `rmSync`, rather than trusting the earlier verdict. These are unit
  // tests of that predicate directly (not a full CLI round trip): a genuine
  // race requires a SECOND process writing mid-run, which a single synchronous
  // invocation cannot manufacture, so the predicate's correctness is what is
  // verified here, in isolation — the same pattern `classify` and `anchorOf`
  // already use above.
  //
  // Every "safe" fixture WRITES its family member(s) and backdates them past
  // `RS_MIN_AGE_MS`, and every single-clause "unsafe" fixture is checked
  // against an otherwise-safe family — per the fail-closed-conjunction rule, a
  // fixture that also trips an EARLIER clause (an unwritten file reading as
  // "could not stat", a fresh mtime reading as "not yet idle") would pass
  // vacuously regardless of whether the clause under test works.

  const RS_MIN_AGE_MS = 60_000;
  /** A worktree census naming some OTHER actor — never this test's subject. */
  const NO_MATCHING_WORKTREE = new Set(["wt-ffffffffffffffff"]);

  it("is safe to retire a PR family with no lease at all", () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    backdate(d, 1);
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json"],
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toBeNull();
  });

  it("refuses to retire a PR family whose lease was renewed since the verdict", () => {
    const d = freshStateDir();
    writeFileSync(
      join(d, "pr-drive-lease-4172-wt-0123456789abcdef.json"),
      leaseJson("wt-0123456789abcdef", "4172", {
        pid: process.pid, // this very process — unambiguously alive
        lastSeen: new Date().toISOString(),
      }),
    );
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["pr-drive-lease-4172-wt-0123456789abcdef.json"],
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toContain(
      "lease was claimed or renewed",
    );
  });

  it("refuses to retire a PR family whose lease is unreadable but still fresh", () => {
    const d = freshStateDir();
    writeFileSync(
      join(d, "pr-drive-lease-4172-wt-0123456789abcdef.json"),
      "{}",
    );
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["pr-drive-lease-4172-wt-0123456789abcdef.json"],
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toContain(
      "unreadable lease appeared",
    );
  });

  it("refuses to retire a PR family touched since the verdict, lease aside", () => {
    // Isolates the mtime clause: no lease file in the family at all, so the
    // lease branch cannot be what fires.
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    // NOT backdated — mtime stays "now", inside RS_MIN_AGE_MS.
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json"],
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toContain(
      "touched since this verdict",
    );
  });

  it("refuses to retire a PR family with a family member it cannot stat", () => {
    const d = freshStateDir();
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json"], // never written
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toContain(
      "could not be stat’ed",
    );
  });

  it("is safe to retire an actor family with no tree lease and no worktree match", () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-tree-lease-wt-00112233445566aa.json"), "{}");
    backdate(d, 1);
    const family = {
      id: "actor:wt-00112233445566aa",
      kind: "actor" as const,
      subject: "wt-00112233445566aa",
      names: ["drive-tree-lease-wt-00112233445566aa.json"],
      anchors: new Set<string>(),
    };
    expect(
      retirementStillSafe(family, d, RS_MIN_AGE_MS, NO_MATCHING_WORKTREE),
    ).toBeNull();
  });

  it("refuses to retire an actor family whose tree lease was renewed since the verdict", () => {
    const d = freshStateDir();
    writeFileSync(
      join(d, "drive-tree-lease-wt-00112233445566aa.json"),
      leaseJson("wt-00112233445566aa", "4172", {
        pid: process.pid,
        lastSeen: new Date().toISOString(),
      }),
    );
    const family = {
      id: "actor:wt-00112233445566aa",
      kind: "actor" as const,
      subject: "wt-00112233445566aa",
      names: ["drive-tree-lease-wt-00112233445566aa.json"],
      anchors: new Set<string>(),
    };
    expect(
      retirementStillSafe(family, d, RS_MIN_AGE_MS, NO_MATCHING_WORKTREE),
    ).toContain("tree lease was claimed or renewed");
  });

  it("refuses to retire an actor family whose tree lease is unreadable but still fresh", () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-tree-lease-wt-00112233445566aa.json"), "{}");
    const family = {
      id: "actor:wt-00112233445566aa",
      kind: "actor" as const,
      subject: "wt-00112233445566aa",
      names: ["drive-tree-lease-wt-00112233445566aa.json"],
      anchors: new Set<string>(),
    };
    expect(
      retirementStillSafe(family, d, RS_MIN_AGE_MS, NO_MATCHING_WORKTREE),
    ).toContain("unreadable tree lease appeared");
  });

  it("refuses to retire an actor family whose worktree was re-registered since the verdict", () => {
    // Isolates the census clause: no lease file in the family at all, so
    // neither lease branch can be what fires.
    const d = freshStateDir();
    writeFileSync(join(d, "drive-tree-lease-wt-00112233445566aa.json"), "{}");
    backdate(d, 1);
    const family = {
      id: "actor:wt-00112233445566aa",
      kind: "actor" as const,
      subject: "wt-00112233445566aa",
      names: ["drive-tree-lease-wt-00112233445566aa.json"],
      anchors: new Set<string>(),
    };
    const reregistered = new Set(["wt-00112233445566aa"]);
    expect(
      retirementStillSafe(family, d, RS_MIN_AGE_MS, reregistered),
    ).toContain("worktree was re-registered");
  });

  it("refuses to retire an actor family when the worktree list could not be re-read", () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-tree-lease-wt-00112233445566aa.json"), "{}");
    backdate(d, 1);
    const family = {
      id: "actor:wt-00112233445566aa",
      kind: "actor" as const,
      subject: "wt-00112233445566aa",
      names: ["drive-tree-lease-wt-00112233445566aa.json"],
      anchors: new Set<string>(),
    };
    expect(retirementStillSafe(family, d, RS_MIN_AGE_MS, null)).toContain(
      "could not be re-read",
    );
  });
});

describe("anchorStillNeedsCompaction — verifying sweepLockQuarantine actually did something", () => {
  it("accepts a retained nonempty Windows directory fence without crediting compaction", () => {
    const d = freshStateDir();
    const name = "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    plantQuarantine(d, name);
    const probe = join(d, "windows-fence-probe.ts");
    writeFileSync(
      probe,
      `
      Object.defineProperty(process, "platform", { value: "win32" });
      const { anchorStillNeedsCompaction } = await import(${JSON.stringify(REAP)});
      const family = { names: [${JSON.stringify(name)}] };
      if (anchorStillNeedsCompaction(${JSON.stringify(d)}, family, "drive-pr-4172.json"))
        throw new Error("a retained nonempty Windows fence is already safe");
    `,
    );
    const result = Bun.spawnSync([process.execPath, probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 0);
  });
  // `sweepLockQuarantine` is `void` and swallows every internal write failure
  // (a read-only state dir, EACCES, ENOSPC), so the caller cannot tell
  // "compacted" from "silently did nothing" from its return alone — this
  // predicate re-checks the filesystem directly. Unit-tested directly rather
  // than via a genuinely read-only fixture: `lock.test.ts` already documents
  // why `chmodSync` is not a reliable way to induce EACCES here — running as
  // root (the reviewer's own sandbox, and plenty of CI/dev containers) bypasses
  // directory permission checks entirely, so a chmod-based fixture would pass
  // vacuously without exercising the failure path at all.

  it("recognizes the platform's completed directory-fence shape", () => {
    const d = freshStateDir();
    plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa"],
      anchors: new Set<string>(),
    };
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      compactsDirectoryFences(),
    );
  });

  it("recognizes whether a single-file fence is safe on this platform", () => {
    const d = freshStateDir();
    writeFileSync(
      join(d, "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa"),
      "",
    );
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa"],
      anchors: new Set<string>(),
    };
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      !compactsDirectoryFences(),
    );
  });

  it("leaves a nonempty foreign file unfinished on Windows instead of accepting it as a fence", () => {
    const d = freshStateDir();
    const canonical =
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(join(d, canonical), "foreign canonical data");
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: [canonical],
      anchors: new Set<string>(),
    };
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      !compactsDirectoryFences(),
    );
    expect(readFileSync(join(d, canonical), "utf8")).toBe(
      "foreign canonical data",
    );
  });

  it("fails closed when the entry cannot be stat’ed at all", () => {
    const d = freshStateDir();
    // Never written — `compactQuarantineEntry`'s own success and failure
    // paths both leave SOMETHING at the canonical path, so an unstat-able
    // entry right after a sweep is anomalous, not a legitimate outcome.
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: ["drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa"],
      anchors: new Set<string>(),
    };
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      true,
    );
  });

  it("checks the restored canonical fence when recovering an orphaned staging copy", () => {
    // The exact case this pins: when the canonical path named by a
    // `.compacting.*` staging leftover did NOT already exist,
    // `sweepLockQuarantine`'s recovery CREATES one — a tombstoned DIRECTORY,
    // restoring a fence rather than compacting anything — and that path was
    // never in `family.names` (it did not exist when `classify()` ran).
    // Checking only the vanished staging name would report success for a
    // generation that is still, in fact, an uncompacted multi-inode directory.
    const d = freshStateDir();
    const staging = `.compacting.drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa.${"0".repeat(24)}`;
    plantQuarantine(d, staging); // orphaned staging leftover; canonical NOT pre-existing
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: [staging],
      anchors: new Set<string>(),
    };
    sweepLockQuarantine(join(d, "drive-pr-4172.json"));
    const canonical =
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    expect(existsSync(join(d, staging))).toBe(false);
    expect(statSync(join(d, canonical)).isDirectory()).toBe(true);
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      compactsDirectoryFences(),
    );
  });

  it("reports no work left once a genuinely successful sweep consumes a planted .compacting.* leftover whose canonical entry was already compacted", () => {
    // A successful sweep of a `.compacting.*` staging leftover CONSUMES it
    // (confirms the fence at the canonical path it names already stands, then
    // deletes the staging copy outright), so checking the staging name's own
    // directory-ness the same way as every other sweepable shape reads that
    // success as "still needs work" — `statSync` throws ENOENT on the
    // (correctly) vanished staging name, and an earlier version treated that as
    // failure. Here the canonical entry DOES already exist, and already as a
    // compacted single file, so this is the case where the answer genuinely is
    // "no work left".
    const d = freshStateDir();
    const canonical =
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(join(d, canonical), ""); // already compacted
    const staging = `.compacting.drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa.${"0".repeat(24)}`;
    plantQuarantine(d, staging);
    const family = {
      id: "pr:4172",
      kind: "pr" as const,
      subject: "4172",
      names: [staging],
      anchors: new Set<string>(),
    };
    sweepLockQuarantine(join(d, "drive-pr-4172.json"));
    expect(existsSync(join(d, staging))).toBe(false);
    expect(statSync(join(d, canonical)).isDirectory()).toBe(
      !compactsDirectoryFences(),
    );
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      false,
    );
  });
});

describe("the retirement predicate fails closed", () => {
  /** A merged-PR family, old enough to clear the idle guard on its own. */
  function plantRetirableFamily(pr = "4172"): string {
    const d = freshStateDir();
    writeFileSync(join(d, `drive-pr-${pr}.json`), "{}");
    writeFileSync(join(d, `drive-pr-${pr}.log`), "log\n");
    plantQuarantine(
      d,
      `drive-pr-${pr}.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    plantQuarantine(
      d,
      `drive-pr-${pr}.json.lock.recovering.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb`,
    );
    backdate(d, 30);
    return d;
  }

  it("retires a merged PR’s whole family", async () => {
    const d = plantRetirableFamily();
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_MERGED() });
    expect(r.retire.map((x) => x.id)).toEqual(["pr:4172"]);
    expect(entriesOf(d)).toEqual([]);
  });

  it("keeps an OPEN PR’s family, however old", async () => {
    const d = plantRetirableFamily();
    const before = readdirSync(d).sort();
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("still open");
    expect(entriesOf(d).sort()).toEqual(before);
  });

  it("keeps the family when gh cannot answer at all", async () => {
    // The distinction that matters: a TRANSPORT failure is not evidence the PR
    // is gone. Reading it as one would retire a live PR's state the first time
    // the network hiccups during a weekly run.
    const d = plantRetirableFamily();
    const before = readdirSync(d).sort();
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_BROKEN() });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("failing closed");
    expect(entriesOf(d).sort()).toEqual(before);
  });

  it("retires a PR GitHub no longer knows about", async () => {
    // A number that 404s cannot come back: the state can only have been
    // created by a drive against a PR that existed.
    const d = plantRetirableFamily();
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_GONE() });
    expect(r.retire.map((x) => x.id)).toEqual(["pr:4172"]);
    expect(entriesOf(d)).toEqual([]);
  });

  it("keeps a CLOSED (not merged) PR’s family, however old — it is reopenable", async () => {
    // Unlike MERGED, GitHub lets a closed PR be reopened with no time limit,
    // so retiring it outright could delete a parked human decision a future
    // reopen would need. Compaction still runs; deletion never does.
    const d = plantRetirableFamily();
    const before = readdirSync(d).sort();
    const r = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: ghShim("closed", 'echo \'{"state":"CLOSED"}\''),
    });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("reopenable");
    expect(entriesOf(d).sort()).toEqual(before);
  });

  it("keeps a family when gh reports a repository-resolution failure, not a PR-specific 404", async () => {
    // A scheduled job that has temporarily lost access to the repository gets
    // "Could not resolve to a Repository with the name '...'" — a real `gh`
    // shape (measured), and distinct from the PR-specific
    // "Could not resolve to a PullRequest with the number of N" 404. Reading
    // the former as `retired` would delete every queried PR's state on one
    // bad day.
    const d = plantRetirableFamily();
    const before = readdirSync(d).sort();
    const r = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: ghShim(
        "repo-gone",
        "echo \"GraphQL: Could not resolve to a Repository with the name 'example-org/example-repo'. (repository)\" >&2; exit 1",
      ),
    });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("failing closed");
    expect(entriesOf(d).sort()).toEqual(before);
  });

  it("keeps a merged PR whose lease is still LIVE", async () => {
    // The merge may have landed seconds ago with a driver mid-round on it.
    const d = plantRetirableFamily();
    writeFileSync(
      join(d, `pr-drive-lease-4172-${repoKey}.json`),
      leaseJson(repoKey, "4172", {
        pid: process.pid, // this very process — unambiguously alive
        lastSeen: new Date().toISOString(),
      }),
    );
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_MERGED() });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("live lease");
    expect(existsSync(join(d, "drive-pr-4172.json"))).toBe(true);
  });

  it("keeps a merged PR whose family was touched inside the idle guard", async () => {
    const d = plantRetirableFamily();
    const now = new Date();
    utimesSync(join(d, "drive-pr-4172.json"), now, now);
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_MERGED() });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("idle guard");
    expect(existsSync(join(d, "drive-pr-4172.json"))).toBe(true);
  });

  it("honours a widened --min-age-days", async () => {
    const d = plantRetirableFamily(); // backdated 30 days
    const kept = await reapJson(["--delete", "--min-age-days", "365"], {
      stateDir: d,
      ghDir: GH_MERGED(),
    });
    expect(kept.retire).toEqual([]);
    expect(existsSync(join(d, "drive-pr-4172.json"))).toBe(true);
  });

  it("refuses --min-age-days 0 rather than silently dropping the guard", async () => {
    const d = freshStateDir();
    const r = await runReap(["--min-age-days", "0"], { stateDir: d });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--min-age-days");
  });

  it("refuses a --min-age-days value long enough to overflow to Infinity", async () => {
    // `isDigits` alone does not bound magnitude, and `Infinity < 1` is false
    // — a naive lower-bound-only check would silently accept this and make
    // the idle guard never fire again.
    const d = freshStateDir();
    const r = await runReap(["--min-age-days", "9".repeat(400)], {
      stateDir: d,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--min-age-days");
  });

  it("refuses a --min-age-days value above the documented 365-day bound", async () => {
    const d = freshStateDir();
    const r = await runReap(["--min-age-days", "366"], { stateDir: d });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--min-age-days");
  });
});

describe("the worktree predicate", () => {
  it("retires a tree lease whose worktree no longer exists", async () => {
    const d = freshStateDir();
    const dead = "wt-00112233445566aa";
    writeFileSync(join(d, `drive-tree-lease-${dead}.json`), "{}");
    plantQuarantine(
      d,
      `drive-tree-lease-${dead}.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    backdate(d, 30);
    const r = await reapJson(["--delete"], { stateDir: d });
    expect(r.retire.map((x) => x.id)).toEqual([`actor:${dead}`]);
    expect(entriesOf(d)).toEqual([]);
  });

  it("keeps a tree lease whose worktree is still there", async () => {
    // `repoKey` is sha256 of the scratch repo's real toplevel, so this asserts
    // the script's own derivation agrees with `lib/state/actor.ts`'s — a
    // mismatch would classify every LIVE worktree as gone, and only the idle
    // guard would stand between that and deletion.
    const d = freshStateDir();
    writeFileSync(join(d, `drive-tree-lease-${repoKey}.json`), "{}");
    backdate(d, 30);
    const r = await reapJson(["--delete"], { stateDir: d });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("worktree still exists");
    expect(existsSync(join(d, `drive-tree-lease-${repoKey}.json`))).toBe(true);
  });

  it("keeps a tree lease held by a LIVE session, even after its worktree is gone from git", async () => {
    // `git worktree list` losing the registration is exactly the case
    // `liveTreeLeaseFor` exists for — a live process can still be behind the
    // lease even though the worktree predicate above would otherwise retire
    // it.
    const d = freshStateDir();
    const dead = "wt-00112233445566aa";
    writeFileSync(join(d, `drive-tree-lease-${dead}.json`), "{}");
    backdate(d, 30);
    // Written AFTER backdating, so its mtime is fresh — same pattern as the
    // per-PR live-lease test above.
    writeFileSync(
      join(d, `drive-tree-lease-${dead}.json`),
      leaseJson(dead, "4172", {
        pid: process.pid, // this very process — unambiguously alive
        lastSeen: new Date().toISOString(),
      }),
    );
    const r = await reapJson(["--delete"], { stateDir: d });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("live tree lease");
    expect(existsSync(join(d, `drive-tree-lease-${dead}.json`))).toBe(true);
  });

  it("keeps a tree lease that is unreadable but still fresh — a live writer may be mid-write", async () => {
    // An unreadable file this young is exactly the ambiguous case
    // `unreadableLeaseFilesFor` already protects for the per-PR path — a
    // genuinely live writer could still be behind it, and `liveTreeLeaseFor`
    // alone cannot tell "unreadable" apart from "no lease at all".
    const d = freshStateDir();
    const dead = "wt-00112233445566aa";
    writeFileSync(join(d, `drive-tree-lease-${dead}.json`), "{}");
    // NOT backdated: the file's mtime stays fresh, inside the staleness
    // window.
    const r = await reapJson(["--delete"], { stateDir: d });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("unreadable tree lease");
    expect(existsSync(join(d, `drive-tree-lease-${dead}.json`))).toBe(true);
  });

  it("keeps every tree lease when git cannot list worktrees", async () => {
    // An empty key set would read as "no tree exists anywhere" and retire
    // every lease on the machine — the single worst outcome available to this
    // predicate, so it is pinned rather than left to the age guard.
    const d = freshStateDir();
    const dead = "wt-00112233445566aa";
    writeFileSync(join(d, `drive-tree-lease-${dead}.json`), "{}");
    backdate(d, 30);
    const r = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: shimDir("worktree-list-fails", { git: "exit 1" }),
    });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("failing closed");
    expect(existsSync(join(d, `drive-tree-lease-${dead}.json`))).toBe(true);
  });

  it("keeps every tree lease when git SUCCEEDS but lists no worktree", async () => {
    // A distinct branch from the failure above, and the one that mutation
    // testing caught as unprobed: `git worktree list` exiting 0 with output
    // this parser recognises nothing in yields an EMPTY key set, and an empty
    // set means "no tree exists anywhere" — which would retire every lease on
    // the machine in a single run. A repository always has at least one
    // worktree, so empty is a parse failure, not an answer, and is refused like
    // any other unreadable input (a scan that cannot read its input must never
    // report an empty population).
    const d = freshStateDir();
    const dead = "wt-00112233445566aa";
    writeFileSync(join(d, `drive-tree-lease-${dead}.json`), "{}");
    backdate(d, 30);
    const r = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: shimDir("git-empty-worktrees", {
        // Exits 0, prints porcelain-shaped output with no `worktree ` line.
        git: 'echo "HEAD 0000000000000000000000000000000000000000"; exit 0',
      }),
    });
    expect(r.retire).toEqual([]);
    expect(r.keep[0]?.reason).toContain("failing closed");
    expect(existsSync(join(d, `drive-tree-lease-${dead}.json`))).toBe(true);
  });
});

describe("compaction — what happens to everything that is NOT retired", () => {
  it("recovers an orphan staging file even when the canonical fence already needs no compaction", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const name = "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    if (compactsDirectoryFences()) writeFileSync(join(d, name), "");
    else plantQuarantine(d, name);
    const staging = `.compacting.${name}.${"0".repeat(24)}`;
    writeFileSync(join(d, staging), "orphaned private copy");
    const result = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: GH_OPEN(),
    });
    expect(result.anchorsCompactable).toBe(1);
    expect(result.anchorsCompacted).toBe(1);
    expect(existsSync(join(d, staging))).toBe(false);
    expect(existsSync(join(d, name))).toBe(true);
    const next = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: GH_OPEN(),
    });
    expect(next.anchorsCompactable).toBe(0);
    expect(next.anchorsCompacted).toBe(0);
  });

  it("does not call an empty directory a completed fence", () => {
    const d = freshStateDir();
    const name = "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    mkdirSync(join(d, name));
    const family = { names: [name] } as Parameters<
      typeof anchorStillNeedsCompaction
    >[1];
    expect(anchorStillNeedsCompaction(d, family, "drive-pr-4172.json")).toBe(
      true,
    );
  });

  it("keeps a safe generation fence in the platform's completed shape", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const q = plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const qr = plantQuarantine(
      d,
      "drive-pr-4172.json.lock.recovering.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });

    expect(r.retire).toEqual([]);
    expect(r.anchorsCompactable).toBe(compactsDirectoryFences() ? 1 : 0);
    expect(r.anchorsCompacted).toBe(compactsDirectoryFences() ? 1 : 0);
    // The FENCE is what must survive: same generation-keyed path, still
    // present, so a later rename onto it still fails — only now it is one
    // inode instead of three. Deleting it instead would let that later rename
    // succeed onto the freed path — a TOCTOU race.
    for (const p of [q, qr]) {
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).isDirectory()).toBe(!compactsDirectoryFences());
      if (!compactsDirectoryFences())
        expect(readdirSync(p).length).toBeGreaterThan(0);
    }
  });

  it("skips an anchor whose quarantine is ALREADY compacted", async () => {
    // Unconditional compaction is O(anchors × entries), because
    // `sweepLockQuarantine` re-enumerates the state dir per call — 9.8s for 40
    // anchors over 20k entries, ~12 minutes at a measured 508/113k scale. And
    // it would not decay on its own: compaction shrinks inodes, not the entry
    // count that drives the enumeration. So the steady state has
    // to be "no work found, nothing called".
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    // The COMPACTED shape: an empty file at the generation-keyed path, which
    // is what a previous run leaves behind.
    const name = "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa";
    if (compactsDirectoryFences()) writeFileSync(join(d, name), "");
    else plantQuarantine(d, name);

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });
    expect(r.retire).toEqual([]);
    expect(r.anchorsCompacted).toBe(0);
  });

  it("does not mistake the LIVE lock paths for work needing compaction", async () => {
    // `<anchor>.lock` and `<anchor>.lock.recovering` are directories too, and
    // `sweepLockQuarantine` deliberately never touches them — they stay owned
    // by `createLock`'s acquire/release protocol. Counting them as work would
    // mark every anchor as dirty forever, reinstating the full cost the filter
    // exists to avoid, and would do it invisibly (the sweep is a no-op on
    // them, so only the runtime would show it).
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    mkdirSync(join(d, "drive-pr-4172.json.lock"), { recursive: true });
    mkdirSync(join(d, "drive-pr-4172.json.lock.recovering"), {
      recursive: true,
    });

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });
    expect(r.anchorsCompacted).toBe(0);
    // And they are still there, untouched.
    expect(statSync(join(d, "drive-pr-4172.json.lock")).isDirectory()).toBe(
      true,
    );
    expect(
      statSync(join(d, "drive-pr-4172.json.lock.recovering")).isDirectory(),
    ).toBe(true);
  });

  it("compacts even while the PR is live — it has no precondition", async () => {
    // `sweepLockQuarantine`'s own contract, and `drive-state.ts`'s call site:
    // `reset` is a convenient trigger, not a safety requirement. If this ever
    // became gated on the same checks retirement uses, the 95% of the pile
    // that belongs to still-open PRs would go back to growing unbounded.
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    writeFileSync(
      join(d, `pr-drive-lease-4172-${repoKey}.json`),
      leaseJson(repoKey, "4172", {
        pid: process.pid,
        lastSeen: new Date().toISOString(),
      }),
    );
    const q = plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await reapJson(["--delete"], { stateDir: d, ghDir: GH_MERGED() });
    expect(statSync(q).isDirectory()).toBe(!compactsDirectoryFences());
  });
});

describe("the untouched populations", () => {
  it("never removes or compacts drive.ts’s source-named locks", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const own = join(d, "pr-drive-4172.lock");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, `${process.pid} ${hostname()}`), "");
    backdate(d, 30);

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_MERGED() });

    // pr:4172 retires — and its own single-instance lock, which merely shares
    // the number, stays exactly as it was.
    expect(r.retire.map((x) => x.id)).toEqual(["pr:4172"]);
    expect(r.untouched.foreignLocks).toBe(1);
    expect(existsSync(own)).toBe(true);
    expect(statSync(own).isDirectory()).toBe(true);
  });

  it("never touches an entry it cannot name an owner for", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "packed-refs"), "refs\n");
    mkdirSync(join(d, "worktrees"), { recursive: true });
    backdate(d, 400);
    const r = await reapJson(["--delete"], { stateDir: d });
    expect(r.untouched.unrecognised).toBe(2);
    expect(existsSync(join(d, "packed-refs"))).toBe(true);
    expect(existsSync(join(d, "worktrees"))).toBe(true);
  });
});

describe("computeAlreadyRelocated", () => {
  const legacyDir = "/repo/.git";
  const computedDefault = "/home/user/.local/state/jig/drive-pr/abc123";
  const override = "/mnt/big-disk/drive-pr-state";

  it("is false on the plain no-override default path", () => {
    // stateDir === computedDefault, exactly what a bare resolveStateDir()
    // call without any override in play produces.
    expect(
      computeAlreadyRelocated(computedDefault, legacyDir, computedDefault),
    ).toBe(false);
  });

  it("is false when drive.ts re-exports its own resolved default", () => {
    // The exact scenario the finding named: `drive.ts` sets
    // $DRIVE_PR_STATE_DIR to the default it resolved, so a spawned child's
    // env var is "set" even though no operator override exists. stateDir is
    // still just the default — must not read as relocated.
    expect(
      computeAlreadyRelocated(computedDefault, legacyDir, computedDefault),
    ).toBe(false);
  });

  it("is false when the override points AT the legacy git-common-dir", () => {
    // An override that resolves right back to the older location is
    // not a relocation — it is the one state this whole mechanism exists to
    // move away from.
    expect(computeAlreadyRelocated(legacyDir, legacyDir, computedDefault)).toBe(
      false,
    );
  });

  it("is false on the legacy, not-yet-migrated path with no persisted clone identity", () => {
    // peekDefaultStateDirFor's null case: no override, no persisted clone
    // identity yet, so peekStateDir falls back to legacyDir itself.
    expect(computeAlreadyRelocated(legacyDir, legacyDir, null)).toBe(false);
  });

  it("is true for a genuine operator relocation to a directory that is neither the default nor the legacy dir", () => {
    expect(computeAlreadyRelocated(override, legacyDir, computedDefault)).toBe(
      true,
    );
  });

  it("is true for a genuine relocation even when no persisted default identity exists yet", () => {
    // stateDir differs from legacyDir, and computedDefault is null — the
    // only way to reach this combination (per peekStateDir's own fallback)
    // is a real override, so this must still read as relocated.
    expect(computeAlreadyRelocated(override, legacyDir, null)).toBe(true);
  });

  it("is false when the override is NESTED beneath the legacy dir, not just equal to it", () => {
    // /repo/.git/drive-pr-state is neither equal to legacyDir nor to
    // computedDefault, but it is still physically inside `.git` — the exact
    // IDE/backup/git-metadata blast radius relocation exists to escape.
    expect(
      computeAlreadyRelocated(
        `${legacyDir}/drive-pr-state`,
        legacyDir,
        computedDefault,
      ),
    ).toBe(false);
  });

  it("does not misread an unrelated SIBLING of the legacy dir as nested beneath it", () => {
    // /repo/.gitignore string-prefix-matches "/repo/.git" but is not inside
    // it — a naive startsWith() check would wrongly read this as unrelocated.
    expect(
      computeAlreadyRelocated("/repo/.gitignore", legacyDir, computedDefault),
    ).toBe(true);
  });

  it("is false when the override is nested beneath the DEFAULT dir, not just the legacy one", () => {
    // A subdirectory of the ordinary default state dir still sits under the
    // tree an IDE or backup tool watching ~/.local/state/jig already pays the
    // recursive-enumeration cost for — not a genuine relocation either.
    expect(
      computeAlreadyRelocated(
        `${computedDefault}/custom`,
        legacyDir,
        computedDefault,
      ),
    ).toBe(false);
  });
});

describe("resolveRealPathBestEffort", () => {
  // The mechanism `computeAlreadyRelocatedForStateDir` relies on: a
  // `$DRIVE_PR_STATE_DIR` override that is an absolute SYMLINK pointing back
  // at the legacy or default location is still the SAME physical directory,
  // and a bare string comparison would misread it as a genuine relocation.
  it("resolves a symlink to its real target", () => {
    const d = mkdtempSync(join(root, "realpath-"));
    const real = join(d, "real-target");
    mkdirSync(real);
    const link = join(d, "link-to-target");
    symlinkSync(real, link);
    expect(resolveRealPathBestEffort(link)).toBe(
      resolveRealPathBestEffort(real),
    );
  });

  it("falls back to the original path when it does not exist, rather than throwing", () => {
    const missing = join(root, "does-not-exist-at-all");
    expect(resolveRealPathBestEffort(missing)).toBe(missing);
  });

  it("demonstrates the fix: a symlinked override resolving to the legacy dir is no longer read as relocated", () => {
    const d = mkdtempSync(join(root, "realpath-relocation-"));
    const legacy = join(d, "legacy-git-common-dir");
    mkdirSync(legacy);
    const override = join(d, "override-symlink");
    symlinkSync(legacy, override);
    // Lexically these are two different strings — the pre-fix bug — but
    // once both are resolved to their real filesystem identity they are the
    // same directory, so `computeAlreadyRelocated` must read `false`.
    expect(override).not.toBe(legacy);
    expect(
      computeAlreadyRelocated(
        resolveRealPathBestEffort(override),
        resolveRealPathBestEffort(legacy),
        "/home/user/.local/state/jig/drive-pr/abc123",
      ),
    ).toBe(false);
  });
});

describe("entry-count warning — the count compaction cannot reduce", () => {
  // The condition this guards against was invisible for months precisely
  // because the number WAS printed: 164k, then 233k, then 382,524 entries, in
  // a weekly log where a healthy run looks identical to a pathological one.
  // These assertions pin the boundary so the escalation cannot silently
  // regress back into a bare number.
  it("stays silent for a healthy state dir", () => {
    expect(entryCountWarningFor(0, false)).toBeNull();
    expect(entryCountWarningFor(1_302, false)).toBeNull();
  });

  it("is still silent one entry BELOW the threshold", () => {
    expect(entryCountWarningFor(49_999, false)).toBeNull();
  });

  it("fires exactly AT the threshold", () => {
    const w = entryCountWarningFor(50_000, false);
    expect(w).not.toBeNull();
    expect(w).toContain("50000 entries");
  });

  it("names the remedy rather than just the number — a sweep cannot fix this", () => {
    const w = entryCountWarningFor(382_524, false) ?? "";
    // The actionable half: relocating the directory, not sweeping harder.
    expect(w).toContain("$DRIVE_PR_STATE_DIR");
    expect(w).toContain("382524");
    // And it must say WHY more sweeping will not help, or the reader's first
    // instinct (lower --min-age-days) wastes a cycle on the wrong lever.
    expect(w).toContain("Compaction cannot reduce this");
  });

  // An operator who already exported $DRIVE_PR_STATE_DIR (the
  // documented relocation procedure) and still hits the threshold must not be
  // told to "relocate further with $DRIVE_PR_STATE_DIR" — advice they have
  // already followed. The remedy changes once relocation is already in effect.
  it("does not recommend relocation the operator already performed", () => {
    const w = entryCountWarningFor(382_524, true) ?? "";
    expect(w).toContain("382524");
    expect(w).toContain("already");
    // Must NOT repeat the "relocate further with $DRIVE_PR_STATE_DIR"
    // instruction — for this operator that remedy is impossible.
    expect(w).not.toContain("Relocate further");
    // Still explains the actual constraint: the entry count, not the
    // location, is what every consumer pays for.
    expect(w).toContain("RETIRE");
  });

  it("still recommends relocation when no override is in effect", () => {
    const w = entryCountWarningFor(382_524, false) ?? "";
    expect(w).toContain("Relocate further");
  });

  // The already-relocated remedy used to say the count "only falls as ...
  // worktrees are actually torn down", directing an operator away from
  // `--delete` on a merged/closed PR's own retirable family — a real,
  // applicable remedy the message wrongly implied did not exist.
  it("does not claim worktree teardown is the ONLY way to shrink an already-relocated dir — RETIRE on a retirable family also helps", () => {
    const w = entryCountWarningFor(382_524, true) ?? "";
    expect(w).toContain("--delete");
    expect(w).not.toContain("only falls as");
  });

  it("reports the warning in the JSON report for a real sweep", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });

    // A small dir must carry the field explicitly as null, not omit it —
    // a consumer checking `report.entryCountWarning` should never have to
    // distinguish "healthy" from "this build predates the field".
    expect(r).toHaveProperty("entryCountWarning");
    expect(r.entryCountWarning).toBeNull();
  });

  // Real entry creation and retirement can take a minute on watched volumes.
  it.skipIf(skipLargeCensus)(
    "is based on what THIS run leaves behind, not the pre-cleanup census — a retire crossing the threshold must not still warn",
    async () => {
      const d = freshStateDir();
      const pr = "9001";
      writeFileSync(join(d, `drive-pr-${pr}.json`), "{}");
      writeFileSync(join(d, `drive-pr-${pr}.log`), "log\n");
      backdate(d, 30);
      // Cross the real warning threshold on one merged-PR family. Bound file
      // creation concurrency so setup does not serialize every metadata write.
      await plantRetirableQuarantine(d, pr, 50_010);

      const r = await reapJson(["--delete"], {
        stateDir: d,
        ghDir: GH_MERGED(),
      });

      expect(r.retire.map((x) => x.id)).toEqual([`pr:${pr}`]);
      expect(entriesOf(d)).toEqual([]);
      // The pre-cleanup census genuinely crossed the threshold...
      expect(r.entries).toBeGreaterThanOrEqual(50_000);
      // ...but this run's own retirement cleared the whole family, so the
      // warning must be silent — before this fix it was computed from the
      // pre-cleanup census above and would have fired here regardless.
      expect(r.entryCountWarning).toBeNull();
    },
    60_000,
  );

  it("refuses to infer an override namespace outside a Git clone", async () => {
    const d = freshStateDir();
    const r = await runReap(["--delete"], { stateDir: d, cwd: root });
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("no state dir");
    expect(entriesOf(d)).toEqual([]);
  });

  it("does not read a git TIMEOUT as proof the state dir is not a git repo", async () => {
    // `resolveLegacyStateDir()` collapses EVERY nonzero git result into the
    // identical generic failure, including a deadline-kill — a transient
    // stall proves nothing about whether `stateDir` came from an override,
    // unlike a genuine "fatal: not a git repository". Run from a REAL git
    // repo (so the only reason git fails here is the shim's own timeout,
    // never an actual missing repository) with a `git` that sleeps well
    // past a 1s `$GIT_CALL_TIMEOUT`.
    const d = freshStateDir();
    // Only the identity probe stalls; every other git call (the worktree
    // listing) reaches the real git, so the run spends its one deadline on
    // the call under test.
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git not on PATH");
    const slowGitDir = shimDir("slow-git", {
      git: `case "$1" in rev-parse) sleep 30 ;; *) exec "${realGit}" "$@" ;; esac`,
      gh: 'echo \'{"state":"OPEN"}\'',
    });

    writeFakeProgram(join(slowGitDir, "git"), `#!/bin/sh\nsleep 30\n`);
    const proc = Bun.spawn([process.execPath, REAP, "--json", "--delete"], {
      cwd: repo,
      env: cleanEnv({
        DRIVE_PR_STATE_DIR: d,
        PATH: `${slowGitDir}${delimiter}${process.env.PATH ?? ""}`,
        GIT_CALL_TIMEOUT: "1",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 2);
    expect(stdout).toBe("");
    expect(entriesOf(d)).toEqual([]);
  }, 30_000);
});

describe("growth-rate reporting", () => {
  it("reports `previousSnapshot: null` and `growthPerDay: null` on the very first run", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });

    expect(r.previousSnapshot).toBeNull();
    expect(r.growthPerDay).toBeNull();
  });

  it("a dry run never writes the persisted snapshot", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");

    await reapJson([], { stateDir: d, ghDir: GH_OPEN() });

    expect(existsSync(join(d, ".reap-state-snapshot.json"))).toBe(false);
  });

  it("reports a positive growth rate when entries accumulate between two `--delete` runs", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });
    // Backdate the snapshot this first run just wrote so the elapsed-time
    // divisor is a real, positive number rather than near-zero noise from
    // two calls made microseconds apart.
    const snapshotPath = join(d, ".reap-state-snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      entries: number;
      timestampMs: number;
    };
    writeFileSync(
      snapshotPath,
      JSON.stringify({ ...snapshot, timestampMs: Date.now() - DAY_MS }),
    );
    // One more family's worth of entries since the (backdated) snapshot.
    writeFileSync(join(d, "drive-pr-4173.json"), "{}");

    const r = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });

    expect(r.previousSnapshot).not.toBeNull();
    expect(r.growthPerDay).not.toBeNull();
    expect(r.growthPerDay as number).toBeGreaterThan(0);
  });

  it("the persisted snapshot is the POST-cleanup count, not the pre-cleanup one — a retirement in this run must not inflate the NEXT run’s growth-rate delta", async () => {
    // If the snapshot captured the pre-cleanup count, retiring N entries
    // this run would make next run's delta look like `-N` even with zero
    // real accumulation in between — silently masking genuine growth
    // (findings this exact framing was built to surface). Persisting the
    // post-cleanup count means a retirement in THIS run has no bearing on
    // the NEXT run's comparison at all.
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    backdate(d, 30);
    const r1 = await reapJson(["--delete"], {
      stateDir: d,
      ghDir: GH_MERGED(),
    });
    expect(r1.retire.map((x) => x.id)).toEqual(["pr:4172"]);
    // Everything else in the family retired — only the snapshot file itself
    // (this reaper's own bookkeeping, excluded by `entriesOf`) remains.
    expect(entriesOf(d)).toEqual([]);
    expect(existsSync(join(d, ".reap-state-snapshot.json"))).toBe(true);

    const snapshot = JSON.parse(
      readFileSync(join(d, ".reap-state-snapshot.json"), "utf8"),
    ) as { entries: number; timestampMs: number };
    // Everything this run retired is already gone from the directory by the
    // time the snapshot write runs, so the persisted count reflects the
    // POST-cleanup state directly — zero entries left, in this case.
    expect(snapshot.entries).toBe(0);

    // The claim this test is named for is about the NEXT run's delta, not
    // just this run's persisted count — assert it directly rather than
    // trusting that a zero snapshot implies a correct future comparison.
    // Backdate the just-written snapshot so the
    // elapsed-time divisor is a real, positive number, add exactly one
    // family's worth of genuine accumulation, and confirm the SECOND run
    // reports that accumulation exactly — not `-1` (what a pre-cleanup
    // snapshot would have produced: 0 entries now vs. 1 pre-cleanup then).
    writeFileSync(
      join(d, ".reap-state-snapshot.json"),
      JSON.stringify({ ...snapshot, timestampMs: Date.now() - DAY_MS }),
    );
    writeFileSync(join(d, "drive-pr-4173.json"), "{}");

    const r2 = await reapJson(["--delete"], { stateDir: d, ghDir: GH_OPEN() });

    expect(r2.previousSnapshot).toEqual({
      entries: 0,
      timestampMs: expect.any(Number),
    });
    expect(r2.growthPerDay).toBeCloseTo(1, 1);
  });

  it("surfaces a snapshot write failure through `failures` and a nonzero exit, rather than swallowing it", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    // A directory at the snapshot's own path makes `atomicWrite`'s final
    // `renameSync` fail with EISDIR unconditionally — unlike a chmod-based
    // fixture (see this suite's own note above
    // `anchorStillNeedsCompaction`), renaming a file onto an existing
    // directory is refused by the kernel regardless of privilege, so this
    // is root-proof where a permission-bit fixture would not be.
    mkdirSync(join(d, ".reap-state-snapshot.json"), { recursive: true });

    const r = await runReap(["--json", "--delete"], {
      stateDir: d,
      ghDir: GH_OPEN(),
    });

    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout) as { failures: string[] };
    expect(report.failures.some((f) => f.startsWith("snapshot:"))).toBe(true);
  });
});

describe("the delete-run lock — serialising the sweep and final snapshot publication", () => {
  it("refuses to run while another --delete run’s lock is live, and publishes nothing", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const lockDir = join(d, ".reap-state-delete.lock");
    // A bare, freshly-created directory is exactly what `lib/state/lock.ts`'s
    // `createLock` leaves BEFORE it publishes an identity marker under its
    // own `.recovering` gate — and its mtime alone, not a pid file, is what a
    // contending `acquire()` checks (see `deleteLock`'s own doc comment for
    // why this lock carries no pid at all anymore). Fresh means live: no
    // backdating.
    mkdirSync(lockDir, { recursive: true });

    const r = await runReap(["--delete", "--json"], {
      stateDir: d,
      ghDir: GH_OPEN(),
      // One attempt against the live lock instead of waiting out the
      // production cap on it: the refusal is the same, only sooner.
      env: { DRIVE_PR_LOCK_TIMEOUT: "0" },
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(lockDir);
    // Refused before touching anything — no snapshot published, and the
    // family this run would otherwise have judged is left completely alone.
    expect(existsSync(join(d, ".reap-state-snapshot.json"))).toBe(false);
    expect(existsSync(join(d, "drive-pr-4172.json"))).toBe(true);
  });

  it("breaks a lock left by a crashed run, completes the run, and leaves no LIVE lock behind", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const lockDir = join(d, ".reap-state-delete.lock");
    mkdirSync(lockDir, { recursive: true });
    // Staleness is TIME-based (`DRIVE_PR_LOCK_STALE_MIN`, default 10 minutes)
    // rather than pid-liveness-based now — see `deleteLock`'s own doc comment
    // for the trade. No owner marker planted: a lock crashed between
    // `mkdirSync` and publishing one is exactly the state this exercises, and
    // `generationOf` falls back to an `unowned-<mtime>` key for it.
    const oldSec = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(lockDir, oldSec, oldSec);

    const r = await runReap(["--json", "--delete"], {
      stateDir: d,
      ghDir: GH_OPEN(),
    });

    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout) as { failures: string[] };
    expect(report.failures).toEqual([]);
    // The canonical path is gone — both the broken stale holder's directory
    // and this run's own clean release quarantine to `.stale.<generation>`
    // siblings (compacted to lightweight files by this run's own end-of-run
    // sweep, see `main`'s `finally`), never left standing at `lockDir` itself.
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(join(d, ".reap-state-snapshot.json"))).toBe(true);
  });

  it("excludes a pre-existing stale lock from the entry count and `unrecognised`, and never touches it on a dry run", async () => {
    const d = freshStateDir();
    const lockDir = join(d, ".reap-state-delete.lock");
    mkdirSync(lockDir, { recursive: true });
    const oldSec = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(lockDir, oldSec, oldSec);

    const r = await reapJson([], { stateDir: d, ghDir: GH_OPEN() });

    expect(r.entries).toBe(0);
    expect(r.untouched.unrecognised).toBe(0);
    // Dry runs never reach the lock acquisition at all, stale or not.
    expect(existsSync(lockDir)).toBe(true);
  });

  it("the heartbeat interval keeps the lock’s mtime fresh while a single slow gh call is in flight — deleting the interval or its touchLock() calls would leave nothing to advance it", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const lockDir = join(d, ".reap-state-delete.lock");
    // `main()` awaits `prLifecycles` — one `gh pr view` per family — BEFORE
    // the per-family loop that calls `touchLock()` directly is ever
    // reached, so for the whole of this slow call the ONLY thing able to
    // refresh the lock is the `setInterval(touchLock, lockHeartbeatMs())`
    // registered near the top of `main()`. A regression that deletes that
    // interval (or every direct `touchLock()` call, leaving the function
    // itself dead code) leaves the lock's mtime exactly where `acquire()`
    // left it — this test's own core assertion below.
    const ghDir = ghShim("slow-merged", `sleep 15; echo '{"state":"MERGED"}'`);

    const proc = Bun.spawn([process.execPath, REAP, "--delete", "--json"], {
      cwd: repo,
      env: cleanEnv({
        DRIVE_PR_STATE_DIR: d,
        // A 500ms heartbeat, so a refresh is observable in a few seconds
        // instead of a whole production interval.
        DRIVE_PR_LOCK_HEARTBEAT_MS: "500",
        // Comfortably above the shim's own sleep so `ghCall`'s deadline
        // never fires first and short-circuits the wait this test depends
        // on.
        GH_CALL_TIMEOUT: "50",
        PATH: `${ghDir}${delimiter}${process.env.PATH ?? ""}`,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      for (let i = 0; i < 50 && !existsSync(lockDir); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(lockDir)).toBe(true);
      const initialMtimeMs = statSync(lockDir).mtimeMs;

      // Six heartbeat intervals, still well inside the slow gh call —
      // nothing in `main()` besides the interval has run at all in this
      // window. Without the heartbeat the mtime would be at least this old.
      await new Promise((r) => setTimeout(r, 3_000));

      expect(existsSync(lockDir)).toBe(true);
      const refreshedMtimeMs = statSync(lockDir).mtimeMs;
      expect(refreshedMtimeMs).toBeGreaterThan(initialMtimeMs);
      expect(Date.now() - refreshedMtimeMs).toBeLessThan(2_000);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});

describe("an absent state directory ($DRIVE_PR_STATE_DIR pointed at a location nothing has written to yet)", () => {
  // `resolveStateDir()` deliberately leaves an override directory
  // unmaterialised (`store.ts`'s own doc comment), but `deleteLock(stateDir)`
  // used to be called against it unconditionally. `createLock`'s `acquire()`
  // cannot tell "the lock is contended" apart from "the lock's own parent
  // directory does not exist" — both are a bare `mkdirSync` throw — so it
  // retried for `DELETE_LOCK_MAX_WAIT_SEC` and then reported a misleading
  // lock-acquire-timeout error. `freshStateDir()` eagerly `mkdirSync`s its
  // directory; this suite deliberately does NOT, to reproduce exactly the gap.
  function unmaterializedStateDir(): string {
    return join(root, `state-absent-${n++}`);
  }

  it("reports nothing to reap, in prose, rather than a lock-timeout error", async () => {
    const d = unmaterializedStateDir();
    const r = await runReap(["--delete"], { stateDir: d, ghDir: GH_OPEN() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("does not exist yet");
    expect(r.stdout).not.toContain("timeout");
    expect(existsSync(d)).toBe(false);
  });

  it("reports the same thing as JSON", async () => {
    const d = unmaterializedStateDir();
    const r = await runReap(["--delete", "--json"], {
      stateDir: d,
      ghDir: GH_OPEN(),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      stateDir: join(
        d,
        basename(scopedStateDir(join(root, "key-probe"), repo)),
      ),
      exists: false,
      entries: 0,
    });
  });

  it("behaves identically on a dry run (no --delete, so no lock is even attempted)", async () => {
    const d = unmaterializedStateDir();
    const r = await runReap([], { stateDir: d });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("does not exist yet");
    expect(existsSync(d)).toBe(false);
  });
});

describe("dry run", () => {
  it("reports the same verdicts and changes nothing on disk", async () => {
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const q = plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    backdate(d, 30);
    const before = readdirSync(d).sort();

    const r = await reapJson([], { stateDir: d, ghDir: GH_MERGED() });

    expect(r.retire.map((x) => x.id)).toEqual(["pr:4172"]);
    expect(r.entriesRemoved).toBe(0);
    expect(readdirSync(d).sort()).toEqual(before);
    expect(statSync(q).isDirectory()).toBe(true);
  });

  it("does not COMPACT either, on a family it would keep", async () => {
    // Deliberately a separate fixture from the one above, and the reason is the
    // fail-closed-conjunction rule: in the retire case the quarantine survives
    // because RETIREMENT was skipped, so asserting it there proves nothing
    // about the compaction branch — mutation testing confirmed that probe
    // stayed green with the dry-run guard on compaction deleted outright.
    // Compaction is a mutation too, and a `--delete`-less run that quietly
    // rewrote 112k entries would be the most surprising possible reading of
    // "dry". `GH_OPEN` is what forces the KEEP verdict, making the compaction
    // guard the sole decider.
    const d = freshStateDir();
    writeFileSync(join(d, "drive-pr-4172.json"), "{}");
    const q = plantQuarantine(
      d,
      "drive-pr-4172.json.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const r = await reapJson([], { stateDir: d, ghDir: GH_OPEN() });

    expect(r.retire).toEqual([]);
    // Still REPORTED as compactABLE — the dry run's whole job is to say what
    // `--delete` would do, so a zero here would mean the guard was placed
    // before the accounting instead of before the syscall. `anchorsCompacted`
    // (actual successes) stays 0 in a dry run, which never attempts anything.
    expect(r.anchorsCompactable).toBe(compactsDirectoryFences() ? 1 : 0);
    expect(r.anchorsCompacted).toBe(0);
    expect(statSync(q).isDirectory()).toBe(true);
    expect(existsSync(join(q, "tombstone"))).toBe(true);
  });

  it("says so in the prose report", async () => {
    const d = freshStateDir();
    const r = await runReap([], { stateDir: d });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
  });
});

describe("dry run against the DEFAULT (no $DRIVE_PR_STATE_DIR) resolution path", () => {
  // Every OTHER test in this suite routes through `DRIVE_PR_STATE_DIR`, so none
  // of them exercise `resolveStateDir()`'s own default-path side effects at
  // all. On a clone with no persisted clone identity yet, those side effects
  // (minting `drive-pr-clone-id`, creating the new state directory, possibly
  // writing the migration marker) fired even on a bare (no `--delete`) run,
  // merely to answer "where does state live" — violating this reaper's own "DRY
  // RUN — nothing changed" contract. Needs a REAL repo and a REAL, isolated
  // $HOME (never the shared `repo`/other tests' fixtures, which route around
  // this path entirely): the function under test IS `git rev-parse
  // --git-common-dir` plus the filesystem side effects that follow it.
  function makeIsolatedRepo(name: string): string {
    const dir = join(root, `default-path-repo-${name}`);
    mkdirSync(dir, { recursive: true });
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "test"],
      ["commit", "-q", "--allow-empty", "-m", "root"],
    ]) {
      Bun.spawnSync(["git", ...args], {
        cwd: dir,
        env: cleanEnv({}),
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    return dir;
  }

  it("does not mint a clone identity, create the state dir, or write the marker", async () => {
    const isolatedRepo = makeIsolatedRepo("fresh");
    const isolatedHome = mkdtempSync(join(tmpdir(), "reap-state-home-"));
    try {
      const env = cleanEnv({ HOME: isolatedHome });
      delete env.DRIVE_PR_STATE_DIR;
      const proc = Bun.spawn([process.execPath, REAP], {
        cwd: isolatedRepo,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      // No persisted clone identity exists yet, so the default resolution
      // correctly falls back to `legacyDir` (the repo's real `.git`, which
      // trivially exists) — never "does not exist yet". The report over it
      // finds only ordinary git internals, none of them drive-pr's own.
      expect(exitCode).toBe(0);
      expect(stdout).toContain("DRY RUN");
      expect(stdout).toContain(", 0 families");
      expect(existsSync(join(isolatedHome, ".local"))).toBe(false);
      expect(existsSync(join(isolatedRepo, ".git", "drive-pr-clone-id"))).toBe(
        false,
      );
    } finally {
      rmSync(isolatedRepo, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });
});

describe("the CLI entry-point guard survives a symlinked invocation path", () => {
  // A symlinked checkout is routine for a cron job's working copy. If the
  // entry-point guard failed to recognise the script through the link, it
  // would silently skip `main()`, and the scheduled reaper would do nothing
  // while still exiting 0.
  it("still runs main() when invoked through a symlink", () => {
    // Under `root`, not a separate temp dir — `afterAll` cleans up `root`
    // wholesale, matching every other fixture in this file.
    const linkDir = mkdtempSync(join(root, "reap-symlink-"));
    const link = join(linkDir, "reap-state.ts");
    symlinkSync(REAP, link);
    const proc = Bun.spawnSync([process.execPath, link], {
      cwd: repo,
      env: cleanEnv({ DRIVE_PR_STATE_DIR: freshStateDir() }),
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("DRY RUN");
  });
});

it("expires trace days even when no drive state has been created", async () => {
  const home = join(root, "trace-retention-home");
  const traceDay = join(home, ".local", "state", "jig", "traces", "2000-01-01");
  mkdirSync(traceDay, { recursive: true });
  writeFileSync(join(traceDay, "trace.jsonl"), "{}\n");
  const opts = {
    stateDir: join(home, "missing-state"),
    env: { HOME: home, USERPROFILE: home },
  };
  const dry = await runReap(["--json"], opts);
  expect(dry.exitCode).toBe(0);
  expect(existsSync(traceDay)).toBe(true);
  expect(JSON.parse(dry.stdout).traceDays).toEqual(["2000-01-01"]);
  const removed = await runReap(["--json", "--delete"], opts);
  expect(removed.exitCode).toBe(0);
  expect(existsSync(traceDay)).toBe(false);
});
