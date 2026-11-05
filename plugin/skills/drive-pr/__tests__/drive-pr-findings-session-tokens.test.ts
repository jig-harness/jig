/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, rmSync } from "node:fs";

import { hostname } from "node:os";

import { join } from "node:path";

import { dbPathFor } from "../scripts/lib/state/db";

import {
  type Lease,
  leaseRef,
  leaseRefsFor,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease";

import { SCRIPTS, useDrivePrSuite } from "./drive-pr-harness.ts";

import { putLease } from "./state-rows.ts";

import { createFindingsPostFenceFixtures } from "./drive-pr-findings-post-fence-fixtures.ts";

useDrivePrSuite();
describe("assert-post-allowed.ts (the external-mutation fence)", () => {
  const findingsPostFenceFixtures = createFindingsPostFenceFixtures();
  const { stateDirFor, fence, fenceNoOverride } = findingsPostFenceFixtures;

  describe("session-started token (pid recycling)", () => {
    // `isMine` cannot match a held lease against the caller's session on
    // (pid, host) alone. If a driver dies and the OS later recycles its
    // exact pid for an unrelated NEW drive-pr session, this caller's
    // inherited $DRIVE_PR_SESSION still names that pid — these probes fake
    // that exact shape by seeding a lease under THIS TEST'S OWN pid (always
    // alive) while asserting a DIFFERENT $DRIVE_PR_SESSION_STARTED than the
    // stored one, the token `drive.ts` mints once per launch and exports
    // alongside $DRIVE_PR_SESSION.
    function seedLease(
      d: string,
      actor: string,
      sessionStarted: string,
    ): Lease {
      return putLease(leaseRef(d, "999", actor), {
        pid: process.pid,
        host: hostname(),
        worktree: "/some/other/tree",
        command: "hold",
        sessionStarted,
      });
    }

    it("refuses a pid-recycled lease that carries a DIFFERENT session-started token, even though pid+host match", async () => {
      const d = stateDirFor("token-mismatch");
      seedLease(d, "wt-000000000000f00d", "new-session-token");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "old-driver-token",
      });
      expect(r.exitCode).toBe(11);
    });

    it("still recognizes its own lease when the session-started token matches", async () => {
      const d = stateDirFor("token-match");
      seedLease(d, "wt-000000000000face2", "same-token");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "same-token",
      });
      expect(r.exitCode).toBe(0);
    });

    it("falls back to bare pid+host when THIS caller carries no session-started token (a tokenless harness, SKILL.md § 6)", async () => {
      const d = stateDirFor("token-none-none");
      seedLease(d, "wt-0000000000000leg", "");
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

    it("refuses when this caller carries no token but the stored lease does (proof of a different process)", async () => {
      const d = stateDirFor("token-none-vs-some");
      seedLease(d, "wt-0000000000000tkn", "some-token");
      // See the sibling test above for why this must be forced rather than
      // left to an ambient default.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "",
      });
      expect(r.exitCode).toBe(11);
    });

    it("accepts sessionStarted: '' — a token-LESS session is legal", async () => {
      // An interactive $CLAUDE_PID session, or a hand-set $DRIVE_PR_SESSION,
      // genuinely carries no token and writes ''. That record is a genuine
      // lease and must still refuse a caller that carries a token.
      const d = stateDirFor("token-field-empty");
      seedLease(d, "wt-0000000000000fff", "");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "caller-has-a-token",
      });
      expect(r.exitCode).toBe(11); // parsed as a genuine, live, foreign lease
    });
  });

  describe("$DRIVE_PR_STATE_DIR_IDENTITY — the driver-established baseline", () => {
    // The window every OTHER identity check in this fence is blind to: the
    // database was replaced BEFORE this pass started. The fence then reads
    // the replacement, captures ITS identity, finds it perfectly stable for
    // the whole run, and authorizes the post — while the leases the drive's
    // other sessions took are gone with the database they were in. Only a
    // baseline observed before the replacement can answer that, and the
    // driver is the one thing that observed it.

    it("fails CLOSED when the database was deleted and created again BEFORE the pass started", async () => {
      // Fixture built so this clause is the SOLE decider: the replacement is a
      // real, readable, EMPTY database at the same path, so every other check
      // in the chain passes and a fence without the baseline would authorize
      // the post with exit 0. Only the driver baseline differs.
      const original = stateDirFor("identity-replaced-before");
      const identity = stateDirIdentityToken(original);
      expect(identity).not.toBe(""); // the baseline itself must be real

      // The replacement: delete the database, its write-ahead log and its
      // shared-memory index; the next open creates an empty one at the same
      // path. No error is raised anywhere by either step.
      const db = dbPathFor(original);
      for (const f of [db, `${db}-wal`, `${db}-shm`])
        rmSync(f, { force: true });

      const r = await fence(original, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: identity,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not the one this drive opened");

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
      // would preserve an unfenced, baseline-less behaviour indefinitely — the
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
      // anomaly. This is why refusing a baseline-less override costs nothing
      // legitimate.
      const r = await fenceNoOverride(["--pr", "999"]);
      expect(r.exitCode).toBe(0);
    });

    it("fails CLOSED on a baseline that is PRESENT but names no database", async () => {
      // Absent and malformed are different questions: something set this and
      // this process cannot tell what it meant, in front of a mutation with
      // no undo. A value that is no database's instance id is a database
      // this drive did not open.
      const d = stateDirFor("identity-malformed");
      for (const bad of ["garbage", "12:", ":34", "1:2:3", "x:y"]) {
        const r = await fence(d, ["--pr", "999"], {
          DRIVE_PR_STATE_DIR_IDENTITY: bad,
        });
        expect({ bad, code: r.exitCode }).toEqual({ bad, code: 1 });
        expect(r.stderr).toContain("is not the one this drive opened");
      }
    });
  });

  describe("the database identity and the lease key", () => {
    it("drive.ts refuses rather than omitting the database's identity", () => {
      // A real database always has an identity: the baseline a driver
      // exports is never empty for one it could open.
      expect(stateDirIdentityToken(stateDirFor("identity-real"))).not.toBe("");

      // And the consumer fails closed on an empty one. PINNED from source
      // rather than executed, deliberately: `drive.ts` opens its database
      // before reaching this guard, so an empty identity is not something a
      // deterministic fixture can stage. So the pin is structural: the
      // empty-identity branch holds nothing but the never-returning
      // `fail(1, …)`, the export follows that branch unconditionally at the
      // same block level, and it is the only assignment of the variable. Any
      // form that continues startup without a baseline breaks one of the
      // three.
      const src = readFileSync(
        join(SCRIPTS, "lib", "driver", "main.ts"),
        "utf8",
      );
      expect(src).toMatch(
        /\n( +)const stateDirIdentity = stateDirIdentityToken\(stateDir\);\n\1if \(stateDirIdentity === ""\) \{\n\1 {2}fail\(\n\1 {4}1,\n\1 {4}`drive\.ts: could not establish the identity of the drive's database:`,\n(?:\1 {4}[^\n]*\n)*\1 {2}\);\n\1\}\n\1process\.env\.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentity;\n/,
      );
      expect(src.match(/DRIVE_PR_STATE_DIR_IDENTITY\s*=/g)).toHaveLength(1);
    });

    it("a lease's writer and its readers agree on a NONCANONICAL pr", () => {
      // A producer that persisted whatever spelling it was handed would key
      // an explicit `0999` apart from `999`, while a posting caller
      // canonicalizes its own target to `999` and looks for that — missing
      // the live lease and authorizing the reply. Canonicalizing at the
      // shared boundary is what makes the two agree by construction.
      const d = stateDirFor("pr-canonicalization");
      const actor = "wt-0000000000000abc";
      const padded = leaseRef(d, "0999", actor);
      const plain = leaseRef(d, "999", actor);
      expect(padded).toEqual(plain);

      // And the readers find a lease written under the padded spelling.
      putLease(padded, { pid: process.pid, host: hostname(), worktree: "/w" });
      expect(leaseRefsFor(d, "999")).toEqual([plain]);
      expect(leaseRefsFor(d, "0999")).toEqual([plain]);
    });
  });
});
