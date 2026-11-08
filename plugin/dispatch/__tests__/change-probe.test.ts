/**
 * The change probe on a forge the test holds and a clock it moves: a new
 * review comment, a merge or a check that ends on a dispatched pull request
 * wakes that repository's tick at the next probe, a minute later at most; a
 * minute with no change wakes nothing; a change the forge's search reports
 * late is still found; a forge that does not read wakes nothing and keeps
 * what the last probe saw; a run without `--apply` and a machine file with
 * the probe off write and wake nothing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeIdentity, lockIdentity } from "../../shared/liveness.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  FIRST_WINDOW_MS,
  PROBE_OVERLAP_MS,
  type ProbeForge,
  type ProbeRead,
  probe,
  readProbeState,
  searchTime,
} from "../lib/change-probe.ts";
import {
  type MachineConfig,
  readMachineConfig,
} from "../lib/machine-config.ts";

const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const WEB = "/home/person/dev/web";
const API = "/home/person/dev/api";
const IDLE = "/home/person/dev/idle";
const SLUGS: Record<string, string> = {
  [WEB]: "acme/web",
  [API]: "acme/api",
  [IDLE]: "acme/idle",
};

interface FakePr {
  slug: string;
  number: number;
  updatedAt: number;
  head: string;
  checks: string;
  /** The digest of each check; the aggregate `checks` can stay while it moves. */
  detail?: string;
  open: boolean;
  /** The forge's search reports the pull request only from this time on: its index is late. */
  indexedAt?: number;
}

/** A forge holding `prs`, searched at the clock's time, that fails while `down` is set. */
function fakeForge(clock: { at: number }) {
  const state = {
    prs: [] as FakePr[],
    down: false,
    searches: [] as { slugs: string[]; since: string }[],
  };
  const forge: ProbeForge = {
    slug: async (path) =>
      SLUGS[path] === undefined
        ? failed("unreadable", `${path} has no remote`)
        : ok(SLUGS[path] as string),
    search: async (slugs, since): Promise<Outcome<ProbeRead, "unreadable">> => {
      state.searches.push({ slugs: [...slugs], since });
      if (state.down)
        return failed("unreadable", "gh api graphql exited 1: HTTP 502");
      const visible = state.prs.filter(
        (pr) =>
          slugs.includes(pr.slug) && (pr.indexedAt ?? pr.updatedAt) <= clock.at,
      );
      return ok({
        changed: visible
          .filter((pr) => pr.updatedAt >= Date.parse(since))
          .map((pr) => ({
            slug: pr.slug,
            number: pr.number,
            updatedAt: new Date(pr.updatedAt).toISOString(),
          })),
        open: visible
          .filter((pr) => pr.open)
          .map((pr) => ({
            slug: pr.slug,
            number: pr.number,
            head: pr.head,
            checks: pr.checks,
            detail: pr.detail ?? "-",
          })),
        unseen: [],
        calls: 1,
        cost: 1,
        remaining: 4999,
      });
    },
  };
  return { forge, state };
}

function machine(changeProbe = true): MachineConfig {
  const repo = (
    path: string,
    stages: MachineConfig["repositories"][number]["stages"],
  ) => ({
    path,
    stages,
    followupSince: null,
    owner: true,
  });
  return {
    path: "/home/person/.jig/dispatch.yaml",
    repositories: [
      repo(WEB, ["rearm"]),
      repo(API, ["rearm", "notify"]),
      repo(IDLE, []),
    ],
    accounts: [],
    intervalMs: 300_000,
    wallBackoffMs: 3_600_000,
    runtimeTimeoutMs: 60_000,
    unclaimedAfterMs: 900_000,
    workspaceTimeoutMs: 60_000,
    opensPerTick: 4,
    receiptsDays: 30,
    dashboardListen: null,
    sharedRecords: "forge",
    send: true,
    changeProbe,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A probe world: the forge, the clock, the wakes made and the state directory. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "change-probe-"));
  dirs.push(dir);
  const clock = { at: T0, now: () => clock.at };
  const { forge, state } = fakeForge(clock);
  const wakes: { path: string; reason: string }[] = [];
  const run = (apply = true, config = machine()) =>
    probe(config, apply, {
      clock,
      forge,
      dir,
      wake: async (path, reason) => {
        wakes.push({ path, reason });
        return ok("woken");
      },
    });
  return { dir, clock, forge: state, probeForge: forge, wakes, run };
}

/** An open pull request on `slug`, updated `ago` ms before the clock. */
function pr(
  slug: string,
  number: number,
  updatedAt: number,
  fields: Partial<FakePr> = {},
): FakePr {
  return {
    slug,
    number,
    updatedAt,
    head: "a".repeat(40),
    checks: "SUCCESS",
    open: true,
    ...fields,
  };
}

describe("the change probe", () => {
  it("wakes a repository within a minute of a new review comment on one of its pull requests", async () => {
    const w = world();
    w.forge.prs = [
      pr("acme/web", 12, T0 - 3_600_000),
      pr("acme/api", 7, T0 - 3_600_000),
    ];
    const first = await w.run();
    expect(first.ok).toBe(true);
    expect(w.wakes).toEqual([]);
    // A person comments on acme/web#12 twenty seconds after that probe.
    w.clock.at = T0 + 20_000;
    (w.forge.prs[0] as FakePr).updatedAt = w.clock.at;
    w.clock.at = T0 + 60_000;
    const next = await w.run();
    expect(next.ok && next.value.changes.map((c) => c.slug)).toEqual([
      "acme/web",
    ]);
    expect(w.wakes).toEqual([
      {
        path: WEB,
        reason: `probe: acme/web #12 updated ${new Date(T0 + 20_000).toISOString()}`,
      },
    ]);
  });

  it("starts no tick in a minute with no change, and keeps reading", async () => {
    const w = world();
    w.forge.prs = [
      pr("acme/web", 12, T0 - 30_000),
      pr("acme/api", 7, T0 - 3_600_000),
    ];
    // The first probe reads the last minute: acme/web#12 changed in it.
    await w.run();
    expect(w.wakes.map((x) => x.path)).toEqual([WEB]);
    for (let minute = 1; minute <= 3; minute++) {
      w.clock.at = T0 + minute * 60_000;
      const r = await w.run();
      expect(r.ok && r.value.changes).toEqual([]);
    }
    expect(w.wakes.map((x) => x.path)).toEqual([WEB]);
    expect(w.forge.searches).toHaveLength(4);
  });

  it("reads only the repositories with a stage, in one search", async () => {
    const w = world();
    await w.run();
    expect(w.forge.searches).toEqual([
      {
        slugs: ["acme/web", "acme/api"],
        since: searchTime(T0 - FIRST_WINDOW_MS),
      },
    ]);
    w.clock.at = T0 + 60_000;
    await w.run();
    expect(w.forge.searches[1]?.since).toBe(searchTime(T0 - PROBE_OVERLAP_MS));
  });

  it("wakes a repository whose pull request merged", async () => {
    const w = world();
    w.forge.prs = [pr("acme/api", 7, T0 - 3_600_000)];
    await w.run();
    w.clock.at = T0 + 60_000;
    w.forge.prs = [pr("acme/api", 7, T0 + 50_000, { open: false })];
    const r = await w.run();
    expect(r.ok && r.value.changes).toEqual([
      {
        slug: "acme/api",
        paths: [API],
        what: [`#7 updated ${new Date(T0 + 50_000).toISOString()}`],
        woke: { [API]: "woken" },
      },
    ]);
  });

  it("wakes a repository whose checks ended, though the pull request's update time did not move", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 3_600_000, { checks: "PENDING" })];
    await w.run();
    w.clock.at = T0 + 60_000;
    (w.forge.prs[0] as FakePr).checks = "FAILURE";
    await w.run();
    expect(w.wakes).toEqual([
      { path: WEB, reason: "probe: acme/web #12 checks FAILURE" },
    ]);
  });

  it("finds a change the forge's search reports late, and counts no change twice", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 3_600_000)];
    await w.run();
    // Updated at +30s, but the search reports it only from +90s on.
    (w.forge.prs[0] as FakePr).updatedAt = T0 + 30_000;
    (w.forge.prs[0] as FakePr).indexedAt = T0 + 90_000;
    w.clock.at = T0 + 60_000;
    await w.run();
    expect(w.wakes).toEqual([]);
    w.clock.at = T0 + 120_000;
    await w.run();
    expect(w.wakes.map((x) => x.path)).toEqual([WEB]);
    w.clock.at = T0 + 180_000;
    await w.run();
    expect(w.wakes).toHaveLength(1);
  });

  it("wakes nothing and keeps what it saw when the forge does not read", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 3_600_000)];
    await w.run();
    const kept = readProbeState(w.dir);
    w.forge.down = true;
    (w.forge.prs[0] as FakePr).updatedAt = T0 + 30_000;
    w.clock.at = T0 + 60_000;
    const r = await w.run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.reason).toContain("HTTP 502");
    expect(w.wakes).toEqual([]);
    expect(readProbeState(w.dir)).toEqual(kept);
    // Once the forge reads again, the change is found.
    w.forge.down = false;
    w.clock.at = T0 + 120_000;
    await w.run();
    expect(w.wakes.map((x) => x.path)).toEqual([WEB]);
  });

  it("only says what it would wake without --apply, and writes nothing", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    const r = await w.run(false);
    expect(
      r.ok && r.value.changes.map((c) => [c.slug, c.paths, c.woke]),
    ).toEqual([["acme/web", [WEB], undefined]]);
    expect(w.wakes).toEqual([]);
    expect(existsSync(join(w.dir, "state.json"))).toBe(false);
  });

  it("reads and wakes nothing when the machine file turns it off", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    const r = await w.run(true, machine(false));
    expect(r.ok && r.value.status).toBe("off");
    expect(w.forge.searches).toEqual([]);
    expect(w.wakes).toEqual([]);
  });

  it("says which checkouts' repositories did not read, and probes the rest", async () => {
    const w = world();
    const config = machine();
    config.repositories.push({
      path: "/home/person/dev/local",
      stages: ["rearm"],
      followupSince: null,
      owner: true,
    });
    const r = await w.run(true, config);
    expect(r.ok && r.value.unresolved).toEqual([
      {
        path: "/home/person/dev/local",
        reason: "/home/person/dev/local has no remote",
      },
    ]);
    expect(w.forge.searches[0]?.slugs).toEqual(["acme/web", "acme/api"]);
  });

  it("starts over from a state file that does not read", async () => {
    const w = world();
    writeFileSync(join(w.dir, "state.json"), "{not json");
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    const r = await w.run();
    expect(r.ok && r.value.restarted).toContain("is not JSON");
    expect(w.wakes.map((x) => x.path)).toEqual([WEB]);
    expect(readProbeState(w.dir).ok).toBe(true);
  });

  it("keeps no state when a wake fails, so the next probe wakes it again", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    const failing = await probe(machine(), true, {
      clock: w.clock,
      forge: w.probeForge,
      dir: w.dir,
      wake: async () => failed("failed", "the wake did not record: EACCES"),
    });
    expect(failing.ok && failing.value.unkept).toBe("a wake did not record");
    expect(existsSync(join(w.dir, "state.json"))).toBe(false);
  });
  it("wakes when one of several checks ends while the aggregate state stays", async () => {
    const w = world();
    w.forge.prs = [
      pr("acme/web", 12, T0 - 3_600_000, { checks: "PENDING", detail: "aaa" }),
    ];
    await w.run();
    w.clock.at = T0 + 60_000;
    (w.forge.prs[0] as FakePr).detail = "bbb";
    await w.run();
    expect(w.wakes).toEqual([
      {
        path: WEB,
        reason: "probe: acme/web #12 checks PENDING (a check moved)",
      },
    ]);
  });

  it("starts over from a state whose times a date cannot hold", async () => {
    const w = world();
    writeFileSync(
      join(w.dir, "state.json"),
      '{"v":1,"probedAt":1e309,"updated":{},"checks":{},"slugs":{}}',
    );
    expect(readProbeState(w.dir).ok).toBe(false);
    writeFileSync(
      join(w.dir, "state.json"),
      '{"v":1,"probedAt":9e15,"updated":{},"checks":{},"slugs":{}}',
    );
    expect(readProbeState(w.dir).ok).toBe(false);
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    const r = await w.run();
    expect(r.ok && r.value.restarted).toContain("is not a probe's state");
  });

  it("does nothing while another applying probe holds the lock, and releases it after", async () => {
    const w = world();
    w.forge.prs = [pr("acme/web", 12, T0 - 10_000)];
    mkdirSync(join(w.dir, "lock"), { recursive: true });
    writeFileSync(
      join(w.dir, "lock", "waiter"),
      encodeIdentity(lockIdentity()),
    );
    const busy = await w.run();
    expect(busy.ok && busy.value.status).toBe("busy");
    expect(w.wakes).toEqual([]);
    expect(w.forge.searches).toEqual([]);
    rmSync(join(w.dir, "lock"), { recursive: true });
    await w.run();
    expect(w.wakes.length).toBe(1);
    expect(existsSync(join(w.dir, "lock", "waiter"))).toBe(false);
  });

  it("wakes the changed repositories together, not one after another", async () => {
    const w = world();
    w.forge.prs = [
      pr("acme/web", 12, T0 - 10_000),
      pr("acme/api", 3, T0 - 10_000),
    ];
    let live = 0;
    let peak = 0;
    await probe(machine(), true, {
      clock: w.clock,
      forge: w.probeForge,
      dir: w.dir,
      wake: async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return ok("woken");
      },
    });
    expect(peak).toBe(2);
  });
});

describe("the machine file's change_probe switch", () => {
  it("is on unless the file says change_probe: false, and refuses anything but true or false", () => {
    const dir = mkdtempSync(join(tmpdir(), "change-probe-config-"));
    dirs.push(dir);
    const read = (body: string) => {
      const file = join(dir, "dispatch.yaml");
      writeFileSync(file, body);
      return () => readMachineConfig(file)?.changeProbe;
    };
    expect(read("repositories: []\n")()).toBe(true);
    expect(read("change_probe: false\n")()).toBe(false);
    expect(read("change_probe: sometimes\n")).toThrow(
      "change_probe must be true or false",
    );
  });
});
