/**
 * One process identity and one lease: the rules every component judges a
 * recorded holder by, on synthetic process tables for the rules and on real
 * processes for the probes.
 */
import { describe, expect, it } from "bun:test";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  captureIdentity,
  decodeIdentity,
  encodeIdentity,
  fence,
  type HostIdentity,
  isAlive,
  isAliveSync,
  isStale,
  judge,
  LEDGER_WINDOW_MIN,
  MUTEX_EXPIRY_MIN,
  ownIdentity,
  type ProcessIdentity,
  relate,
  renewLease,
  SESSION_LEASE_MIN,
  sameHost,
  takeLease,
  thisHost,
} from "../liveness.ts";
import type { ProcessRow } from "../process-table.ts";

const HERE: HostIdentity = {
  hostId: "a".repeat(32),
  host: "box",
  bootId: "boot-now",
};

const HOLDER: ProcessIdentity = {
  ...HERE,
  pid: 4242,
  start: "Tue Nov  4 10:00:00 2026",
};

function row(over: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid: HOLDER.pid,
    ppid: 1,
    pgid: HOLDER.pid,
    start: HOLDER.start,
    stat: "S",
    args: "drive",
    ...over,
  };
}

/** A pid that has exited: a child run to completion. */
function deadPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return child.pid;
}

describe("judging a recorded holder", () => {
  it("reads a holder recorded before this host last restarted as dead, even when its pid runs now", () => {
    const before = { ...HOLDER, bootId: "boot-before" };
    const verdict = judge(before, [row()], HERE);
    expect(verdict).toEqual({
      ok: true,
      value: {
        state: "dead",
        reason: `pid 4242 on box, started ${HOLDER.start} ran before this host last restarted`,
      },
    });
    expect(relate(before, { ...HOLDER })).toBe("dead");
  });

  it("reads a pid now held by a process started at another time as dead", () => {
    const verdict = judge(
      HOLDER,
      [row({ start: "Tue Nov  4 11:07:13 2026" })],
      HERE,
    );
    expect(verdict.ok && verdict.value.state).toBe("dead");
    expect(verdict.ok && verdict.value.reason).toBe(
      `pid 4242 now belongs to a process started Tue Nov  4 11:07:13 2026, not the one started ${HOLDER.start}`,
    );
    expect(
      relate(HOLDER, { ...HOLDER, start: "Tue Nov  4 11:07:13 2026" }),
    ).toBe("dead");
  });

  it("takes a start time shifted by whole quarter hours for one read in another time zone", () => {
    const verdict = judge(
      HOLDER,
      [row({ start: "Tue Nov  4 15:30:00 2026" })],
      HERE,
    );
    expect(!verdict.ok && verdict.failure.code).toBe("unverifiable");
    const dayLater = judge(
      HOLDER,
      [row({ start: "Thu Nov  6 10:00:00 2026" })],
      HERE,
    );
    expect(dayLater.ok && dayLater.value.state).toBe("dead");
  });

  it("compares start times on a civil clock, whatever zone or daylight-saving gap the judge is in", async () => {
    const script = `
      import { compareStarts } from ${JSON.stringify(new URL("../liveness.ts", import.meta.url).pathname)};
      process.stdout.write(compareStarts("Sun Mar 29 02:30:00 2026", "Sun Mar 29 03:30:00 2026"));
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: { ...process.env, TZ: "Europe/Amsterdam" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await expectSpawnExited(proc, 0);
    const out = await new Response(proc.stdout).text();
    expect(out).toBe("shifted");
  });

  it("answers unknown, not dead, when a relation rests on start times that may be one start", () => {
    expect(
      relate(HOLDER, { ...HOLDER, start: "Tue Nov  4 15:30:00 2026" }),
    ).toBe("unknown");
  });

  it("judges a holder recorded under the host's earlier name by its process, not as a foreign one", () => {
    const renamed = { ...HOLDER, host: "box.local" };
    expect(sameHost(renamed, HERE)).toBe(true);
    expect(judge(renamed, [row()], HERE)).toEqual({
      ok: true,
      value: {
        state: "alive",
        reason: "pid 4242 still runs",
      },
    });
    expect(relate(renamed, { ...HOLDER })).toBe("same");
  });

  it("leaves a holder on another host id unknown, even under this host's name", () => {
    const elsewhere = { ...HOLDER, hostId: "b".repeat(32) };
    const verdict = judge(elsewhere, [row()], HERE);
    expect(!verdict.ok && verdict.failure.code).toBe("foreign");
    expect(relate(elsewhere, { ...HOLDER })).toBe("foreign");
  });

  it("compares host names only when either side has no host id", () => {
    expect(sameHost({ host: "box" }, HERE)).toBe(true);
    expect(sameHost({ host: "other" }, HERE)).toBe(false);
    expect(sameHost({ host: "" }, HERE)).toBe(true);
  });

  it("reads a missing pid and an exited one as dead, an unreadable table as unknown", () => {
    expect(judge(HOLDER, [], HERE)).toEqual({
      ok: true,
      value: { state: "dead", reason: "no process has pid 4242 now" },
    });
    const zombie = judge(HOLDER, [row({ stat: "Z" })], HERE);
    expect(zombie.ok && zombie.value.state).toBe("dead");
    const unreadable = judge(HOLDER, null, HERE);
    expect(!unreadable.ok && unreadable.failure.code).toBe("unreadable");
  });

  it("cannot tell a reused pid apart without a recorded start time", () => {
    const verdict = judge({ ...HOLDER, start: "" }, [row()], HERE);
    expect(!verdict.ok && verdict.failure.code).toBe("unverifiable");
  });

  it("tells the same process apart from another one on the same host", () => {
    expect(relate(HOLDER, { ...HOLDER })).toBe("same");
    expect(relate(HOLDER, { ...HOLDER, pid: 7 })).toBe("other");
  });
});

describe("real processes", () => {
  it("captures this process's identity on this host and judges it alive", async () => {
    const captured = await captureIdentity();
    if (!captured.ok) throw new Error(captured.failure.reason);
    const here = thisHost();
    expect(captured.value).toMatchObject({
      hostId: here.hostId,
      bootId: here.bootId,
      pid: process.pid,
    });
    expect(captured.value.start).not.toBe("");
    const verdict = await isAlive(captured.value);
    expect(verdict.ok && verdict.value.state).toBe("alive");
  });

  it("judges a process that has exited dead, by the table and by the quick check", async () => {
    const gone = { ...ownIdentity(), pid: deadPid() };
    const verdict = await isAlive(gone);
    expect(verdict.ok && verdict.value.state).toBe("dead");
    const quick = isAliveSync(gone);
    expect(quick.ok && quick.value.state).toBe("dead");
  });

  it("the quick check reads its own process alive and the same pid under another start time dead", () => {
    const self = ownIdentity();
    const verdict = isAliveSync(self);
    const reused = isAliveSync({ ...self, start: "Thu Jan  1 00:00:00 1970" });
    if (process.platform === "win32") {
      // Windows keeps its locks on a pid that answers, as it always has.
      expect(!verdict.ok && verdict.failure.code).toBe("unverifiable");
      expect(!reused.ok && reused.failure.code).toBe("unverifiable");
    } else {
      expect(verdict.ok && verdict.value.state).toBe("alive");
      expect(reused.ok && reused.value.state).toBe("dead");
    }
  });

  it("every process on this machine reads the same host id", () => {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { thisHost } = await import(${JSON.stringify(`${import.meta.dir}/../liveness.ts`)}); console.log(thisHost().hostId);`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(child, 0);
    expect(child.stdout.toString().trim()).toBe(thisHost().hostId);
    expect(thisHost().hostId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the recorded form", () => {
  it("reads back what it writes, and a record written before host ids", () => {
    expect(decodeIdentity(encodeIdentity(HOLDER))).toEqual(HOLDER);
    const older = { host: "box", bootId: "b", pid: 9, start: "s" };
    expect(decodeIdentity(JSON.stringify(older))).toEqual({
      ...older,
      hostId: "",
    });
    expect(decodeIdentity("9")).toBeNull();
    expect(decodeIdentity({ ...HOLDER, pid: 0 })).toBeNull();
    expect(decodeIdentity("{not json")).toBeNull();
  });
});

describe("the lease", () => {
  const now = new Date("2026-11-04T10:00:00.000Z");
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  it("holds until its expiry and is stale from then, unless renewed", () => {
    const lease = takeLease(HOLDER, 3, now, 30);
    expect(lease).toEqual({
      holder: HOLDER,
      generation: 3,
      startedAt: now.toISOString(),
      renewedAt: now.toISOString(),
      expiresAt: later(30).toISOString(),
    });
    expect(isStale(lease, later(29))).toBe(false);
    expect(isStale(lease, later(30))).toBe(true);
    const renewed = renewLease(lease, later(20), 30);
    expect(renewed.startedAt).toBe(now.toISOString());
    expect(isStale(renewed, later(45))).toBe(false);
  });

  it("is stale at once when its holder is dead, and kept when its expiry does not read", () => {
    const lease = takeLease(HOLDER, 1, now);
    expect(
      isStale(lease, now, { ok: true, value: { state: "dead", reason: "x" } }),
    ).toBe(true);
    expect(isStale({ ...lease, expiresAt: "not a time" }, later(10_000))).toBe(
      false,
    );
  });

  it("fences an act on the generation its holder took", () => {
    expect(fence(4, 4)).toEqual({ ok: true, value: 4 });
    const superseded = fence(4, 5);
    expect(!superseded.ok && superseded.failure.code).toBe("superseded");
    const regressed = fence(4, 3);
    expect(!regressed.ok && regressed.failure.code).toBe("regressed");
  });

  it("names three clocks, the mutex shortest and the session lease longest", () => {
    expect(MUTEX_EXPIRY_MIN).toBeLessThan(LEDGER_WINDOW_MIN);
    expect(LEDGER_WINDOW_MIN).toBeLessThan(SESSION_LEASE_MIN);
  });
});
