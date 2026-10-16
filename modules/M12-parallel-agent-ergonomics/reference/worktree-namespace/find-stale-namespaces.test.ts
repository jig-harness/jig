import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  classify,
  liveNames,
  main,
  parseInventory,
  parseOptions,
  parseTime,
  plan,
} from "./find-stale-namespaces.ts";

const script = join(import.meta.dir, "find-stale-namespaces.ts");
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const NOW = "2026-01-01T12:00:00Z";
const naming = { prefix: "wt_", maxLength: 63 };

function run(args: string[], input = "") {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((n) => n === key.toUpperCase())
    )
      env[key] = value;
  const r = spawnSync(process.execPath, [script, "--now", NOW, ...args], {
    env,
    input,
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

const alice = (
  extra: string[] = [],
  inventory = "inventory.json",
  live = "live.txt",
) =>
  run([
    "--owner",
    "alice",
    "--inventory",
    fixture(inventory),
    "--live",
    fixture(live),
    "--production",
    "public",
    ...extra,
  ]);

describe("the plan", () => {
  test("names what to reap and why, what is unlabelled, and what it left alone", () => {
    const r = alice();
    expectSpawnExit(r, 1);
    expect(r.stdout.trim().split("\n")).toEqual([
      "STALE — 2 namespace(s) to reap for alice (1 expired, 1 orphaned), 1 unlabelled; 1 live, 1 of other owners, 1 outside the prefix, public refused as production",
      "  - wt_feature_receipts_0f6b13763eaaec46: expired 2025-12-30T00:00:00Z",
      "  - wt_fix_rounding_7638af83318d09c1: orphaned (no live worktree derives it)",
      "  - wt_spike_pricing_786091497b11ad66: unlabelled (no expires_at), not reaped",
    ]);
  });

  test("the JSON form carries the same plan", () => {
    const r = alice(["--json"]);
    expectSpawnExit(r, 1);
    const p = JSON.parse(r.stdout);
    expect(p.reap.map((x: { name: string }) => x.name)).toEqual([
      "wt_feature_receipts_0f6b13763eaaec46",
      "wt_fix_rounding_7638af83318d09c1",
    ]);
    expect(p.live).toEqual(["wt_feature_refunds_190b79a5137797d4"]);
    expect(p.foreign).toBe(1);
    expect(p.outside).toBe(1);
    expect(p.production).toBe("public");
  });

  test("nothing stale passes and still counts what it saw", () => {
    const r = alice([], "all-live.json");
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe(
      "OK — nothing to reap for alice; 2 live, 0 of other owners, 0 outside the prefix",
    );
  });

  test("the production namespace is refused even when it carries the prefix and has expired", () => {
    const r = run([
      "--owner",
      "alice",
      "--production",
      "wt_feature_receipts_0f6b13763eaaec46",
      "--inventory",
      fixture("inventory.json"),
      "--live",
      fixture("live.txt"),
      "--json",
    ]);
    expectSpawnExit(r, 1);
    const p = JSON.parse(r.stdout);
    expect(p.production).toBe("wt_feature_receipts_0f6b13763eaaec46");
    expect(p.reap.map((x: { name: string }) => x.name)).toEqual([
      "wt_fix_rounding_7638af83318d09c1",
    ]);
  });

  test("another owner's reaper sees the same inventory differently", () => {
    const r = run([
      "--owner",
      "bob",
      "--inventory",
      fixture("inventory.json"),
      "--live",
      fixture("live.txt"),
      "--production",
      "public",
      "--json",
    ]);
    expectSpawnExit(r, 1);
    const p = JSON.parse(r.stdout);
    expect(p.reap).toEqual([
      {
        name: "wt_feature_exports_9e853fe34314e304",
        reason: "expired",
        expires_at: "2025-01-01T00:00:00Z",
      },
    ]);
    expect(p.unlabelled).toEqual([]);
    expect(p.foreign).toBe(4);
  });

  test("reads the inventory from standard input as -", () => {
    const r = run(
      [
        "--owner",
        "alice",
        "--inventory",
        "-",
        "--live",
        fixture("live.txt"),
        "--production",
        "public",
      ],
      '[{"name":"wt_main_0d6e4079e36703eb","owner":"alice","expires_at":"2027-01-01T00:00:00Z"}]',
    );
    expectSpawnExit(r, 0);
  });

  test("an expired namespace named like production is still refused", () => {
    const r = run(
      [
        "--owner",
        "alice",
        "--inventory",
        "-",
        "--live",
        fixture("live.txt"),
        "--production",
        "wt_production",
        "--json",
      ],
      '[{"name":"wt_production","owner":"alice","expires_at":"2025-01-01T00:00:00Z"}]',
    );
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      reap: [],
      production: "wt_production",
    });
  });
});

describe("fails closed", () => {
  for (const [label, args] of [
    [
      "an inventory that is not JSON",
      ["--inventory", fixture("not-json.json"), "--live", fixture("live.txt")],
    ],
    [
      "an inventory that is not an array",
      ["--inventory", fixture("not-array.json"), "--live", fixture("live.txt")],
    ],
    [
      "an entry without a name",
      ["--inventory", fixture("no-name.json"), "--live", fixture("live.txt")],
    ],
    [
      "an expiry without a zone",
      [
        "--inventory",
        fixture("bad-expiry.json"),
        "--live",
        fixture("live.txt"),
      ],
    ],
    [
      "an empty live list",
      [
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("empty-live.txt"),
      ],
    ],
    [
      "a live listing with a detached worktree",
      [
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("detached-live.txt"),
      ],
    ],
    [
      "a prefix too long for the default max length",
      [
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("live.txt"),
        "--prefix",
        `w${"x".repeat(59)}`,
      ],
    ],
    [
      "a missing inventory file",
      ["--inventory", fixture("nowhere.json"), "--live", fixture("live.txt")],
    ],
    [
      "an empty prefix",
      [
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("live.txt"),
        "--prefix",
        "",
      ],
    ],
    [
      "an unknown option",
      [
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("live.txt"),
        "--apply",
      ],
    ],
  ] as [string, string[]][])
    test(label, () => {
      const r = run(["--owner", "alice", "--production", "public", ...args]);
      expectSpawnExit(r, 2);
      expect(r.stdout).toBe("");
    });

  for (const [label, input] of [
    [
      "an entry with a blank owner",
      '[{"name":"wt_x","owner":" ","expires_at":"2025-01-01T00:00:00Z"}]',
    ],
    [
      "two entries of one name that disagree",
      '[{"name":"wt_x","owner":"bob","expires_at":"2027-01-01T00:00:00Z"},{"name":"wt_x","owner":"alice","expires_at":"2025-01-01T00:00:00Z"}]',
    ],
  ] as [string, string][])
    test(label, () => {
      const r = run(
        [
          "--owner",
          "alice",
          "--production",
          "public",
          "--inventory",
          "-",
          "--live",
          fixture("live.txt"),
        ],
        input,
      );
      expectSpawnExit(r, 2);
      expect(r.stdout).toBe("");
    });

  test("a live list of bare branch names is not porcelain output", () => {
    const r = run(
      [
        "--owner",
        "alice",
        "--production",
        "public",
        "--inventory",
        fixture("inventory.json"),
        "--live",
        "-",
      ],
      "main\nfeature/refunds\n",
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("not `git worktree list --porcelain` output");
  });

  for (const flag of ["--owner", "--production"])
    test(`${flag} is required`, () => {
      const args = [
        "--owner",
        "alice",
        "--production",
        "public",
        "--inventory",
        fixture("inventory.json"),
        "--live",
        fixture("live.txt"),
      ];
      args.splice(args.indexOf(flag), 2);
      const r = run(args);
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain(`${flag} is required`);
    });

  test("two identical entries of one name are read as one", () => {
    const entry = {
      name: "wt_x",
      owner: "alice",
      expires_at: "2025-01-01T00:00:00Z",
    };
    expect(parseInventory([entry, { ...entry }])).toEqual([entry]);
  });

  test("the live names skip a bare main repository and keep every branch", () => {
    const listing = [
      "worktree /work/shop.git",
      "bare",
      "",
      "worktree /work/shop-refunds",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/refunds",
      "",
    ].join("\n");
    expect([...liveNames(listing, naming)]).toEqual([
      "wt_feature_refunds_190b79a5137797d4",
    ]);
  });

  test("the live names accept a locked and a prunable worktree with reasons", () => {
    const listing = [
      "worktree /work/shop",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "locked held by a release",
      "",
      "worktree /work/shop-refunds",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/refunds",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(liveNames(listing, naming).size).toBe(2);
  });

  const main = [
    "worktree /work/shop",
    "HEAD 1111111111111111111111111111111111111111",
  ];
  for (const [label, record] of [
    [
      "a second branch line",
      [...main, "branch refs/heads/main", "branch refs/heads/topic"],
    ],
    ["an unexpected line", [...main, "branch refs/heads/main", "frobnicate"]],
    ["no HEAD line", ["worktree /work/shop", "branch refs/heads/main"]],
    [
      "a HEAD that is no object id",
      ["worktree /work/shop", "HEAD main", "branch refs/heads/main"],
    ],
    [
      "both branch and detached",
      [...main, "branch refs/heads/main", "detached"],
    ],
    ["neither branch nor detached", main],
    [
      "a branch outside refs/heads",
      [...main, "branch refs/remotes/origin/main"],
    ],
    [
      "a second worktree line in one record",
      [...main, "branch refs/heads/main", "worktree /work/other"],
    ],
    [
      "a bare record with a branch",
      ["worktree /work/shop.git", "bare", "branch refs/heads/main"],
    ],
    ["a bare label carrying a value", ["worktree /work/live", "bare false"]],
    [
      "a detached label carrying a value",
      [...main, "branch refs/heads/main", "detached no"],
    ],
    ["a branch line with no value", [...main, "branch"]],
    [
      "a branch name with a trailing space",
      [...main, "branch refs/heads/feature/refunds "],
    ],
    [
      "a branch name git forbids",
      [...main, "branch refs/heads/feature/../refunds"],
    ],
    [
      "a lock with an empty reason",
      [...main, "branch refs/heads/main", "locked "],
    ],
  ] as [string, string[]][])
    test(`a live record with ${label} is not porcelain output`, () => {
      expect(() => liveNames(`${record.join("\n")}\n`, naming)).toThrow(
        "not `git worktree list --porcelain` output",
      );
    });

  test("two branches that derive one name stop the run", () => {
    const listing = [
      "worktree /work/a",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/feature/refunds",
      "",
      "worktree /work/b",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/refunds",
      "",
    ].join("\n");
    expect(liveNames(listing, naming).size).toBe(1);
    const collide = [
      "worktree /work/a",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/a",
      "",
      "worktree /work/b",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/b",
      "",
    ].join("\n");
    expect(() =>
      liveNames(collide, naming, (identity) => `wt_${identity.length}`),
    ).toThrow("both derive wt_1");
  });

  test("a --now without a zone or naming no real time is refused", () => {
    for (const bad of [
      "2026-01-01T12:00:00",
      "2026-02-30T12:00:00Z",
      "yesterday",
    ])
      expect(() => parseTime(bad, "--now")).toThrow("ISO 8601");
    expect(parseTime("2026-01-01T12:00:00+02:00", "--now")).toBe(
      Date.parse("2026-01-01T10:00:00Z"),
    );
  });
});

test("an expiry exactly now is expired, and a live orphan is still orphaned", () => {
  const p = plan(
    [
      { name: "wt_a", owner: "o", expires_at: NOW },
      { name: "wt_b", owner: "o", expires_at: "2026-01-01T12:00:01Z" },
    ],
    {
      owner: "o",
      now: Date.parse(NOW),
      live: new Set(["wt_a"]),
      naming,
      production: "public",
    },
  );
  expect(p.reap.map((r) => `${r.name}:${r.reason}`)).toEqual([
    "wt_a:expired",
    "wt_b:orphaned",
  ]);
});

test("parseOptions and main run in-process", () => {
  expect(() => parseOptions([])).toThrow("--owner is required");
  const options = parseOptions([
    "--owner",
    "o",
    "--inventory",
    "i",
    "--live",
    "l",
    "--production",
    "public",
    "--now",
    NOW,
  ]);
  expect(options).toMatchObject({
    owner: "o",
    now: Date.parse(NOW),
    production: "public",
    naming,
  });
  expect(
    main([
      "--owner",
      "alice",
      "--inventory",
      fixture("all-live.json"),
      "--live",
      fixture("live.txt"),
      "--production",
      "public",
      "--now",
      NOW,
    ]),
  ).toBe(0);
});

test("classify names each bucket, production first", () => {
  const decision = {
    owner: "o",
    now: Date.parse(NOW),
    live: new Set(["wt_live"]),
    naming,
    production: "wt_prod",
  };
  const at = (name: string, rest: Record<string, string> = {}) =>
    classify({ name, ...rest }, decision).kind;
  expect(
    at("wt_prod", { owner: "o", expires_at: "2000-01-01T00:00:00Z" }),
  ).toBe("production");
  expect(at("public")).toBe("outside");
  expect(at("wt_x", { owner: "p" })).toBe("foreign");
  expect(classify({ name: "wt_x", expires_at: NOW }, decision)).toEqual({
    kind: "unlabelled",
    missing: ["owner"],
  });
  expect(at("wt_live", { owner: "o", expires_at: NOW })).toBe("reap");
  expect(
    at("wt_gone", { owner: "o", expires_at: "2027-01-01T00:00:00Z" }),
  ).toBe("reap");
  expect(
    at("wt_live", { owner: "o", expires_at: "2027-01-01T00:00:00Z" }),
  ).toBe("live");
});
