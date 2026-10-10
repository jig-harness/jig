import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import {
  type ArtifactFamily,
  enumerateStateArtifacts,
} from "../scripts/lib/state/artifacts.ts";
import { MIGRATED_MARKER_FILENAME } from "../scripts/lib/state/legacy-state.ts";
import {
  assertScheduledReaperDisabled,
  crontabHasScheduledReaper,
  defaultStateRootDir,
  migrateStateDir,
  noCrontabDiagnostic,
  parseCliArgs,
  parseTimeoutMs,
  planRootMigration,
  runProbe,
} from "../scripts/migrate-state-dir.ts";

/**
 * Mirrors migrate-state-dir.ts's own `migrationJournalPath` (not exported).
 * `migrateStateDir` keys the journal on `realpathSync(sourceArg)`, not the
 * raw argument — resolve the same way here, or this diverges on any host
 * (macOS included: `/var` -> `/private/var`) where the scratch tmpdir sits
 * behind a symlink.
 */
function journalPath(source: string): string {
  const resolved = realpathSync(source);
  const digest = createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, 16);
  return join(dirname(resolved), `.drive-pr-migrate-journal.${digest}.json`);
}

/**
 * Mirrors migrate-state-dir.ts's own `destinationLockPath` + the resolution
 * `canonicalDestination` applies (not exported): a pre-existing destination
 * resolves via `realpathSync` on itself, a not-yet-existing one via
 * `realpathSync` on its parent joined with its own basename.
 */
function destinationLockPath(destination: string): string {
  const resolved = existsSync(destination)
    ? realpathSync(destination)
    : join(realpathSync(dirname(destination)), basename(destination));
  const digest = createHash("sha256")
    .update(resolved)
    .digest("hex")
    .slice(0, 16);
  return join(dirname(resolved), `.drive-pr-migrate-dest-lock.${digest}.json`);
}

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "drive-pr-migrate-test-"));
  roots.push(root);
  return root;
}

function directories(root: string, names: readonly string[]): void {
  for (const name of names) mkdirSync(join(root, name));
}

const schedulerDisabled = async (): Promise<void> => {};

describe("scheduled reaper detection", () => {
  it("finds the installer marker only on an active crontab entry", () => {
    const marker = "# example-reap-state";
    const command = `0 9 * * 1 '/repo/scripts/reap-state-cron.sh' ${marker}`;
    expect(crontabHasScheduledReaper(command, marker)).toBe(true);
    expect(crontabHasScheduledReaper(`# ${command}`, marker)).toBe(false);
    expect(crontabHasScheduledReaper("0 8 * * * /other/job", marker)).toBe(
      false,
    );
  });

  it("finds nothing when the repository names no reaper schedule", () => {
    expect(
      crontabHasScheduledReaper("0 9 * * 1 /repo/reap # marker", undefined),
    ).toBe(false);
  });
});

describe("noCrontabDiagnostic", () => {
  it('recognizes the documented empty-crontab diagnostic, with or without the progname prefix and the "using an empty one" suffix', () => {
    expect(noCrontabDiagnostic("no crontab for alice")).toBe(true);
    expect(noCrontabDiagnostic("No crontab for alice")).toBe(true);
    expect(
      noCrontabDiagnostic("crontab: no crontab for alice - using an empty one"),
    ).toBe(true);
    expect(noCrontabDiagnostic("  No crontab for alice  \n")).toBe(true);
  });

  it("rejects a same-line error appended after the username — the ambiguity a greedy payload used to swallow", () => {
    // chatgpt-codex-connector, a reference-implementation pull request: a `[^\r\n:]+`-style greedy payload
    // accepted the whole of this message as the benign empty-crontab case,
    // so migration proceeded even though scheduler state was never actually
    // verified. The fail-closed grammar mirrors
    // `tools/dev/install-reap-cron-linux.sh`'s `is_empty_crontab_message`.
    expect(
      noCrontabDiagnostic("No crontab for alice - permission denied"),
    ).toBe(false);
    expect(noCrontabDiagnostic("No crontab for alice: permission denied")).toBe(
      false,
    );
  });

  it("rejects an unrelated diagnostic that merely ends in the documented suffix", () => {
    expect(
      noCrontabDiagnostic(
        "cannot access no crontab database: permission denied",
      ),
    ).toBe(false);
  });

  it("rejects multi-line stderr even when the first line matches", () => {
    expect(noCrontabDiagnostic("No crontab for alice\nsome other error")).toBe(
      false,
    );
  });

  it("rejects empty stderr", () => {
    expect(noCrontabDiagnostic("")).toBe(false);
  });
});

describe("parseTimeoutMs", () => {
  it("returns undefined when no --timeout was given", () => {
    expect(parseTimeoutMs(undefined)).toBeUndefined();
  });

  it("converts an ordinary seconds value to rounded milliseconds", () => {
    expect(parseTimeoutMs("30")).toBe(30_000);
    expect(parseTimeoutMs("1.5")).toBe(1500);
  });

  it("refuses a value that rounds to zero or fewer milliseconds", () => {
    expect(parseTimeoutMs("0.0001")).toBeNull();
    expect(parseTimeoutMs("0")).toBeNull();
    expect(parseTimeoutMs("-5")).toBeNull();
  });

  it("refuses a value beyond setTimeout's own max delay (2^31 - 1 ms)", () => {
    expect(parseTimeoutMs("2147483.648")).toBeNull(); // 2147483648 ms
    expect(parseTimeoutMs("1e300")).toBeNull();
    expect(parseTimeoutMs("Infinity")).toBeNull();
  });

  it("accepts the exact boundary value", () => {
    expect(parseTimeoutMs("2147483.647")).toBe(2147483647);
  });

  it("refuses non-numeric input", () => {
    expect(parseTimeoutMs("not-a-number")).toBeNull();
  });

  it("refuses a numeric prefix followed by trailing garbage", () => {
    // `Number.parseFloat` accepts a numeric PREFIX and silently ignores the
    // rest — these must not slip through as valid timeouts.
    expect(parseTimeoutMs("30seconds")).toBeNull();
    expect(parseTimeoutMs("1x")).toBeNull();
    expect(parseTimeoutMs("1 2")).toBeNull();
    expect(parseTimeoutMs("30 ")).toBe(30_000); // surrounding whitespace is fine
    expect(parseTimeoutMs(" 30")).toBe(30_000);
  });
});

describe("parseCliArgs", () => {
  it("accepts the documented no-timeout invocation and keeps both positionals", () => {
    // The regression itself: a prior index-arithmetic filter derived
    // positionals via `index !== timeoutIndex + 1`, which is `index !== 0`
    // whenever `--timeout` is absent (`timeoutIndex` is `-1`) — silently
    // dropping the source argument on exactly this, the CLI's documented
    // everyday form (chatgpt-codex-connector, a reference-implementation pull request round 15).
    expect(parseCliArgs(["/abs/source", "/abs/destination"])).toEqual({
      roots: false,
      source: "/abs/source",
      destination: "/abs/destination",
      json: false,
      timeoutMs: undefined,
    });
  });

  it("accepts --json in any position alongside two positionals", () => {
    expect(parseCliArgs(["--json", "/abs/source", "/abs/destination"])).toEqual(
      {
        roots: false,
        source: "/abs/source",
        destination: "/abs/destination",
        json: true,
        timeoutMs: undefined,
      },
    );
    expect(parseCliArgs(["/abs/source", "/abs/destination", "--json"])).toEqual(
      {
        roots: false,
        source: "/abs/source",
        destination: "/abs/destination",
        json: true,
        timeoutMs: undefined,
      },
    );
  });

  it("accepts --timeout with a valid value and converts it to milliseconds", () => {
    expect(
      parseCliArgs(["/abs/source", "/abs/destination", "--timeout", "30"]),
    ).toEqual({
      roots: false,
      source: "/abs/source",
      destination: "/abs/destination",
      json: false,
      timeoutMs: 30_000,
    });
  });

  it("refuses a lone --timeout with no value following it", () => {
    expect(() =>
      parseCliArgs(["/abs/source", "/abs/destination", "--timeout"]),
    ).toThrow(ExitError);
  });

  it("refuses --timeout given an invalid value", () => {
    expect(() =>
      parseCliArgs([
        "/abs/source",
        "/abs/destination",
        "--timeout",
        "not-a-number",
      ]),
    ).toThrow(ExitError);
  });

  it("refuses an unknown flag", () => {
    expect(() =>
      parseCliArgs(["/abs/source", "/abs/destination", "--bogus"]),
    ).toThrow(ExitError);
  });

  it("refuses too few or too many positionals", () => {
    expect(() => parseCliArgs(["/abs/source"])).toThrow(ExitError);
    expect(() =>
      parseCliArgs(["/abs/source", "/abs/destination", "/abs/extra"]),
    ).toThrow(ExitError);
    expect(() => parseCliArgs([])).toThrow(ExitError);
  });
});

describe("--from: migrating a whole state root", () => {
  it("parses --from with the default state root as the destination", () => {
    expect(parseCliArgs(["--from", "/abs/old-root"])).toEqual({
      roots: true,
      source: "/abs/old-root",
      destination: defaultStateRootDir(),
      json: false,
      timeoutMs: undefined,
    });
    expect(defaultStateRootDir()).toEndWith(
      join(".local", "state", "groundwork", "drive-pr"),
    );
  });

  it("expands ~ and honours --to", () => {
    const parsed = parseCliArgs(["--from", "~/old", "--to", "/abs/new"]);
    expect(parsed.source).toBe(join(homedir(), "old"));
    expect(parsed.destination).toBe("/abs/new");
  });

  it("refuses --from mixed with positionals, or --to alone", () => {
    expect(() => parseCliArgs(["--from", "/a", "/b"])).toThrow(ExitError);
    expect(() => parseCliArgs(["--to", "/a"])).toThrow(ExitError);
    expect(() => parseCliArgs(["--from"])).toThrow(ExitError);
  });

  it("plans one move per clone directory holding drive-pr state", () => {
    const from = scratch();
    const to = scratch();
    mkdirSync(join(from, "clone-a"));
    writeFileSync(join(from, "clone-a", "drive-pr-1.json"), "{}");
    mkdirSync(join(from, "clone-b"));
    writeFileSync(join(from, "clone-b", "drive-pr-2.json"), "{}");
    mkdirSync(join(from, "empty"));
    writeFileSync(join(from, "notes.txt"), "not a clone");
    expect(planRootMigration(from, to)).toEqual([
      { source: join(from, "clone-a"), destination: join(to, "clone-a") },
      { source: join(from, "clone-b"), destination: join(to, "clone-b") },
    ]);
  });

  it("treats a single clone directory as one move into the same-named subdirectory", () => {
    const from = join(scratch(), "clone-a");
    const to = scratch();
    mkdirSync(from);
    writeFileSync(join(from, "drive-pr-1.json"), "{}");
    expect(planRootMigration(from, to)).toEqual([
      { source: from, destination: join(to, "clone-a") },
    ]);
  });
});

describe("assertScheduledReaperDisabled", () => {
  it("treats win32 as disabled — no repository-managed Windows scheduler exists", async () => {
    // Every other test bypasses this function entirely via the
    // `assertSchedulerDisabled` test seam, so its own win32 branch had no
    // coverage at all — the actual gap this test closes (docomply-review,
    // a reference-implementation pull request round 10).
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(assertScheduledReaperDisabled()).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
    }
  });
});

describe("runProbe", () => {
  it("behaves like a plain run() when no signal is given", async () => {
    const result = await runProbe(["echo", "hi"], undefined);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("rejects immediately when the signal is already aborted — never spawns", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const started = performance.now();
    await expect(runProbe(["sleep", "5"], controller.signal)).rejects.toThrow(
      "migration cancelled: already gone",
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("races a slow probe and stops it, rather than waiting out its own deadline", async () => {
    // The regression: the probe's own `timeoutSec: 10` used to run
    // regardless of the caller's signal — a `--timeout 0.1` migration could
    // still block ~10s on this alone (chatgpt-codex-connector, a reference-implementation pull request
    // round 16). A 5s child raced against a 150ms signal must reject in low
    // hundreds of ms, nowhere near either deadline.
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("deadline")), 150);
    const started = performance.now();
    await expect(runProbe(["sleep", "5"], controller.signal)).rejects.toThrow(
      "migration cancelled: deadline",
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("removes its abort listener once the probe settles normally, rather than leaking one per call", async () => {
    // docomply-review + chatgpt-codex-connector, a reference-implementation pull request round 16: the
    // `{ once: true }` listener below is only removed by FIRING — when
    // `result` wins the race instead of `aborted`, it stayed registered on
    // the caller's signal for the rest of that signal's lifetime.
    const controller = new AbortController();
    await runProbe(["echo", "hi"], controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("does not accumulate abort listeners across repeated probes sharing one long-lived signal", async () => {
    // `assertScheduledReaperDisabled` is called with the same
    // `AbortSignal.timeout(...)` for the whole migration, so a per-call leak
    // here compounds — this is the "repeated probes" half of the same
    // finding, not just a single-call check.
    const controller = new AbortController();
    for (let i = 0; i < 5; i++) {
      await runProbe(["echo", "hi"], controller.signal);
    }
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("does not leak SIGINT/SIGTERM/SIGHUP listeners once the probe settles", async () => {
    // chatgpt-codex-connector, a reference-implementation pull request round 16: `onSpawn` above excludes
    // this child from `lib/proc.ts`'s own process-wide signal forwarding
    // (taking a `RunHandle` is that library's signal the caller now owns
    // this child's cancellation) — so `runProbe` has to register and clean
    // up its own listeners for the same signal set, or a real SIGINT/SIGTERM
    // would leave the probe running as an orphan. This checks the listeners
    // are symmetric (registered, then removed) without actually raising a
    // signal against the test process itself.
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
    };
    const controller = new AbortController();
    await runProbe(["echo", "hi"], controller.signal);
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
  });
});

/**
 * Every `ArtifactFamily` member, keyed for compile-time exhaustiveness:
 * adding a member to the union without adding an entry here is a type
 * error (`Record<ArtifactFamily, true>` demands every key). That is what
 * lets the fixture below be cross-checked against the union's FULL
 * membership at runtime, not merely conformance-checked — a `satisfies {
 * family: ArtifactFamily }[]` cast alone validates each listed entry but
 * never requires an unused union member to appear at all, so a new family
 * added with no matching fixture entry would still compile and pass
 * (docomply-review, a reference-implementation pull request round 15).
 */
const ALL_ARTIFACT_FAMILIES: Record<ArtifactFamily, true> = {
  "arm-output": true,
  "driver-pr-lock": true,
  "driver-worktree-lock": true,
  "held-claim": true,
  "legacy-migration-marker": true,
  log: true,
  "orphan-marker": true,
  "pr-lease": true,
  "ready-claim": true,
  "reaper-delete-lock": true,
  "reaper-snapshot": true,
  "remote-mutation-lock": true,
  state: true,
  "tree-lease": true,
};

describe("canonical state artifact inventory", () => {
  it("classifies every producer family, including driver staging and reaper artifacts", () => {
    const root = scratch();
    const files = [
      "drive-arm-42.out",
      "drive-pr-42.held-claim.key.0123456789abcdef",
      "drive-pr-42.json",
      "drive-pr-42.log",
      "drive-pr-42.ready-claim",
      "drive-pr-remote-lock-42.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
      "drive-tree-lease-wt-0123456789abcdef.json",
      "pr-drive-lease-42-wt-0123456789abcdef.json",
      ".drive-pr-42.orphan-warned",
      ".reap-state-snapshot.json",
      ".reap-state-delete.lock.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb",
      MIGRATED_MARKER_FILENAME,
    ];
    const dirs = [
      "pr-drive-42.lock",
      "pr-drive-42.lock.123.example.test.staging",
      "pr-drive-worktree-0123456789abcdef.lock",
    ];
    for (const name of files) writeFileSync(join(root, name), name);
    directories(root, dirs);
    writeFileSync(join(root, "HEAD"), "unrelated");

    const inventory = enumerateStateArtifacts(root);
    // Exact {name, family} pairs, in the lexicographic order
    // `enumerateStateArtifacts` itself sorts `readdirSync` into — a `Set` of
    // families alone cannot catch two fixtures' tags swapping (e.g. `state`
    // <-> `log`), only that the same bag of labels was produced by SOME
    // pairing (docomply-review, a reference-implementation pull request round 14). Also includes the
    // `legacy-state.ts` migration marker, the one `ArtifactFamily` member the
    // prior fixture set never exercised at all.
    expect(
      inventory.artifacts.map((entry) => ({
        name: entry.name,
        family: entry.family,
      })),
    ).toEqual([
      { name: ".drive-pr-42.orphan-warned", family: "orphan-marker" },
      { name: MIGRATED_MARKER_FILENAME, family: "legacy-migration-marker" },
      {
        name: ".reap-state-delete.lock.stale.owner.bbbbbbbbbbbbbbbbbbbbbbbb",
        family: "reaper-delete-lock",
      },
      { name: ".reap-state-snapshot.json", family: "reaper-snapshot" },
      { name: "drive-arm-42.out", family: "arm-output" },
      {
        name: "drive-pr-42.held-claim.key.0123456789abcdef",
        family: "held-claim",
      },
      { name: "drive-pr-42.json", family: "state" },
      { name: "drive-pr-42.log", family: "log" },
      { name: "drive-pr-42.ready-claim", family: "ready-claim" },
      {
        name: "drive-pr-remote-lock-42.lock.stale.owner.aaaaaaaaaaaaaaaaaaaaaaaa",
        family: "remote-mutation-lock",
      },
      {
        name: "drive-tree-lease-wt-0123456789abcdef.json",
        family: "tree-lease",
      },
      { name: "pr-drive-42.lock", family: "driver-pr-lock" },
      {
        name: "pr-drive-42.lock.123.example.test.staging",
        family: "driver-pr-lock",
      },
      {
        name: "pr-drive-lease-42-wt-0123456789abcdef.json",
        family: "pr-lease",
      },
      {
        name: "pr-drive-worktree-0123456789abcdef.lock",
        family: "driver-worktree-lock",
      },
    ] satisfies { name: string; family: ArtifactFamily }[]);
    // The `satisfies` cast above only validates the entries this fixture
    // has; it never requires every `ArtifactFamily` member to be present.
    // Cross-check against the full union so a family added later with no
    // matching fixture entry fails here instead of compiling silently.
    expect(new Set(inventory.artifacts.map((entry) => entry.family))).toEqual(
      new Set(Object.keys(ALL_ARTIFACT_FAMILIES) as ArtifactFamily[]),
    );
    expect(inventory.unknown).toEqual([]);
    expect(inventory.unrelated.map((entry) => entry.name)).toEqual(["HEAD"]);
  });

  it("separates unknown drive-pr-shaped entries from unrelated Git entries", () => {
    const root = scratch();
    writeFileSync(join(root, "drive-pr-42.unknown"), "unknown");
    writeFileSync(join(root, "packed-refs"), "git");
    const inventory = enumerateStateArtifacts(root);
    expect(inventory.unknown.map((entry) => entry.name)).toEqual([
      "drive-pr-42.unknown",
    ]);
    expect(inventory.unrelated.map((entry) => entry.name)).toEqual([
      "packed-refs",
    ]);
  });
});

describe("migrateStateDir", () => {
  it("uses same-filesystem renames, moves only artifacts, and reports the exact population", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), '{"round":1}');
    writeFileSync(join(source, "drive-pr-42.log"), "log");
    writeFileSync(join(source, "HEAD"), "git");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
    });

    expect(report.mode).toBe("rename");
    expect(report.moved).toEqual([
      { name: "drive-pr-42.json", family: "state" },
      { name: "drive-pr-42.log", family: "log" },
    ]);
    expect(readdirSync(source)).toEqual(["HEAD"]);
    expect(readFileSync(join(destination, "drive-pr-42.json"), "utf8")).toBe(
      '{"round":1}',
    );
    expect(existsSync(source)).toBe(true);
  });

  it("uses copy-verify-remove across filesystems and preserves nested lock contents", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    const staleLock = join(source, "pr-drive-42.lock");
    mkdirSync(staleLock);
    writeFileSync(join(staleLock, "claim.dead"), "999999 local-host\n");
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
      isClaimLive: () => false,
    });

    expect(report.mode).toBe("copy-verify-remove");
    expect(enumerateStateArtifacts(source).artifacts).toEqual([]);
    expect(
      readFileSync(join(destination, "pr-drive-42.lock", "claim.dead"), "utf8"),
    ).toBe("999999 local-host\n");
    expect(readdirSync(destination).sort()).toEqual([
      "drive-pr-42.json",
      "pr-drive-42.lock",
    ]);
  });

  it("refuses up front, before touching the destination, when source is itself a mount point on the cross-filesystem path", async () => {
    // chatgpt-codex-connector, a reference-implementation pull request round 22: `quarantineSourceArtifacts`
    // stages its safety-net quarantine directory in `dirname(source)` and
    // requires it to share `source`'s own device. A mount-point `source`
    // fails that check, but only AFTER the destination has already been
    // durably published and the journal written — leaving both populations
    // plus a held destination lock for manual reconciliation. This refusal
    // must fire before any of that, symmetric to the destination-side mount-
    // point check just above it in the source.
    //
    // An actual mount is not reproducible in a test sandbox — modelled via
    // `mock.module`, mirroring this file's own "converts a same-filesystem
    // EXDEV..." test's established pattern for exactly this class of
    // device-identity hazard.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const realSource = realpathSync(source);
    const actualFs = await import("node:fs");
    const realStatSync = actualFs.statSync;
    const realFs = { ...actualFs };
    mock.module("node:fs", () => ({
      ...realFs,
      statSync: (path: string, opts?: unknown) => {
        const real = realStatSync(path, opts as never);
        if (path === realSource) {
          return { ...real, dev: real.dev + 1 };
        }
        return real;
      },
    }));

    try {
      await expect(
        migrateStateDir(source, destination, {
          assertSchedulerDisabled: schedulerDisabled,
          forceCrossFilesystem: true,
        }),
      ).rejects.toThrow("source must not be a mount point");
    } finally {
      mock.module("node:fs", () => realFs);
    }

    // Nothing was touched: no destination directory, no journal, no stage.
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(source, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
  });

  it("refuses up front, before touching the destination, when source and its parent share a device number but not a mount", async () => {
    // docomply-review, a reference-implementation pull request round 23: the device-number check above
    // catches a mount-point `source` whose device differs from its parent's,
    // but a Linux bind mount (or a btrfs/bcachefs subvolume) can share the
    // parent's device number while still refusing `rename(2)` across the
    // boundary with EXDEV. That check alone cannot see this case — a real,
    // throwaway rename across the identical boundary can, which is what the
    // probe below exercises. Modelled via `mock.module` (an actual bind
    // mount/subvolume boundary is not reproducible in a test sandbox),
    // mirroring this file's own "converts a same-filesystem EXDEV..." test's
    // established pattern for exactly this class of device-identity hazard.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    const exdevError = Object.assign(
      new Error("EXDEV: cross-device link not permitted"),
      { code: "EXDEV" },
    );
    mock.module("node:fs", () => ({
      ...realFs,
      renameSync: () => {
        throw exdevError;
      },
    }));

    try {
      await expect(
        migrateStateDir(source, destination, {
          assertSchedulerDisabled: schedulerDisabled,
          forceCrossFilesystem: true,
        }),
      ).rejects.toThrow(
        "do not support atomic rename between them despite matching device numbers",
      );
    } finally {
      mock.module("node:fs", () => realFs);
    }

    // Nothing was touched: no destination directory, no journal, no stage,
    // and no leftover probe artifacts in source or its parent.
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(source, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
    expect(
      readdirSync(source).some((name) =>
        name.startsWith(".drive-pr-mount-probe-"),
      ),
    ).toBe(false);
    expect(
      readdirSync(root).some((name) =>
        name.startsWith(".drive-pr-mount-probe-"),
      ),
    ).toBe(false);
  });

  it("fails closed before moving anything when a drive-pr-shaped entry is unknown", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.future-format"), "unknown");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow("unclassified drive-pr artifacts");
    expect(readFileSync(join(source, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
    expect(existsSync(destination)).toBe(false);
  });

  it("does not abort on the persisted clone-identity file, and leaves it behind rather than migrating it", async () => {
    // chatgpt-codex-connector, a reference-implementation pull request round 22: `clone-key.ts`'s
    // `drive-pr-clone-id` is minted inside `commonDir` by ANY drive-pr
    // script run, regardless of migration state — so it is present at the
    // top level of the legacy `--git-common-dir`, the documented `source`
    // for this exact relocation flow (using-drive-pr.md § Relocating the state dir).
    // It used to fall through to `looksDrivePrOwned`'s fallback and classify
    // as `unknown-drive-pr`, aborting the whole migration on a file this
    // tool was never meant to touch.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(
      join(source, "drive-pr-clone-id"),
      "9f8b2f73-d094-4a1b-89ab-0123456789ab\n",
    );

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
    });

    expect(report.mode).toBe("rename");
    // Left behind in the source — never copied into the destination, since
    // it must stay bound to `source`'s own directory identity.
    expect(existsSync(join(source, "drive-pr-clone-id"))).toBe(true);
    expect(existsSync(join(destination, "drive-pr-clone-id"))).toBe(false);
    expect(readdirSync(destination)).toEqual(["drive-pr-42.json"]);
  });

  it("fails closed before moving anything when a driver claim is live", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    const lock = join(source, "pr-drive-42.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "claim.live"), "123 local-host\n");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        isClaimLive: () => true,
      }),
    ).rejects.toThrow("live drive still owns pr-drive-42.lock");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("trusts a staging directory filename over a conflicting stale inner claim", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    const staging = join(source, "pr-drive-42.lock.123.publisher-host.staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "claim.stale"), "999 stale-host\n");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        isClaimLive: ({ pid }) => pid === 123,
      }),
    ).rejects.toThrow("live drive may still be creating");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a classified artifact that is a symlink", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(root, "outside-state"), "state");
    symlinkSync(join(root, "outside-state"), join(source, "drive-pr-42.json"));

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow("artifact must be a real file or directory");
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a directory artifact with a NESTED symlink on the same-filesystem path, matching the cross-filesystem rejection", async () => {
    // docomply-review, a reference-implementation pull request round 20 (chatgpt-codex-connector): the
    // symlink check above only ever looks at a classified artifact's own
    // top-level entry. `renameSync` (the same-filesystem publish just below)
    // moves a directory artifact's whole subtree in one syscall — it
    // repoints the directory entry, never opens or reads what's inside it —
    // so a symlink nested anywhere under `pr-drive-42.lock` used to pass
    // through completely unexamined here, even though the cross-filesystem
    // path's `manifestEntry` walk rejects the identical tree (see "preserves
    // nested lock contents" above, forced cross-filesystem, and its own
    // `unsupported filesystem entry` throw). Named `escape-hatch`, not
    // `claim.*`, so this exercises the NEW check rather than the pre-flight
    // claim-liveness scan a `claim.*`-prefixed name would trip first.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    const lock = join(source, "pr-drive-42.lock");
    mkdirSync(lock);
    const outsideTarget = join(root, "do-not-touch");
    writeFileSync(outsideTarget, "do-not-touch");
    symlinkSync(outsideTarget, join(lock, "escape-hatch"));
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        isClaimLive: () => false,
      }),
    ).rejects.toThrow("unsupported filesystem entry in drive-pr artifact");

    // Nothing was moved — the whole population, including the offending
    // symlink, stays exactly where it was, and the external target it
    // points at was never opened. `destination` itself can survive an
    // interrupted same-filesystem move (its own `mkdirSync` runs before the
    // per-artifact loop this check sits in — see "rolls back an interrupted
    // same-filesystem move" above), but empty either way.
    expect(existsSync(join(lock, "escape-hatch"))).toBe(true);
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(readFileSync(outsideTarget, "utf8")).toBe("do-not-touch");
    expect(existsSync(destination) ? readdirSync(destination) : []).toEqual([]);
  });

  it("publishes a verified cross-filesystem population as one directory rename", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        beforeCrossFilesystemPublish: () => {
          throw new Error("simulated interruption before atomic publish");
        },
      }),
    ).rejects.toThrow("simulated interruption before atomic publish");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(
      readdirSync(root).filter((name) => name.includes(".drive-pr-migrate-")),
    ).toEqual([]);
  });

  it("checks cancellation once more before the cross-filesystem journal write and publish", async () => {
    // Round-13 finding: the identity-verification loop right after the
    // verified copy was fully synchronous with no signal check anywhere
    // between it and the journal write / publish rename — a signal that
    // fired in that window went unobserved straight through both,
    // completing a "cancelled" migration anyway (chatgpt-codex-connector,
    // a reference-implementation pull request round 13). `beforeCrossFilesystemPublish` fires at exactly
    // that boundary, so aborting from inside it (without throwing) proves
    // the new check downstream of the hook is what catches this — the
    // pre-fix code had nothing left to catch it with.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    const controller = new AbortController();

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        signal: controller.signal,
        beforeCrossFilesystemPublish: () => {
          controller.abort(new Error("cancelled before journal"));
        },
      }),
    ).rejects.toThrow("migration cancelled");
    // Nothing published, nothing recorded, nothing left half-done.
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(journalPath(source))).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.includes(".drive-pr-migrate-")),
    ).toEqual([]);
    expect(readFileSync(join(source, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
  });

  it("rolls back an interrupted source quarantine after cross-filesystem publication", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        beforeSourceQuarantineMove: (_name, index) => {
          if (index === 1) throw new Error("simulated source removal failure");
        },
      }),
    ).rejects.toThrow("simulated source removal failure");
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(readdirSync(destination).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(
      readdirSync(root).filter((name) =>
        name.startsWith(".drive-pr-source-removal-"),
      ),
    ).toEqual([]);
    // The journal must SURVIVE this rollback: `destination` was already
    // durably published before quarantine started, so a fully-restored
    // `source` leaves two complete populations, not a reverted migration —
    // the journal is the only durable record of that split state
    // (docomply-review, a reference-implementation pull request round 5).
    expect(existsSync(journalPath(source))).toBe(true);
  });

  it("rolls back an interrupted same-filesystem move", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 1) throw new Error("simulated same-filesystem failure");
        },
      }),
    ).rejects.toThrow("simulated same-filesystem failure");
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("rejects migration while a reaper delete lock is recovering", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    mkdirSync(join(source, ".reap-state-delete.lock.recovering"));

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow("a reaper delete lock is present");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("allows migration when only a stale reaper delete lock remains", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    mkdirSync(
      join(
        source,
        ".reap-state-delete.lock.stale.owner.cccccccccccccccccccccccc",
      ),
    );

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
    });
    expect(report.mode).toBe("rename");
  });

  it("reports non-fatal warnings when quarantine cleanup fails after publication", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
      beforeQuarantineCleanup: () => {
        throw new Error("simulated cleanup failure");
      },
    });

    expect(report.mode).toBe("copy-verify-remove");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("simulated cleanup failure");
    expect(enumerateStateArtifacts(source).artifacts).toEqual([]);
    expect(readdirSync(destination).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
  });

  it("publishes cross-filesystem onto a pre-existing empty destination", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
    });

    expect(report.mode).toBe("copy-verify-remove");
    expect(readFileSync(join(destination, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
    expect(enumerateStateArtifacts(source).artifacts).toEqual([]);
  });

  it("rejects a pre-existing destination for a cross-filesystem migration on Windows", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        platform: "win32",
      }),
    ).rejects.toThrow(
      "destination must not already exist for a cross-filesystem migration on Windows",
    );
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("still allows a same-filesystem move onto a pre-existing destination on Windows", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    mkdirSync(destination);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      platform: "win32",
    });
    expect(report.mode).toBe("rename");
  });

  it("still allows a cross-filesystem migration onto a new (non-pre-existing) destination on Windows", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
      platform: "win32",
    });
    expect(report.mode).toBe("copy-verify-remove");
    expect(enumerateStateArtifacts(source).artifacts).toEqual([]);
  });

  it("detects destination substitution before a same-filesystem move", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    const redirect = join(root, "redirect");
    mkdirSync(source);
    mkdirSync(redirect);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemMove: () => {
          rmSync(destination, { recursive: true });
          symlinkSync(redirect, destination, "dir");
        },
      }),
    ).rejects.toThrow("directory identity changed during migration");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(readdirSync(redirect)).toEqual([]);
  });

  it("fails closed when scheduled-reaper state cannot be proven disabled", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: async () => {
          throw new Error("scheduler state unknown");
        },
      }),
    ).rejects.toThrow("scheduler state unknown");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("propagates a durability fsync failure as fatal rather than a warning", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        beforeSourceDurabilitySync: () => {
          throw new Error("simulated durability fsync failure");
        },
      }),
    ).rejects.toThrow("simulated durability fsync failure");
    // Destination is already published and correct — the failure is purely
    // about whether source's emptiness durably survives a crash.
    expect(readdirSync(destination).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    // The quarantine backup must NOT have been removed: with the durability
    // fsync itself unproven, deleting the only remaining copy of the
    // pre-fsync state would be the exact data-loss risk this split exists to
    // prevent.
    expect(
      readdirSync(root).filter((name) =>
        name.startsWith(".drive-pr-source-removal-"),
      ).length,
    ).toBe(1);
  });

  it("still reports non-fatal warnings when only cleanup (post-durability) fails", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    const report = await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
      beforeSourceDurabilitySync: () => {
        // No-op: durability sync itself succeeds.
      },
      beforeQuarantineCleanup: () => {
        throw new Error("simulated cleanup-only failure");
      },
    });

    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("simulated cleanup-only failure");
  });

  it("refuses to start when a previous migration left a stale journal", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(
      journalPath(source),
      JSON.stringify({
        op: "same-filesystem-move",
        source,
        destination,
        artifacts: ["drive-pr-42.json"],
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow("a previous migration attempt did not complete");
  });

  it("treats a syntactically-valid but malformed journal as unreadable, not a crash", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    // `{}` parses fine as JSON but has none of MigrationJournal's fields —
    // previously this reached `journal.artifacts.join(...)` in the refusal
    // message and threw an opaque TypeError instead of the intended
    // fail-closed diagnostic (docomply-review, a reference-implementation pull request round 11).
    writeFileSync(journalPath(source), JSON.stringify({}));

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow(
      "a previous migration attempt left an unreadable journal",
    );
  });

  it("removes the journal after a same-filesystem migration completes", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
    });

    expect(existsSync(journalPath(source))).toBe(false);
  });

  it("removes the journal after a cross-filesystem migration completes", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
      forceCrossFilesystem: true,
    });

    expect(existsSync(journalPath(source))).toBe(false);
  });

  it("removes the journal once a same-filesystem rollback fully succeeds", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 1) throw new Error("simulated same-filesystem failure");
        },
      }),
    ).rejects.toThrow("simulated same-filesystem failure");
    expect(existsSync(journalPath(source))).toBe(false);
  });

  it("leaves the journal in place when a same-filesystem rollback is itself incomplete", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 1) {
            // Destroy the already-relocated artifact from `destination` so
            // the rollback of index 0 has nothing to rename back from.
            rmSync(join(destination, "drive-pr-42.json"), { force: true });
            throw new Error("simulated same-filesystem failure");
          }
        },
      }),
    ).rejects.toThrow("rollback was incomplete");
    expect(existsSync(journalPath(source))).toBe(true);
  });

  it("survives a crash in the window between cross-filesystem publish and the quarantine call", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        afterCrossFilesystemPublish: () => {
          throw new Error("simulated crash between publish and quarantine");
        },
      }),
    ).rejects.toThrow("simulated crash between publish and quarantine");
    // Destination is durably published (the publish rename already
    // completed); the journal must still exist to describe that in-flight
    // state — findings 1/5's exact scenario (docomply-review +
    // chatgpt-codex-connector, a reference-implementation pull request round 4).
    expect(readFileSync(join(destination, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
    expect(existsSync(journalPath(source))).toBe(true);
  });

  it("leaves the journal in place across the whole cross-filesystem publish, not only during quarantine", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        beforeSourceQuarantineMove: (_name, index) => {
          if (index === 1) {
            // Destroy index 0's already-quarantined copy so ITS rollback
            // (rename from quarantine back to source) fails — the exact
            // "crash-adjacent" shape findings 1/5 described: destination is
            // durably published, source is partway drained, and the journal
            // is the only surviving record.
            const quarantineDir = readdirSync(root).find((name) =>
              name.startsWith(".drive-pr-source-removal-"),
            );
            if (quarantineDir === undefined) {
              throw new Error("test setup: quarantine dir not found");
            }
            rmSync(join(root, quarantineDir, "drive-pr-42.json"), {
              force: true,
            });
            throw new Error("simulated source removal failure");
          }
        },
      }),
    ).rejects.toThrow("rollback was incomplete");
    // Destination already carries the full, correctly published copy —
    // untouched by the failed quarantine phase.
    expect(readdirSync(destination).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(existsSync(journalPath(source))).toBe(true);
  });

  it("gives sibling sources under one parent distinct journal paths", async () => {
    const root = scratch();
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const destinationA = join(root, "destination-a");
    const destinationB = join(root, "destination-b");
    mkdirSync(sourceA);
    mkdirSync(sourceB);
    writeFileSync(join(sourceA, "drive-pr-42.json"), "state-a");
    writeFileSync(join(sourceB, "drive-pr-43.json"), "state-b");
    expect(journalPath(sourceA)).not.toBe(journalPath(sourceB));

    await Promise.all([
      migrateStateDir(sourceA, destinationA, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
      migrateStateDir(sourceB, destinationB, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ]);

    expect(readFileSync(join(destinationA, "drive-pr-42.json"), "utf8")).toBe(
      "state-a",
    );
    expect(readFileSync(join(destinationB, "drive-pr-43.json"), "utf8")).toBe(
      "state-b",
    );
  });

  it("refuses a concurrent migration that wins the write race against an in-flight one", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        // Fires AFTER assertNoStaleMigrationJournal's pre-check already
        // passed but BEFORE this migration's own exclusive journal write —
        // simulating a second process's write landing in that exact window.
        beforeSameFilesystemMove: () => {
          writeFileSync(
            journalPath(source),
            JSON.stringify({
              op: "same-filesystem-move",
              source,
              destination,
              artifacts: ["drive-pr-42.json"],
              startedAt: new Date().toISOString(),
            }),
          );
        },
      }),
    ).rejects.toThrow("a migration journal already exists");
    // Refused before moving any artifact: the racing writer's journal is
    // left untouched (not clobbered), and no artifact was relocated —
    // `destination` may exist (created before the race is hit) but is empty.
    expect(readFileSync(join(source, "drive-pr-42.json"), "utf8")).toBe(
      "state",
    );
    expect(readdirSync(destination)).toEqual([]);
  });

  it("refuses before doing anything when the signal is already aborted", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        signal: AbortSignal.abort(new Error("pre-aborted")),
      }),
    ).rejects.toThrow("migration cancelled");
    expect(existsSync(join(source, "drive-pr-42.json"))).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("cancels between artifacts once the signal aborts mid-loop", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");
    const controller = new AbortController();

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        signal: controller.signal,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 0) controller.abort(new Error("cancelled mid-loop"));
        },
      }),
    ).rejects.toThrow("migration cancelled");
    // Rolled back cleanly: the abort fires on the seam BEFORE the second
    // artifact's own renameSync, so only the first ever moved.
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("actually bounds a large synchronous migration via a real AbortSignal.timeout", async () => {
    // Regression coverage for the real-world failure shape: a
    // `controller.abort()` set synchronously (the test above) proves the
    // per-artifact CHECK works, but says nothing about whether a REAL timer
    // (`AbortSignal.timeout`) ever gets a chance to fire its callback while
    // a long synchronous artifact loop never yields to the event loop.
    // Without an actual macrotask yield in `checkSignal`, a 1ms timeout
    // measurably failed to bound a 2,000-artifact migration in practice
    // (chatgpt-codex-connector, a reference-implementation pull request round 9) — this reproduces that
    // shape at a smaller, CI-friendly scale.
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    const artifactCount = 300;
    for (let i = 1; i <= artifactCount; i++) {
      writeFileSync(join(source, `drive-pr-${i}.json`), `state-${i}`);
    }

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        signal: AbortSignal.timeout(1),
      }),
    ).rejects.toThrow("migration cancelled");
    // The `.rejects.toThrow` above is what proves the timeout actually took
    // effect (a working migration would resolve, not throw). This is just a
    // no-data-loss sanity check on top — the rollback loop never checks the
    // signal itself, so it always runs to completion once triggered. With
    // the pre-move cancellation points this round added, `destination` may
    // never have been created at all if cancellation landed that early.
    const destinationCount = existsSync(destination)
      ? readdirSync(destination).length
      : 0;
    expect(readdirSync(source).length + destinationCount).toBe(artifactCount);
  });

  it("bounds the pre-move inventory/identity/lock-claim preprocessing phase too", async () => {
    // The previous test only proves cancellation is eventually observed
    // SOMEWHERE — it doesn't rule out that everything before the move loop
    // (enumerateStateArtifacts, captureArtifactIdentities, both lockClaim
    // sweeps) runs as one uninterrupted synchronous block first. Asserting
    // `destination` was NEVER created proves cancellation landed before
    // `mkdirSync(destination)` — i.e. during that preprocessing phase itself
    // (docomply-review, a reference-implementation pull request round 9, matching the reviewer's own cited
    // 2,000-artifact repro size).
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    for (let i = 1; i <= 2000; i++) {
      writeFileSync(join(source, `drive-pr-${i}.json`), `state-${i}`);
    }

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        signal: AbortSignal.timeout(1),
      }),
    ).rejects.toThrow("migration cancelled");
    expect(existsSync(destination)).toBe(false);
  });

  it("converts a same-filesystem EXDEV into a clear bind-mount diagnosis", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    // A matching `st_dev` does not rule out a Linux bind mount over a
    // different underlying filesystem — modelled via `mock.module` (real
    // cross-device renames aren't reliably reproducible in a test sandbox),
    // mirroring `fsutil.test.ts`'s established pattern for this exact
    // hazard. `realFs` is snapshotted BEFORE `mock.module` swaps the
    // registry entry, so the `finally` restore resolves through the real
    // implementation rather than the still-mocked one.
    const actualFs = await import("node:fs");
    const realFs = { ...actualFs };
    const exdevError = Object.assign(
      new Error("EXDEV: cross-device link not permitted"),
      { code: "EXDEV" },
    );
    mock.module("node:fs", () => ({
      ...realFs,
      renameSync: () => {
        throw exdevError;
      },
    }));

    try {
      await expect(
        migrateStateDir(source, destination, {
          assertSchedulerDisabled: schedulerDisabled,
        }),
      ).rejects.toThrow("is likely a bind mount over a different filesystem");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("refuses to overwrite a destination entry a concurrent writer created after the emptiness check", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (name, index) => {
          if (index === 1) {
            // Simulate a concurrent writer racing the emptiness check: an
            // entry of this name now exists in `destination` right before
            // this artifact's own renameSync would otherwise silently
            // replace it.
            writeFileSync(join(destination, name), "concurrent writer");
          }
        },
      }),
    ).rejects.toThrow("refusing to overwrite it");
    // The concurrent writer's content must survive untouched.
    expect(readFileSync(join(destination, "drive-pr-42.log"), "utf8")).toBe(
      "concurrent writer",
    );
    // Rollback undoes the first artifact too.
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
  });

  it("syncs both directories before removing the journal after a same-filesystem rollback", async () => {
    // Mechanically verifies the ordering `fsyncDirectoryBestEffort(source);
    // fsyncDirectoryBestEffort(destination); removeMigrationJournal(source);`
    // via the dedicated `beforeRollbackJournalRemoval` test seam, which
    // fires strictly between the two fsyncs and the journal removal — the
    // journal file is still readable at that instant if and only if removal
    // has not yet run. `mock.module` can't observe this directly:
    // `fsyncDirectoryBestEffort` lives in fsutil.ts, a module `migrate-
    // state-dir.ts` imports separately from `node:fs`, and mocking either
    // module does not retroactively rebind the OTHER module's own
    // already-captured `node:fs` import binding (confirmed by hand —
    // mocking fsutil.ts's export directly recorded zero intercepted calls,
    // docomply-review, a reference-implementation pull request round 6).
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");
    // Captured on an object, not bare `let` bindings — TypeScript's
    // control-flow analysis narrows a closure-reassigned `let` initialized
    // to `null` down to the literal `null` type at the point of later use
    // under this project's stricter scoped tsconfig, which an object
    // property assignment does not trigger.
    const captured: {
      hookFired: boolean;
      syncedDirs: readonly string[] | null;
      journalExistedAtHook: boolean | null;
    } = { hookFired: false, syncedDirs: null, journalExistedAtHook: null };

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 1) throw new Error("simulated same-filesystem failure");
        },
        beforeRollbackJournalRemoval: (syncedDirs) => {
          captured.hookFired = true;
          captured.syncedDirs = syncedDirs;
          captured.journalExistedAtHook = existsSync(journalPath(source));
        },
      }),
    ).rejects.toThrow("simulated same-filesystem failure");

    expect(captured.hookFired).toBe(true);
    // `migrateStateDir` passes its own realpath-resolved `source`, not the
    // raw scratch-dir path — same symlink-resolution caveat as `journalPath`.
    expect(captured.syncedDirs).toEqual([
      realpathSync(source),
      join(realpathSync(root), "destination"),
    ]);
    // The journal must still exist at the moment BOTH fsyncs have run but
    // removal has not — proving removal happens strictly after.
    expect(captured.journalExistedAtHook).toBe(true);
    // And be gone by the time the whole call has finished.
    expect(existsSync(journalPath(source))).toBe(false);
    expect(readdirSync(source).sort()).toEqual([
      "drive-pr-42.json",
      "drive-pr-42.log",
    ]);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("removes the destination lock after a successful migration", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");

    await migrateStateDir(source, destination, {
      assertSchedulerDisabled: schedulerDisabled,
    });

    expect(existsSync(destinationLockPath(destination))).toBe(false);
  });

  it("refuses a migration targeting a destination another migration already locked", async () => {
    const root = scratch();
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const destination = join(root, "destination");
    mkdirSync(sourceA);
    mkdirSync(sourceB);
    writeFileSync(join(sourceA, "drive-pr-42.json"), "state-a");
    writeFileSync(join(sourceB, "drive-pr-43.json"), "state-b");
    mkdirSync(destination);
    writeFileSync(
      destinationLockPath(destination),
      JSON.stringify({
        source: sourceA,
        destination,
        startedAt: new Date().toISOString(),
      }),
    );

    await expect(
      migrateStateDir(sourceB, destination, {
        assertSchedulerDisabled: schedulerDisabled,
      }),
    ).rejects.toThrow("a lock for this destination already exists");
    // Refused before touching anything.
    expect(readFileSync(join(sourceB, "drive-pr-43.json"), "utf8")).toBe(
      "state-b",
    );
    // The refused invocation never acquired the lock — it must not delete
    // the winner's still-live lock just because `destination` (still empty,
    // since the winner hasn't moved anything yet) LOOKS safe to clean up.
    // A stale-looking lock is not the same as an unowned one (docomply-
    // review, PR #4626 round 8).
    expect(existsSync(destinationLockPath(destination))).toBe(true);
    expect(
      JSON.parse(readFileSync(destinationLockPath(destination), "utf8")).source,
    ).toBe(sourceA);
  });

  it("cleans up the lock it actually acquired, not one re-derived through a retargeted ancestor symlink", async () => {
    // `destination` itself can't be a symlink (canonicalDestination refuses
    // that outright) — the reported scenario is a symlinked ANCESTOR
    // directory. If that ancestor is retargeted between lock acquisition
    // and a later failure, re-deriving the lock path from the raw argument
    // in the cleanup catch would resolve `destinationArg` to a DIFFERENT
    // real directory than the one actually locked — and if that directory
    // happened to be empty, delete an unrelated migration's live lock
    // (chatgpt-codex-connector, a reference-implementation pull request round 12).
    const root = scratch();
    const source = join(root, "source");
    const realParentA = join(root, "real-parent-a");
    const realParentB = join(root, "real-parent-b");
    const linkParent = join(root, "link-parent");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    mkdirSync(realParentA);
    mkdirSync(join(realParentA, "destination"));
    mkdirSync(realParentB);
    mkdirSync(join(realParentB, "destination"));
    symlinkSync(realParentA, linkParent, "dir");
    const destinationArg = join(linkParent, "destination");
    // Simulate another, unrelated live migration already targeting
    // `realParentB/destination` — this must survive untouched.
    const otherLockPath = destinationLockPath(join(realParentB, "destination"));
    writeFileSync(
      otherLockPath,
      JSON.stringify({ source: "/unrelated", destination: "unrelated" }),
    );

    await expect(
      migrateStateDir(source, destinationArg, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemMove: () => {
          // Retarget AFTER this invocation's own lock (keyed on
          // realParentA/destination, the resolved path at acquisition
          // time) was already acquired.
          rmSync(linkParent, { force: true });
          symlinkSync(realParentB, linkParent, "dir");
          throw new Error("simulated failure after retargeting");
        },
      }),
    ).rejects.toThrow("simulated failure after retargeting");

    // The lock this invocation actually acquired (on realParentA's own
    // destination, empty and genuinely abandoned) is released.
    expect(
      existsSync(destinationLockPath(join(realParentA, "destination"))),
    ).toBe(false);
    // The unrelated migration's lock is untouched — proving cleanup did not
    // re-resolve through the retargeted symlink.
    expect(existsSync(otherLockPath)).toBe(true);
  });

  it("leaves the destination lock in place when a cross-filesystem rollback leaves the destination populated", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        forceCrossFilesystem: true,
        beforeSourceQuarantineMove: (_name, index) => {
          if (index === 1) throw new Error("simulated source removal failure");
        },
      }),
    ).rejects.toThrow("simulated source removal failure");
    // Destination is already durably published — the destination lock must
    // remain, matching the source journal's own retention in this exact
    // scenario (round 5).
    expect(readdirSync(destination).length).toBeGreaterThan(0);
    expect(existsSync(destinationLockPath(destination))).toBe(true);
  });

  it("releases the destination lock when a same-filesystem rollback leaves the destination empty", async () => {
    const root = scratch();
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(source);
    writeFileSync(join(source, "drive-pr-42.json"), "state");
    writeFileSync(join(source, "drive-pr-42.log"), "log");

    await expect(
      migrateStateDir(source, destination, {
        assertSchedulerDisabled: schedulerDisabled,
        beforeSameFilesystemArtifactMove: (_name, index) => {
          if (index === 1) throw new Error("simulated same-filesystem failure");
        },
      }),
    ).rejects.toThrow("simulated same-filesystem failure");
    expect(readdirSync(destination)).toEqual([]);
    expect(existsSync(destinationLockPath(destination))).toBe(false);
  });
});
