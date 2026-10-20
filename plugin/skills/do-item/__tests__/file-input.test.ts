import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

test("selectors consume files with spaces without shell evaluation", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-input-"));
  try {
    const input = join(dir, "comments é.json");
    writeFileSync(
      input,
      JSON.stringify([
        {
          body: "## Scout Findings (abc1234)\n`code` $(echo lost) $HOME",
          createdAt: "2000-01-01",
        },
      ]),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../scripts/select_scout_finding.ts"),
        "--input",
        input,
        "--current-hash",
        "abc1234",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
    );
    expect(JSON.parse(result.stdout).action).toBe("reuse");
    const selection = join(dir, "execution plan.json");
    writeFileSync(
      selection,
      JSON.stringify({
        description: "No plan",
        epic: "ENG-100",
        live: {},
        mergedConflictEdges: [],
      }),
    );
    const selected = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../scripts/select_execution_issue.ts"),
        "--input",
        selection,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expectSpawnExit(
      {
        exitCode: selected.status,
        stdout: selected.stdout,
        stderr: selected.stderr,
      },
      0,
    );
    expect(JSON.parse(selected.stdout).present).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracker body and JSON files are validated before reaching the tracker", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-tracker-file-"));
  try {
    const path = join(dir, "body é.json");
    for (const [argv, body, expected] of [
      [["create", "--input", path], "not JSON", "not JSON"],
      [
        ["update", "ENG-123", "--input", path],
        '{"unexpected": "literal"}',
        "unknown key",
      ],
      [
        ["comment", "ENG-123", "--body-file", path],
        "  ",
        "comment body is empty",
      ],
    ] as const) {
      writeFileSync(path, body);
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "../scripts/tracker.ts"), ...argv],
        { encoding: "utf8", timeout: 30_000 },
      );
      expectSpawnExit(
        {
          exitCode: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        2,
      );
      expect(result.stderr).toContain(expected);
    }
    writeFileSync(
      path,
      JSON.stringify({ found: false, parentLabels: [], children: [] }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "../scripts/reconcile_parent_status.ts"),
        "--input",
        path,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          JIG_OVERLAY: join(import.meta.dir, "fixtures/overlay.yaml"),
        },
      },
    );
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
    );
    expect(JSON.parse(result.stdout).verdict).toBe("listing_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
