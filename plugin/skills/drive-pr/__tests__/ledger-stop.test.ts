import { poll } from "../../../shared/retry.ts";
import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  markDriverRecordReleased,
  recordPendingExit,
  removeDriverRecord,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import {
  recordPersonStop,
  personStopFor,
} from "../scripts/lib/state/person-stop.ts";
import { type DriveEvent, lastStop } from "../scripts/lib/state/events.ts";
import {
  type Ledger,
  parseLedger,
  renderClaim,
} from "../scripts/lib/state/ledger.ts";
import { cloneId } from "../scripts/lib/state/ledger-mirror.ts";
import {
  readLease,
  readTreeLease,
  treeLeaseRef,
  leaseRef,
} from "../scripts/lib/state/lease.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { SCRIPTS, forgeComment, ledgerBody } from "./ledger-forge-fixtures.ts";
import { labelForge } from "./state-labels-forge.ts";
import {
  driverRecordRow,
  lockRow,
  removeLock,
  putLease,
  putTreeLease,
  writeState,
} from "./state-rows.ts";
import {
  type Stage,
  deadPid,
  driverOf,
  drives,
  ledgerOf,
  plantLock,
  posixStop,
  stage,
} from "./ledger-stop-fixtures.ts";

describe("drives.ts --stop marks the stopped driver's ledger", () => {
  it.skipIf(posixStop)(
    "writes the stopped ledger and reason for the held PR even when diagnostics name another PR",
    async () => {
      const s = stage();
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid, "111");
      const r = await drives(s, ["--stop", "999", "--reason", "maintenance"]);
      owner.kill("SIGKILL");
      expectSpawnExit(r, 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
      expect(driverOf(s)?.personStop?.reason).toBe("maintenance");
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "keeps version 3 when it stops a drive whose ledger parks a question for a managed user",
    async () => {
      const parked: Ledger["parked"] = [
        {
          key: "PRRT_x",
          kind: "thread",
          reason: "Which schema does the store keep?",
          round: 1,
          person: "mona_acme",
        },
      ];
      const s = stage({}, [], parked);
      writeState(s.leaf, "999", { ...freshState(999), rounds: 2, parked });
      expect(ledgerOf(s)?.ledgerVersion).toBe(3);
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const r = await drives(s, ["--stop", "999", "--reason", "maintenance"]);
      owner.kill("SIGKILL");
      expectSpawnExit(r, 0);
      const stopped = ledgerOf(s);
      expect(stopped?.driver.personStop?.reason).toBe("maintenance");
      expect(stopped?.ledgerVersion).toBe(3);
      expect(stopped?.parked[0]?.person).toBe("mona_acme");
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "labels the pull request parked once a person's stop marks its ledger stopped",
    async () => {
      const s = stage();
      const forgeGh = Bun.which("gh", { PATH: s.forge.env.PATH ?? "" });
      if (forgeGh === null)
        throw new Error("the fake forge's gh is not on PATH");
      const labels = labelForge(s.forge.dir, forgeGh, ["jig:driving"], "");
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const r = await drives(s, ["--stop", "999", "--reason", "maintenance"], {
        PATH: `${labels.bin}${delimiter}${s.forge.env.PATH ?? ""}`,
      });
      owner.kill("SIGKILL");
      expectSpawnExit(r, 0);
      expect(driverOf(s)?.personStop?.reason).toBe("maintenance");
      expect(labels.labels()).toEqual(["jig:parked"]);
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "refuses to terminate an unpublished startup over a stopped predecessor",
    async () => {
      const s = stage({ state: "stopped" });
      const before = s.forge.comments()[0]?.body;
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        plantLock(s, owner.pid);
        const result = await drives(s, [
          "--stop",
          "999",
          "--reason",
          "maintenance",
        ]);
        expectSpawnExit(result, 1);
        expect(result.stdout).toContain("not published its running ownership");
        expect(result.stdout).toContain("hold label");
        expect(() => process.kill(owner.pid, 0)).not.toThrow();
        expect(s.forge.comments()[0]?.body).toBe(before);
        expect(driverRecordRow(s.leaf, "999")).toBeNull();
        const published = parseLedger(before ?? "");
        expect(published?.kind).toBe("ledger");
        if (published?.kind !== "ledger") return;
        published.ledger.driver.state = "running";
        writeFileSync(
          join(s.forge.dir, "comments.json"),
          JSON.stringify([forgeComment(40, ledgerBody(published.ledger))]),
        );
        const stopped = await drives(s, [
          "--stop",
          "999",
          "--reason",
          "maintenance",
        ]);
        expectSpawnExit(stopped, 0);
        expect(driverOf(s)?.personStop?.reason).toBe("maintenance");
      } finally {
        owner.kill("SIGKILL");
        await owner.exited;
      }
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "refuses a running ledger missing acquisition or publication capability",
    async () => {
      for (const field of ["started", "recoveryVersion"] as const) {
        const s = stage();
        const legacy = parseLedger(s.forge.comments()[0]?.body ?? "");
        expect(legacy?.kind).toBe("ledger");
        if (legacy?.kind !== "ledger") return;
        delete legacy.ledger.driver[field];
        writeFileSync(
          join(s.forge.dir, "comments.json"),
          JSON.stringify([forgeComment(40, ledgerBody(legacy.ledger))]),
        );
        const owner = Bun.spawn(
          [
            process.execPath,
            "-e",
            "setInterval(() => {}, 1000)",
            "drive.ts",
            "999",
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        try {
          plantLock(s, owner.pid);
          const result = await drives(s, ["--stop", "999"]);
          expectSpawnExit(result, 1);
          expect(result.stdout).toContain("exact acquisition");
          expect(() => process.kill(owner.pid, 0)).not.toThrow();
          expect(driverRecordRow(s.leaf, "999")).toBeNull();
        } finally {
          owner.kill("SIGKILL");
          await owner.exited;
        }
      }
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "does not signal when operator intent cannot be published",
    async () => {
      const s = stage();
      const before = s.forge.comments()[0]?.body;
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        plantLock(s, owner.pid);
        writeFileSync(join(s.forge.dir, "fail-patch"), "");
        const result = await drives(s, [
          "--stop",
          "999",
          "--reason",
          "maintenance",
        ]);
        expectSpawnExit(result, 1);
        expect(result.stdout).toContain("no signal sent");
        expect(() => process.kill(owner.pid, 0)).not.toThrow();
        expect(s.forge.comments()[0]?.body).toBe(before);
      } finally {
        owner.kill("SIGKILL");
        await owner.exited;
      }
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "serializes an older mirror before the verified operator marker",
    async () => {
      const s = stage();
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const pause = join(s.forge.dir, "pause-patch");
      let mirror: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
      try {
        plantLock(s, owner.pid);
        writeState(s.leaf, "999", freshState(999));
        writeFileSync(pause, "");
        mirror = Bun.spawn(
          scriptArgv(join(SCRIPTS, "drive-state.ts"), "handoff", "999"),
          {
            cwd: s.forge.repo,
            env: {
              ...s.forge.env,
              DRIVE_PR_STATE_DIR: s.leaf,
              DRIVE_PR_WORKTREE: s.forge.repo,
              DRIVE_PR_LEDGER_DRIVER: JSON.stringify({
                actor: s.actor,
                clone: cloneId(s.leaf),
                login: "drive-bot",
                started: s.started,
                floor: 0,
                claim: null,
              }),
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        await poll(() => existsSync(join(s.forge.dir, "patch-waiting")), {
          everyMs: 10,
          deadlineMs: Date.now() + 5000,
          until: (v) => v,
        });
        const blocked = Bun.spawn(
          scriptArgv(join(SCRIPTS, "drives.ts"), "--stop", "999"),
          {
            cwd: s.forge.repo,
            env: {
              ...s.forge.env,
              DRIVE_PR_STATE_DIR: s.leaf,
              DRIVE_PR_LOCK_TIMEOUT: "0",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(blocked.stdout).text(),
          new Response(blocked.stderr).text(),
          blocked.exited,
        ]);
        expectSpawnExit({ stdout, stderr, exitCode }, 1);
        expect(driverRecordRow(s.leaf, "999")).toBeNull();
        expect(() => process.kill(owner.pid, 0)).not.toThrow();
        rmSync(pause);
        const [mirrorOut, mirrorErr, mirrorExit] = await Promise.all([
          new Response(mirror.stdout).text(),
          new Response(mirror.stderr).text(),
          mirror.exited,
        ]);
        expectSpawnExit(
          { stdout: mirrorOut, stderr: mirrorErr, exitCode: mirrorExit },
          0,
        );
        expectSpawnExit(
          await drives(s, ["--stop", "999", "--reason", "serialized"]),
          0,
        );
        expect(driverOf(s)?.personStop?.reason).toBe("serialized");
      } finally {
        rmSync(pause, { force: true });
        owner.kill("SIGKILL");
        await owner.exited;
        if (mirror !== null) {
          mirror.kill();
          await mirror.exited;
        }
      }
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "leaves a ledger a successor now owns untouched, and says so",
    async () => {
      const s = stage({ actor: "wt-0123456789abcdef" });
      const before = s.forge.comments()[0]?.body;
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      const r = await drives(s, ["--stop", "999"]);
      owner.kill("SIGKILL");
      expectSpawnExit(r, 1);
      expect(r.stdout).toContain("it names another driver");
      expect(s.forge.comments()[0]?.body).toBe(before);
    },
    60_000,
  );

  it.skipIf(posixStop)(
    "keeps the witness when the forge refuses the write, and the next recovery consumes it",
    async () => {
      const s = stage();
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => {}, 1000)",
          "drive.ts",
          "999",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      plantLock(s, owner.pid);
      writeDriverRecord(s.leaf, "999", {
        worktree: s.forge.repo,
        started: s.started,
        pid: owner.pid,
        host: hostname(),
      });
      writeFileSync(join(s.forge.dir, "fail-list-after"), "5");
      const r = await drives(s, ["--stop", "999"]);
      owner.kill("SIGKILL");
      await owner.exited;
      expectSpawnExit(r, 0);
      expect(driverOf(s)?.state).toBe("running");
      expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
      rmSync(join(s.forge.dir, "fail-list-after"));
      expectSpawnExit(await drives(s, ["--doctor"]), 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
      expect(driverRecordRow(s.leaf, "999")).toBeNull();
    },
    60_000,
  );
});

async function plantReleasedRecord(s: Stage): Promise<void> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  writeDriverRecord(s.leaf, "999", {
    worktree: s.forge.repo,
    started: s.started,
    pid: child.pid,
    host: hostname(),
    released: true,
  });
}

describe("recovering a stopped ledger's pending state-label projection", () => {
  async function labelsFor(s: Stage) {
    const forgeGh = Bun.which("gh", { PATH: s.forge.env.PATH ?? "" });
    if (forgeGh === null) throw new Error("the fake forge's gh is not on PATH");
    const labels = labelForge(s.forge.dir, forgeGh, ["jig:converged"], "");
    const env = { PATH: `${labels.bin}${delimiter}${s.forge.env.PATH ?? ""}` };
    await plantReleasedRecord(s);
    recordPendingExit(s.leaf, "999", s.started, 8);
    return { labels, env };
  }

  async function expectRecoveryToRemainPending(
    s: Stage,
    prepare: (labels: ReturnType<typeof labelForge>) => void,
  ) {
    const { labels, env } = await labelsFor(s);
    prepare(labels);
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
    expect(labels.labels()).toEqual(["jig:converged"]);
    return { labels, env };
  }

  it("retries the recorded CI exit against the same acquired stopped ledger", async () => {
    const s = stage({ state: "stopped", exit: 0 });
    const { env } = await expectRecoveryToRemainPending(s, () =>
      writeFileSync(join(s.forge.dir, "fail-patch"), ""),
    );
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 0 });
    rmSync(join(s.forge.dir, "fail-patch"));
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(driverRecordRow(s.leaf, "999")).toBeNull();
  });

  it("keeps a pending ordinary stop for a refused state-label projection", async () => {
    const s = stage({ state: "stopped", exit: 0 });
    const { labels, env } = await expectRecoveryToRemainPending(
      s,
      (labelState) => writeFileSync(join(labelState.bin, "edit-refused"), ""),
    );
    rmSync(join(labels.bin, "edit-refused"));
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(labels.labels()).toEqual(["jig:parked"]);
  });

  it("keeps a pending ordinary stop when its state-label configuration is unreadable", async () => {
    const s = stage({ state: "stopped", exit: 0 });
    const { labels, env } = await expectRecoveryToRemainPending(
      s,
      (labelState) =>
        writeFileSync(join(labelState.bin, "jig.yaml"), ": invalid"),
    );
    writeFileSync(
      join(labels.bin, "jig.yaml"),
      "dispatch:\n  labels:\n    enabled: true\n",
    );
    expectSpawnExit(await drives(s, ["--doctor"], env), 0);
    expect(driverOf(s)).toMatchObject({ state: "stopped", exit: 8 });
    expect(labels.labels()).toEqual(["jig:parked"]);
  });

  for (const [name, marker] of [
    [
      "when the label ownership recheck is unreadable",
      "fail-ownership-recheck",
    ],
    ["when its label projection is unavailable", "malformed-label-read"],
  ] as const) {
    it(`keeps a pending ordinary stop ${name}`, async () => {
      const s = stage({ state: "stopped", exit: 0 });
      await expectRecoveryToRemainPending(s, (labels) =>
        writeFileSync(join(labels.bin, marker), ""),
      );
    });
  }
});

async function plantRecord(s: Stage, released: boolean): Promise<void> {
  writeDriverRecord(s.leaf, "999", {
    worktree: s.forge.repo,
    started: s.started,
    pid: await deadPid(),
    host: hostname(),
    ...(released ? { released: true as const } : {}),
  });
}

describe("a stop recorded during driver startup", () => {
  it("survives the same acquisition's initial record, and clears for a successor", () => {
    const s = stage();
    const driver = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    expect(recordPersonStop(s.leaf, "999", driver, "maintenance")).toBe(true);
    writeDriverRecord(s.leaf, "999", driver);
    expect(personStopFor(s.leaf, "999", s.started)).toMatchObject({
      personStop: { reason: "maintenance" },
    });
    const successor = {
      ...driver,
      started: new Date(Date.parse(s.started) + 1).toISOString(),
    };
    writeDriverRecord(s.leaf, "999", successor);
    expect(personStopFor(s.leaf, "999", successor.started)).toEqual({});
  });
});

describe("operator stop racing a natural ledger stop", () => {
  it("adds the reason to its own stopped acquisition and never to a successor", async () => {
    for (const successor of [false, true]) {
      const s = stage({
        state: "stopped",
        ...(successor ? { started: "2001-01-01T00:00:00.000Z" } : {}),
      });
      const before = s.forge.comments()[0]?.body;
      await plantRecord(s, true);
      expect(
        recordPersonStop(
          s.leaf,
          "999",
          {
            worktree: s.forge.repo,
            started: s.started,
            pid: 1,
            host: hostname(),
          },
          "maintenance",
        ),
      ).toBe(true);
      expectSpawnExit(await drives(s, ["--doctor"]), 0);
      if (successor) expect(s.forge.comments()[0]?.body).toBe(before);
      else expect(driverOf(s)?.personStop?.reason).toBe("maintenance");
    }
  });
});

describe("operator stop racing driver cleanup", () => {
  it("retains intent written after the stopped payload snapshot until guarded recovery publishes it", async () => {
    for (const successor of [false, true]) {
      const s = stage({
        state: "stopped",
        ...(successor ? { started: "2001-01-01T00:00:00.000Z" } : {}),
      });
      const before = s.forge.comments()[0]?.body;
      await plantRecord(s, true);
      expect(
        recordPersonStop(
          s.leaf,
          "999",
          {
            worktree: s.forge.repo,
            started: s.started,
            pid: 1,
            host: hostname(),
          },
          "cleanup race",
        ),
      ).toBe(true);
      removeDriverRecord(s.leaf, "999", s.started, true);
      expect(driverRecordRow(s.leaf, "999")).not.toBeNull();
      expectSpawnExit(await drives(s, ["--doctor"]), 0);
      if (successor) expect(s.forge.comments()[0]?.body).toBe(before);
      else expect(driverOf(s)?.personStop?.reason).toBe("cleanup race");
      expect(driverRecordRow(s.leaf, "999")).toBeNull();
    }
  });
});

describe("marking a driver record released", () => {
  it("marks only the record of the acquisition releasing its locks", () => {
    const s = stage();
    const record = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    writeDriverRecord(s.leaf, "999", record);
    markDriverRecordReleased(s.leaf, "999", "2000-01-01T00:00:00.000Z");
    expect(driverRecordRow(s.leaf, "999")).toMatchObject({
      ...record,
      released: 0,
    });
    markDriverRecordReleased(s.leaf, "999", s.started);
    expect(driverRecordRow(s.leaf, "999")).toMatchObject({
      ...record,
      released: 1,
    });
  });
});

describe("recovering the ledger of a driver that could not write it", () => {
  it("leaves it running when its driver kept its lock, its pass possibly alive", async () => {
    for (const args of [
      ["--doctor"],
      ["--doctor", "--json"],
      ["--stop", "999"],
    ]) {
      const s = stage();
      plantLock(s, await deadPid());
      await plantRecord(s, false);
      const r = await drives(s, args);
      expectSpawnExit(r, args[0] === "--stop" ? 1 : 0);
      expect(driverOf(s)?.state).toBe("running");
      expect(driverRecordRow(s.leaf, "999")).not.toBeNull();
    }
  });

  it("leaves it running when its driver released no lock it was seen to release", async () => {
    const s = stage();
    await plantRecord(s, false);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("did not release its locks");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("leaves it when another clone's claim took the drive over since", async () => {
    const claim = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 3,
      at: new Date().toISOString(),
    });
    const s = stage({}, [forgeComment(80, claim, "other-bot")]);
    await plantRecord(s, true);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("another clone's claim (comment 80)");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("leaves it when the driver's own claim lost its generation to an earlier rival", async () => {
    const at = new Date().toISOString();
    const s = stage({ position: 9001 });
    const own = renderClaim({
      actor: s.actor,
      clone: cloneId(s.leaf),
      generation: 4,
      at,
    });
    const rival = renderClaim({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 4,
      at,
    });
    writeFileSync(
      join(s.forge.dir, "comments.json"),
      JSON.stringify([
        forgeComment(40, s.forge.comments()[0]?.body ?? ""),
        forgeComment(600, rival, "other-bot"),
        forgeComment(9001, own, "drive-bot"),
      ]),
    );
    await plantRecord(s, true);
    const r = await drives(s, ["--doctor"]);
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("another clone's claim (comment 600)");
    expect(driverOf(s)?.state).toBe("running");
  });

  it("marks it stopped from the driver record when its driver released its locks", async () => {
    for (const args of [
      ["--stop", "999"],
      ["--doctor"],
      ["--doctor", "--json"],
    ]) {
      const s = stage();
      await plantRecord(s, true);
      const r = await drives(s, args);
      expectSpawnExit(r, args[0] === "--stop" ? 1 : 0);
      expect(driverOf(s)).toMatchObject({ actor: s.actor, state: "stopped" });
      expect(driverRecordRow(s.leaf, "999")).toBeNull();
    }
  });

  it("reserves released recovery retries and preserves an unpublished successor after a forge failure", async () => {
    const s = stage();
    await plantRecord(s, true);
    writeFileSync(join(s.forge.dir, "fail-patch"), "");
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("running");
    expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
    rmSync(join(s.forge.dir, "fail-patch"));
    plantLock({ ...s, started: "2026-11-07T15:00:00.000Z" }, process.pid);
    const successor = lockRow(s.leaf, "pr-drive-999");
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("running");
    expect(lockRow(s.leaf, "pr-drive-999")).toEqual(successor);
    expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
    removeLock(s.leaf, "pr-drive-999");
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("stopped");
    expect(lockRow(s.leaf, "pr-drive-999")).toBeNull();
  });

  it("retries after a recovery process dies while reserving the PR and publishing its witness", async () => {
    const s = stage();
    await plantRecord(s, false);
    const row = driverRecordRow(s.leaf, "999");
    if (row === null) throw new Error("missing fixture driver record");
    const ready = join(s.forge.dir, "recovery-reserved");
    const helper = join(s.forge.dir, "interrupted-recovery.ts");
    const record = {
      worktree: s.forge.repo,
      started: s.started,
      pid: row.pid,
      host: row.host,
    };
    writeFileSync(
      helper,
      `import {writeFileSync} from "node:fs";
      import {reserveDeadDriver} from ${JSON.stringify(join(SCRIPTS, "lib/driver-recovery.ts"))};
      await reserveDeadDriver(${JSON.stringify(s.leaf)},"999",${JSON.stringify(record)},async()=>{
        writeFileSync(${JSON.stringify(ready)},"ready");
        await new Promise(()=>setInterval(()=>{},1000));
      },true);`,
    );
    const child = Bun.spawn([process.execPath, helper], {
      cwd: s.forge.repo,
      env: s.forge.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await poll(() => existsSync(ready), {
        everyMs: 10,
        deadlineMs: Date.now() + 5000,
        until: Boolean,
      });
      expect(driverRecordRow(s.leaf, "999")?.released).toBe(1);
    } finally {
      child.kill("SIGKILL");
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expectSpawnExitNot({ exitCode, stdout, stderr }, 0);
    }
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("stopped");
    expect(lockRow(s.leaf, "pr-drive-999")).toBeNull();
  });

  it("recovery does not retain the calling session's PR or tree lease", async () => {
    const s = stage();
    await plantRecord(s, true);
    const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drives.ts"), "--doctor"), {
      cwd: s.forge.repo,
      env: {
        ...s.forge.env,
        DRIVE_PR_STATE_DIR: s.leaf,
        CLAUDE_PID: String(process.pid),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(driverOf(s)?.state).toBe("stopped");
    expect(readLease(leaseRef(s.leaf, "999", s.actor))).toBeNull();
    expect(readTreeLease(treeLeaseRef(s.leaf, s.actor))).toBeNull();
  });

  it("recovery preserves a live session's existing admission when the write is refused", async () => {
    const s = stage();
    await plantRecord(s, true);
    const ref = leaseRef(s.leaf, "999", s.actor);
    const tree = treeLeaseRef(s.leaf, s.actor);
    const lease = putLease(ref, { pid: process.pid });
    const treeLease = putTreeLease(tree, { pid: process.pid, pr: "999" });
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("running");
    expect(readLease(ref)).toEqual(lease);
    expect(readTreeLease(tree)).toEqual(treeLease);
  });

  it("records the recovered stop locally, so an earlier run's exit never speaks for it", async () => {
    const s = stage();
    expectSpawnExit(
      await driveState(
        s,
        ["record-event", "999"],
        '{"kind":"stop","cause":"0"}',
      ),
      0,
    );
    await plantRecord(s, true);
    expectSpawnExit(await drives(s, ["--doctor"]), 0);
    expect(driverOf(s)?.state).toBe("stopped");
    const got = await driveState(s, ["get", "999"]);
    expectSpawnExit(got, 0);
    const events = (JSON.parse(got.stdout).events ?? []) as DriveEvent[];
    expect(lastStop(events)).toBeNull();
    expect(events.at(-1)).toMatchObject({ kind: "stop", cause: "unknown" });
  });
});

async function driveState(s: Stage, args: string[], stdin = "") {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drive-state.ts"), ...args), {
    cwd: s.forge.repo,
    env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
    stdin: new TextEncoder().encode(stdin),
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

describe("a seed the state store refuses", () => {
  it("keeps exit 13 when another working tree holds the pull request", async () => {
    const s = stage({ clone: "clone-elsewhere", state: "stopped" });
    const foreign = "wt-0000000000000dea";
    putLease(leaseRef(s.leaf, "999", foreign), {
      worktree: "/some/other/tree",
      command: "hold",
    });
    const driver = JSON.stringify(join(SCRIPTS, "lib", "driver", "ledger.ts"));
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const d = await import(${driver});
try { await d.armLedger("999", { actor: ${JSON.stringify(s.actor)}, clone: "clone-b", login: "drive-bot", started: "" }, null, null, "x"); console.log("ARMED"); }
catch (e) { console.log("EXIT " + e.code); }`,
      ],
      {
        cwd: s.forge.repo,
        env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(stdout).toContain("EXIT 13");
  });
});

it("scoped doctor leaves an unrelated released driver record and ledger untouched", async () => {
  const s = stage();
  await plantRecord(s, true);
  const before = s.forge.comments()[0]?.body;
  expectSpawnExit(await drives(s, ["--doctor", "--json", "--pr", "998"]), 0);
  expect(driverRecordRow(s.leaf, "999")).not.toBeNull();
  expect(s.forge.comments()[0]?.body).toBe(before);
});

it("record cleanup retains its witness when saved state is malformed", () => {
  const s = stage();
  writeDriverRecord(s.leaf, "999", {
    worktree: s.forge.repo,
    started: s.started,
    pid: 1,
    host: "h",
    released: true,
  });
  writeState(s.leaf, "999", "{broken");
  expect(() => removeDriverRecord(s.leaf, "999", s.started)).not.toThrow();
  expect(driverRecordRow(s.leaf, "999")).not.toBeNull();
});
