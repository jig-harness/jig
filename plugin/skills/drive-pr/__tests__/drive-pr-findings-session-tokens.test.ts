/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

import { hostname, tmpdir } from "node:os";

import { join } from "node:path";

import {
  leaseFilesFor,
  leasePathFor,
  parseDirIdentityToken,
  parseLease,
  readLease,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease";

import { SCRIPTS, useDrivePrSuite } from "./drive-pr-harness.ts";

import { createFindingsPostFenceFixtures } from "./drive-pr-findings-post-fence-fixtures.ts";

useDrivePrSuite();
describe("assert-post-allowed.ts (the external-mutation fence)", () => {
  const findingsPostFenceFixtures = createFindingsPostFenceFixtures();
  const { stateDirFor, fence, fenceNoOverride } = findingsPostFenceFixtures;

  describe("session-started token (pid recycling)", () => {
    // `isMine` used to match a held lease against the caller's session on
    // (pid, host) alone. If a driver dies and the OS later recycles its
    // exact pid for an unrelated NEW drive-pr session, this caller's
    // inherited $DRIVE_PR_SESSION still names that pid — these probes fake
    // that exact shape by seeding a lease under THIS TEST'S OWN pid (always
    // alive) while asserting a DIFFERENT $DRIVE_PR_SESSION_STARTED than the
    // one on disk, the token `drive.ts` mints once per launch and exports
    // alongside $DRIVE_PR_SESSION.
    function leaseJson(actor: string, sessionStarted: string): string {
      return JSON.stringify({
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor,
        worktree: "/some/other/tree",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "b".repeat(32),
        sessionStarted,
      });
    }

    it("refuses a pid-recycled lease that carries a DIFFERENT session-started token, even though pid+host match", async () => {
      const d = stateDirFor("token-mismatch");
      const foreignActor = "wt-000000000000f00d";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        leaseJson(foreignActor, "new-session-token"),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "old-driver-token",
      });
      expect(r.exitCode).toBe(11);
    });

    it("still recognizes its own lease when the session-started token matches", async () => {
      const d = stateDirFor("token-match");
      const sameActor = "wt-000000000000face2";
      writeFileSync(
        leasePathFor(d, "999", sameActor),
        leaseJson(sameActor, "same-token"),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "same-token",
      });
      expect(r.exitCode).toBe(0);
    });

    it("falls back to bare pid+host when THIS caller carries no session-started token (legacy harness, SKILL.md § 6)", async () => {
      const d = stateDirFor("token-none-none");
      const legacyActor = "wt-0000000000000leg";
      writeFileSync(
        leasePathFor(d, "999", legacyActor),
        leaseJson(legacyActor, ""),
      );
      // Forced to '' rather than merely omitted: this suite may itself be
      // running under a live drive.ts orchestration, whose own
      // $DRIVE_PR_SESSION_STARTED `gitCleanEnv()` would otherwise carry
      // straight through and silently give this caller a token after all —
      // the exact ambient leak that makes "carries no token" a claim this
      // test must assert explicitly, not assume from an unset override.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "",
      });
      expect(r.exitCode).toBe(0);
    });

    it("refuses when this caller carries no token but the on-disk lease does (proof of a different process)", async () => {
      const d = stateDirFor("token-none-vs-some");
      const foreignActor = "wt-0000000000000tkn";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        leaseJson(foreignActor, "some-token"),
      );
      // See the sibling test above for why this must be forced rather than
      // left to an ambient default.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "",
      });
      expect(r.exitCode).toBe(11);
    });

    it("REFUSES a lease with no sessionStarted key — the field is required, not tolerated", async () => {
      // No `sessionStarted` key at all — the shape a lease written by
      // superseded code has on disk. An earlier revision normalized it to ''
      // so such records kept parsing; that is an accepts-both-shapes parser,
      // which the pre-GA BWC stance rules out, and it quietly kept the weaker
      // pid/host-only ownership decision alive for exactly those records.
      //
      // The case that must keep working is a token-LESS session, and it does:
      // the VALUE '' is legal (asserted in the sibling test below). Only the
      // absent KEY is rejected, and lease state is ephemeral, so that is a
      // rollout detail rather than a migration.
      const d = stateDirFor("token-field-missing");
      const legacyActor = "wt-0000000000000pre";
      writeFileSync(
        leasePathFor(d, "999", legacyActor),
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: legacyActor,
          worktree: "/some/other/tree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          // sessionStarted omitted deliberately.
        }),
      );
      // Exit 1, not 11: the record no longer parses, so it is UNREADABLE
      // rather than a nameable holder — and the fence's standing rule is that
      // a lease file it enumerated but cannot read is the question going
      // unanswered, never an all-clear. The one thing it must not be is
      // exit 0.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "caller-has-a-token",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("could not be read");
    });

    it("accepts sessionStarted: '' — a token-LESS session is legal, only the absent key is not", async () => {
      // The distinction the strict read turns on, and the reason it costs
      // nothing: an interactive $CLAUDE_PID session, or a hand-set
      // $DRIVE_PR_SESSION, genuinely carries no token and writes ''. That
      // record must parse and must still refuse a foreign live session.
      const d = stateDirFor("token-field-empty");
      const foreignActor = "wt-0000000000000fff";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: foreignActor,
          worktree: "/some/other/tree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "caller-has-a-token",
      });
      expect(r.exitCode).toBe(11); // parsed as a genuine, live, foreign lease
    });
  });

  describe("$DRIVE_PR_STATE_DIR_IDENTITY — the driver-established baseline", () => {
    // The window every OTHER identity check in this fence is blind to: the
    // swap completed BEFORE this pass started. The fence then enumerates the
    // replacement, captures ITS identity, finds it perfectly stable for the
    // whole run, and authorizes the post — while the live lease sits in the
    // directory that moved. Only a baseline observed before the swap can
    // answer that, and the driver is the one thing that observed it.

    it("fails CLOSED when the directory was swapped BEFORE the pass started", async () => {
      // Fixture built so this clause is the SOLE decider: the replacement is a
      // real, readable, EMPTY directory, so every other check in the chain
      // passes and the unfixed code authorizes the post with exit 0. Only the
      // driver baseline differs.
      const original = stateDirFor("identity-swapped-before");
      const identity = stateDirIdentityToken(original);
      expect(identity).not.toBe(""); // the baseline itself must be real

      // The swap: move the real directory aside, put an empty one at the
      // same pathname. No ENOENT is raised anywhere by either operation.
      const moved = `${original}-moved`;
      renameSync(original, moved);
      mkdirSync(original);

      const r = await fence(original, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: identity,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("not the one this drive resolved");

      // Mutation check: the SAME fixture with a baseline naming the
      // REPLACEMENT passes. Everything else in the chain is identical — the
      // replacement is real, readable and empty — so the identity comparison
      // is provably the sole decider, and the refusal above is not some
      // earlier clause firing.
      //
      // (Phrased as a matching baseline rather than an absent one, because
      // an absent baseline on the override path refuses in its
      // own right, which would make an absent-baseline mutation check pass
      // for the wrong reason.)
      const matching = await fence(original, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(original),
      });
      expect(matching.exitCode).toBe(0);
    });

    it("allows when the inherited baseline still matches", async () => {
      const d = stateDirFor("identity-matches");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(d),
      });
      expect(r.exitCode).toBe(0);
    });

    it("REFUSES an absent baseline on the override path — no compatibility path for superseded drivers", async () => {
      // `$DRIVE_PR_STATE_DIR` is set only by `drive.ts`, which either exports
      // the identity beside it or refuses to start. So an override arriving
      // without one can only come from a superseded driver, and allowing it
      // would preserve the unfenced pre-baseline behaviour indefinitely — the
      // dual-path tolerance pre-GA policy rejects.
      const d = stateDirFor("identity-absent");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: "",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(
        "$DRIVE_PR_STATE_DIR is set but $DRIVE_PR_STATE_DIR_IDENTITY is not",
      );
    });

    it("still allows a baseline-less caller on the NON-override path", async () => {
      // The case the refusal above must not catch: no `$DRIVE_PR_STATE_DIR`
      // at all, which is how `/resolve-review-comments` runs standalone. That
      // path resolves the state dir itself and has never had a baseline to
      // inherit, so "never existed" stays the ordinary case rather than an
      // anomaly. This is why removing the override-path compatibility branch
      // costs nothing legitimate.
      const r = await fenceNoOverride(["--pr", "999"]);
      expect(r.exitCode).toBe(0);
    });

    it("FOLLOWS a symlinked state dir, so a swap of its TARGET is caught", async () => {
      // The link's own inode is untouched by a target rename-and-recreate, so
      // an `lstat`-based identity matches straight through the swap while
      // `readdirSync` — which follows — enumerates the replacement. Fixture
      // is built so the identity clause is the sole decider: the replacement
      // target is a real, readable, EMPTY directory, so everything else in
      // the chain passes and only the followed-vs-not choice decides.
      const parent = mkdtempSync(join(tmpdir(), "fence-symlink-target-"));
      const target = join(parent, "real-state");
      mkdirSync(target);
      const link = join(parent, "state-link");
      symlinkSync(target, link);

      // Baseline captured through the link, as the driver would.
      const identity = stateDirIdentityToken(link);
      expect(identity).not.toBe("");

      // Swap the TARGET, leaving the link itself completely untouched.
      renameSync(target, `${target}-moved`);
      mkdirSync(target);

      const r = await fence(link, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: identity,
      });
      expect(r.exitCode).toBe(1);
      // Mutation check: the link's own inode did NOT change, so an
      // lstat-based identity would have matched and returned 0 here. That is
      // what makes this test about following the link and nothing else.
      expect(stateDirIdentityToken(link)).not.toBe(identity);
    });

    it("fails CLOSED on a baseline that is PRESENT but unparseable", async () => {
      // Absent and malformed are different questions: something set this and
      // this process cannot tell what it meant, in front of a mutation with
      // no undo.
      const d = stateDirFor("identity-malformed");
      for (const bad of ["garbage", "12:", ":34", "1:2:3", "x:y"]) {
        const r = await fence(d, ["--pr", "999"], {
          DRIVE_PR_STATE_DIR_IDENTITY: bad,
        });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(
          "$DRIVE_PR_STATE_DIR_IDENTITY is set but not a '<dev>:<ino>' pair",
        );
      }
    });
  });

  describe("single-snapshot lease decisions", () => {
    it("parseLease REJECTS a record whose sessionStarted key is absent, and accepts an empty one", () => {
      // The unit-level statement of the same rule the fence tests above
      // exercise end-to-end. Asserted on the parser directly so a future
      // refactor that reintroduces the lenient default fails here first,
      // where the reason is written down.
      const base = {
        holder: "session",
        pid: 1,
        host: "h",
        platform: "darwin",
        actor: "wt-1",
        worktree: "/w",
        startedAt: "2026-01-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "f".repeat(32),
      };
      expect(parseLease(JSON.stringify(base))).toBeNull();
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: 5 })),
      ).toBeNull();
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: "" }))
          ?.sessionStarted,
      ).toBe("");
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: "tok" }))
          ?.sessionStarted,
      ).toBe("tok");
    });

    it("stateDirIdentityToken reports UNREADABLE as empty, and drive.ts refuses on it rather than omitting the baseline", () => {
      // Two halves of the same guard.
      //
      // The contract: '' means "could not establish", never "there is none".
      expect(
        stateDirIdentityToken(join(tmpdir(), "definitely-not-here-4107")),
      ).toBe("");
      expect(stateDirIdentityToken(tmpdir())).not.toBe("");

      // And the consumer fails closed on it. PINNED from source rather than
      // executed, deliberately: `drive.ts` resolves its state directory and
      // writes its driver log INTO it before reaching this guard, so by the
      // time the guard runs a stat failure is only reachable as a transient
      // race that no deterministic fixture can stage. That is exactly the
      // case at issue, and a verbatim pin beats a text-matching model for
      // "does this code actually do X" — so the pin is on the refusal itself,
      // and it fails if the omit-the-variable form ever returns.
      const src = readFileSync(
        join(SCRIPTS, "lib", "driver", "main.ts"),
        "utf8",
      );
      expect(src).toContain(
        "could not establish the identity of the drive state directory",
      );
      expect(src).toContain(
        "process.env.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentity;",
      );
      // The superseded shape: exporting only when non-empty, i.e. treating an
      // unreadable identity as "no baseline inherited".
      expect(src).not.toMatch(
        /if\s*\(\s*stateDirIdentity\s*!==?\s*(["'`])\1\s*\)\s*\{?\s*process\.env\.DRIVE_PR_STATE_DIR_IDENTITY/,
      );
    });

    it("carries a 64-bit dev/ino through the token without rounding", () => {
      // Node's NUMERIC stat fields round past Number.MAX_SAFE_INTEGER, and
      // filesystems do expose dev/ino above it. Rounding either compares two
      // different directories as identical — a swap the fence should catch —
      // or, with a safe-integer guard, refuses every child fence on such a
      // machine even though nothing moved.
      //
      // Asserted on the token grammar rather than on a real filesystem,
      // because staging a >2^53 inode is not something a test can arrange
      // portably. The property under test is the transport: a value that
      // Number cannot represent exactly must survive the round trip.
      const big = 2n ** 63n - 1n;
      const token = `${big}:${big + 1n}`;
      expect(Number(big).toString()).not.toBe(big.toString()); // rounds, as Number
      expect(parseDirIdentityToken(token)).toEqual({
        kind: "ok",
        id: { dev: big, ino: big + 1n },
      });

      // And a real directory's token round-trips to the same identity the
      // producer computed, so the grammar above is the one actually used.
      const d = stateDirFor("identity-roundtrip");
      const st = statSync(d, { bigint: true });
      expect(parseDirIdentityToken(stateDirIdentityToken(d))).toEqual({
        kind: "ok",
        id: { dev: st.dev, ino: st.ino },
      });
    });

    it("leasePathFor and the reader agree on a NONCANONICAL pr", () => {
      // The producer used to persist whatever spelling it was handed, so an
      // explicit `0999` wrote `pr-drive-lease-0999-*` while a posting caller
      // canonicalized its own target to `999` and filtered on that prefix —
      // missing the live lease and authorizing the reply. Canonicalizing at
      // the shared boundary is what makes the two agree by construction.
      const d = stateDirFor("pr-canonicalization");
      const actor = "wt-0000000000000abc";
      const padded = leasePathFor(d, "0999", actor);
      const plain = leasePathFor(d, "999", actor);
      expect(padded).toBe(plain);

      // And the reader finds a lease written under the padded spelling.
      writeFileSync(
        padded,
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor,
          worktree: "/w",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      expect(leaseFilesFor(d, "999")).toEqual([plain]);
      expect(leaseFilesFor(d, "0999")).toEqual([plain]);
    });

    it("parseLease decides from the TEXT it is handed, never by re-reading a path", () => {
      // The property that closes the file-only swap: the fence reads the
      // bytes once and judges those bytes. If the parser could still be fed a
      // pathname, a rename-and-replace between the read and the parse would
      // decide the outcome. Handing it text that no file contains — while a
      // file of the same name holds something different — is what proves the
      // decision is snapshot-bound.
      const d = stateDirFor("single-snapshot");
      const p = leasePathFor(d, "999", "wt-0000000000000abc");
      const live = {
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor: "wt-0000000000000abc",
        worktree: "/w",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "f".repeat(32),
        sessionStarted: "the-snapshot",
      };
      writeFileSync(p, JSON.stringify({ ...live, sessionStarted: "ON-DISK" }));
      // Same path on disk says 'ON-DISK'; the parser is handed 'the-snapshot'
      // and must answer about what it was handed.
      expect(parseLease(JSON.stringify(live))?.sessionStarted).toBe(
        "the-snapshot",
      );
      expect(readLease(p)?.sessionStarted).toBe("ON-DISK");
    });
  });
});
