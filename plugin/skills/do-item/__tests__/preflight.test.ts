/**
 * The preflight command: its setting, and how its exit code and standard
 * output become a proceed or a refusal.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightClaim,
  preflightCommandOf,
  runPreflight,
} from "../scripts/lib/preflight.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const ROOT = process.cwd();
const ISSUE = JSON.stringify({ found: true, identifier: "#5" });
const FIXTURE = join(import.meta.dir, "fixtures", "preflight-fixture.ts");
const RUNNER = join(import.meta.dir, "fixtures", "preflight-runner.ts");
/** A command that runs the fixture in `mode`, the same under `sh` and `cmd.exe`. */
const fixture = (mode: string) => `bun ${JSON.stringify(FIXTURE)} ${mode}`;

/** `runPreflight` in a subprocess whose environment is exactly `env` plus the inherited one. */
async function runIn(command: string, env: Record<string, string>) {
  const child = Bun.spawn(["bun", RUNNER, command], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expectSpawnExit({ exitCode, stdout, stderr }, 0, "preflight runner");
  return JSON.parse(stdout) as Awaited<ReturnType<typeof runPreflight>>;
}

describe("preflightCommandOf", () => {
  it("is null when the repository sets none", () => {
    expect(preflightCommandOf(null)).toBeNull();
    expect(preflightCommandOf({})).toBeNull();
    expect(preflightCommandOf({ do_item: {} })).toBeNull();
    expect(
      preflightCommandOf({ do_item: { preflight_command: null } }),
    ).toBeNull();
  });

  it("returns the command", () => {
    expect(
      preflightCommandOf({ do_item: { preflight_command: "check" } }),
    ).toBe("check");
  });

  it("refuses a value that is not a nonempty string", () => {
    for (const value of ["", "  ", 5, ["a"], {}])
      expect(() =>
        preflightCommandOf({ do_item: { preflight_command: value } }),
      ).toThrow("do_item.preflight_command");
  });
});

describe("runPreflight", () => {
  it("proceeds on exit 0", async () => {
    expect(await runPreflight(ROOT, fixture("ok"), ISSUE)).toEqual({
      outcome: "proceed",
    });
  });

  it("gives the command the issue on standard input", async () => {
    expect(await runPreflight(ROOT, fixture("check"), ISSUE)).toEqual({
      outcome: "proceed",
    });
    expect(
      await runPreflight(ROOT, fixture("check"), '{"identifier":"#6"}'),
    ).toMatchObject({ outcome: "refused", reason: "not seen" });
  });

  it("refuses on exit 3 with the first line of standard output", async () => {
    expect(await runPreflight(ROOT, fixture("refuse"), ISSUE)).toEqual({
      outcome: "refused",
      kind: "refused",
      reason: "other repo",
    });
  });

  it("refuses on exit 3 without output, saying it gave no reason", async () => {
    const answer = await runPreflight(ROOT, fixture("refuse-silent"), ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "refused" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "giving no reason",
    );
  });

  it("keeps a long reason to one bounded line", async () => {
    const answer = await runPreflight(ROOT, fixture("refuse-long"), ISSUE);
    expect(answer).toEqual({
      outcome: "refused",
      kind: "refused",
      reason: `${"a".repeat(300)}…`,
    });
  });

  it("turns control characters in a reason into spaces", async () => {
    const answer = await runPreflight(ROOT, fixture("refuse-control"), ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", reason: "a b c" });
  });

  it("refuses on any other exit, with the tail of its error output", async () => {
    const answer = await runPreflight(ROOT, fixture("fail"), ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "failed (exit 2: broke)",
    );
  });

  it("refuses a command that is still running at the deadline", async () => {
    const answer = await runIn(fixture("hang"), {
      JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC: "1",
    });
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
    expect(answer.outcome === "refused" && answer.reason).toContain(
      "still running after 1s",
    );
  });

  it("refuses a command that cannot start", async () => {
    const answer = await runPreflight("/nonexistent-dir-743", "exit 0", ISSUE);
    expect(answer).toMatchObject({ outcome: "refused", kind: "failed" });
  });
});

describe("preflightClaim", () => {
  it("refuses, without running the command, when the item cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    const marker = join(dir, "ran");
    let refusal: Awaited<ReturnType<typeof preflightClaim>>;
    try {
      refusal = await preflightClaim(
        ROOT,
        fixture(`touch ${JSON.stringify(marker)}`),
        "#5",
        async () => ({ found: false, error: "tracker unreachable" }),
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(refusal).toMatchObject({ outcome: "refused", why: "preflight" });
    expect(refusal?.outcome === "refused" && refusal.reason).toContain(
      "tracker unreachable",
    );
  });

  it("lets a found item through when the command proceeds", async () => {
    expect(
      await preflightClaim(ROOT, fixture("ok"), "#5", async () =>
        JSON.parse(ISSUE),
      ),
    ).toBeNull();
  });
});
