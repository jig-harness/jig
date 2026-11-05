/**
 * drive-pr suite: a live CI hold label the drive holds no record of is
 * adopted by `ci-hold.ts ensure` (through finish-round.ts) and by
 * `ci-hold.ts release`, never a reason to refuse. Shared fixtures live in
 * drive-pr-harness.ts and drive-pr-findings-finish-round-fixtures.ts.
 */

import { describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { readState, writeState } from "./state-rows.ts";
import { freshState, isUsableState } from "../scripts/lib/state/schema.ts";

const HEAD = "a".repeat(40);

import { readFileSync, writeFileSync } from "node:fs";

import { delimiter, join } from "node:path";

import {
  SCRIPTS,
  binDir,
  gitCleanEnv,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();

const labeled = (id: string, actor: string, createdAt: string) => ({
  node_id: id,
  event: "labeled",
  label: { name: "ci:hold" },
  actor: { login: actor },
  created_at: createdAt,
});

const unlabeled = (id: string, actor: string, createdAt: string) => ({
  ...labeled(id, actor, createdAt),
  event: "unlabeled",
});

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const ciHoldOf = (stateDir: string) => readState(stateDir, "999")?.ciHold;

const headOf = (cwd: string) =>
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, env: gitCleanEnv() })
    .stdout.toString()
    .trim();

describe("ci-hold.ts adopts a hold label it holds no record of", () => {
  const { finishRound, scratchWithOrigin, seed, stateEnv } =
    createFindingsFinishRoundFixtures();

  const seedHeld = (
    stateDir: string,
    fixtureDir: string,
    cwd: string,
    eventId: string,
  ) =>
    seed(stateDir, fixtureDir, cwd, [
      "set-ci-hold",
      "999",
      "--set",
      "held",
      "--event-id",
      eventId,
      "--head",
      headOf(cwd),
      "--actor-name",
      "drive-user",
      "--created-at",
      "2026-09-10T09:58:00Z",
      "--check-run-watermark",
      "10000",
    ]);

  it("pushes under a label someone else added, recording its event as the drive's own", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ fixtureDir }) => {
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            labeled("LE_1", "human-user", "2026-09-10T09:59:00Z"),
          ]),
        );
      },
    });
    expectSpawnExit(r, 0);
    expect(r.pushed).not.toBe("");
    expect(r.stderr).toContain("adopted 'ci:hold'");
    expect(ciHoldOf(r.stateDir)).toMatchObject({
      phase: "held",
      eventId: "LE_1",
      actor: "human-user",
    });
    // Adoption mutates no label: the timeline holds only the original add.
    expect(
      readJson<unknown[]>(join(r.fixtureDir, "timeline.json")),
    ).toHaveLength(1);
  });

  it("adopts a label re-added after the drive's own removal", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seedHeld(stateDir, fixtureDir, cwd, "LE_1");
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            labeled("LE_1", "drive-user", "2026-09-10T09:58:00Z"),
            unlabeled("LE_2", "human-user", "2026-09-10T09:59:00Z"),
            labeled("LE_3", "human-user", "2026-09-10T09:59:30Z"),
          ]),
        );
      },
    });
    expectSpawnExit(r, 0);
    expect(r.pushed).not.toBe("");
    expect(ciHoldOf(r.stateDir)).toMatchObject({
      phase: "held",
      eventId: "LE_3",
    });
  });

  it("adopts the live label when an interrupted release cannot be reconciled", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seedHeld(stateDir, fixtureDir, cwd, "LE_1");
        const state = readState(stateDir, "999");
        assert(state, "the fixture must have seeded the drive state");
        state.ciHold = {
          phase: "releasing",
          heldEventId: "LE_1",
          addedAtHead: headOf(cwd),
          heldActor: "drive-user",
          heldCreatedAt: "2026-09-10T09:58:00Z",
          head: headOf(cwd),
          actor: "drive-user",
          createdAt: "2026-09-10T09:59:00Z",
          checkRunWatermark: 10_000,
        };
        writeState(stateDir, "999", state);
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            labeled("LE_1", "drive-user", "2026-09-10T09:58:00Z"),
            unlabeled("LE_2", "drive-user", "2026-09-10T09:59:00Z"),
            labeled("LE_3", "human-user", "2026-09-10T09:59:30Z"),
          ]),
        );
      },
    });
    expectSpawnExit(r, 0);
    expect(r.pushed).not.toBe("");
    expect(ciHoldOf(r.stateDir)).toMatchObject({
      phase: "held",
      eventId: "LE_3",
    });
  });

  it("keeps an adopted label when the push fails, since this push did not add it", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ fixtureDir, cwd }) => {
        const viewPath = join(fixtureDir, "pr-view.json");
        const view = readJson<Record<string, unknown>>(viewPath);
        const parent = Bun.spawnSync(["git", "rev-parse", "HEAD~1"], {
          cwd,
          env: gitCleanEnv(),
        });
        expectSpawnExit(parent, 0);
        view.headRefOid = parent.stdout.toString().trim();
        writeFileSync(viewPath, JSON.stringify(view));
        writeFileSync(join(fixtureDir, "push-fails"), "");
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            labeled("LE_1", "human-user", "2026-09-10T09:59:00Z"),
          ]),
        );
      },
    });
    expectSpawnExit(r, 1);
    const retry = await finishRound({
      repo: r.repo,
      fixtureDir: r.fixtureDir,
      stateDir: r.stateDir,
    });
    expectSpawnExit(retry, 1);
    expect(retry.report.state).toBe("PUSH_FAILED");
    expect(retry.stderr).not.toContain("released the CI hold label");
    const recovery = await finishRound({
      repo: r.repo,
      fixtureDir: r.fixtureDir,
      stateDir: r.stateDir,
      seedState: async ({ stateDir }) => {
        const state = readState(stateDir, "999");
        assert(state, "the fixture must have seeded the drive state");
        const held = state.ciHold as Record<string, unknown>;
        state.ciHold = {
          phase: "releasing",
          adopted: held.adopted,
          heldEventId: held.eventId,
          addedAtHead: held.addedAtHead,
          heldActor: held.actor,
          heldCreatedAt: held.createdAt,
          head: held.addedAtHead,
          actor: "drive-user",
          createdAt: "2026-09-10T10:00:00Z",
          checkRunWatermark: 10_000,
        };
        writeState(stateDir, "999", state);
      },
    });
    expectSpawnExit(recovery, 1);
    expect(recovery.report.state).toBe("PUSH_FAILED");
    expect(recovery.stderr).not.toContain("released the CI hold label");
    expect(ciHoldOf(r.stateDir)).toMatchObject({ adopted: true });
    expect(r.report.state).toBe("PUSH_FAILED");
    expect(r.stderr).not.toContain("released the CI hold label");
    const view = readJson<{ labels: { name: string }[] }>(
      join(r.fixtureDir, "pr-view.json"),
    );
    expect(view.labels.map((label) => label.name)).toContain("ci:hold");
    expect(
      readJson<unknown[]>(join(r.fixtureDir, "timeline.json")),
    ).toHaveLength(1);
  });

  it("adopts a live label before any check runs have registered", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ fixtureDir }) => {
        writeFileSync(join(fixtureDir, "push-fails"), "");
        writeFileSync(
          join(fixtureDir, "check-runs.json"),
          JSON.stringify({ check_runs: [] }),
        );
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            labeled("LE_1", "human-user", "2026-09-10T09:59:00Z"),
          ]),
        );
      },
    });
    expectSpawnExit(r, 1);
    expect(r.report.state).toBe("PUSH_FAILED");
    expect(r.stderr).toContain("adopted 'ci:hold'");
    expect(ciHoldOf(r.stateDir)).toMatchObject({
      phase: "held",
      eventId: "LE_1",
    });
  });

  it("still waits while the timeline does not show the live label being added", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ fixtureDir }) => {
        writeFileSync(join(fixtureDir, "timeline.json"), "[]");
      },
    });
    expectSpawnExit(r, 4);
    expect(r.report.state).toBe("CI_HOLD_WAIT");
    expect(r.pushed).toBe("");
    expect(r.stderr).toContain("does not show it being added yet");
  });

  it("release adopts a label someone else added and removes it at convergence", async () => {
    const repo = scratchWithOrigin();
    const { dir, stateDir } = writeFixture(
      { threads: [], ciHeld: true, head: repo.head },
      repo.dir,
    );
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([labeled("LE_1", "human-user", "2026-09-10T09:59:00Z")]),
    );
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "ci-hold.ts"),
        "release",
        "999",
        "--expect-head",
        repo.head,
      ),
      {
        cwd: repo.dir,
        env: {
          ...stateEnv(stateDir, dir),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    expect(stdout.trim()).toBe("removed");
    const view = readJson<{ labels: { name: string }[] }>(
      join(dir, "pr-view.json"),
    );
    expect(view.labels.map((label) => label.name)).not.toContain("ci:hold");
    expect(ciHoldOf(stateDir)).toMatchObject({
      phase: "released",
      eventId: "LE_2",
      source: "drive",
    });
  });

  it("release waits, leaving the adopted label, while no check run is registered yet", async () => {
    const repo = scratchWithOrigin();
    const { dir, stateDir } = writeFixture(
      { threads: [], ciHeld: true, head: repo.head },
      repo.dir,
    );
    writeFileSync(
      join(dir, "timeline.json"),
      JSON.stringify([labeled("LE_1", "human-user", "2026-09-10T09:59:00Z")]),
    );
    writeFileSync(
      join(dir, "check-runs.json"),
      JSON.stringify({ check_runs: [] }),
    );
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "ci-hold.ts"),
        "release",
        "999",
        "--expect-head",
        repo.head,
      ),
      {
        cwd: repo.dir,
        env: {
          ...stateEnv(stateDir, dir),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ exitCode, stdout, stderr }, 4);
    expect(stderr).toContain("no check run is registered");
    const view = readJson<{ labels: { name: string }[] }>(
      join(dir, "pr-view.json"),
    );
    expect(view.labels.map((label) => label.name)).toContain("ci:hold");
    expect(ciHoldOf(stateDir)).toMatchObject({ phase: "held", adopted: true });
  });

  it("accepts a boolean adopted flag and refuses any other type", () => {
    const base = {
      phase: "held",
      eventId: "123",
      addedAtHead: HEAD,
      actor: "drive-user",
      createdAt: "2026-09-10T10:00:00Z",
      checkRunWatermark: 0,
    };
    const releasing = {
      phase: "releasing",
      heldEventId: "123",
      addedAtHead: HEAD,
      heldActor: "drive-user",
      heldCreatedAt: "2026-09-10T09:00:00Z",
      head: HEAD,
      actor: "drive-user",
      createdAt: "2026-09-10T10:00:00Z",
      checkRunWatermark: 42,
    };
    for (const hold of [base, releasing]) {
      for (const adopted of [true, false]) {
        const state = { ...freshState(999), ciHold: { ...hold, adopted } };
        expect(isUsableState(state, 999)).toBe(true);
      }
      for (const adopted of ["true", 1, null]) {
        const state = { ...freshState(999), ciHold: { ...hold, adopted } };
        expect(isUsableState(state, 999)).toBe(false);
      }
    }
  });
});
