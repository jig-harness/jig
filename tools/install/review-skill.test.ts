import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { install } from "./install.ts";
import { verify } from "./integrity.ts";
import { release } from "./release.ts";

const source = resolve(import.meta.dirname, "../..");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
  ),
);
let scratch: string;
let payload: string;
let manifest: string;
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "review-release-"));
  payload = join(scratch, "release");
  manifest = await release(source, payload, "pilot-test");
  expect(
    verify(payload).files.some((file) => file.path.includes("/__tests__/")),
  ).toBe(false);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const copies of [false, true])
  test(`bundled review commands use consumer policy and sibling paths (${copies ? "copies" : "links"})`, async () => {
    const consumer = join(scratch, copies ? "copies" : "links");
    mkdirSync(consumer);
    const git = spawnSync("git", ["init", "-q", consumer], { env });
    expectSpawnExit({ ...git, exitCode: git.status }, 0);
    const overlay = JSON.parse(
      readFileSync(
        join(
          source,
          "skills/resolve-review-comments/__tests__/fixtures/overlay.json",
        ),
        "utf8",
      ),
    );
    overlay.review.job_pattern = "custom-review-job";
    const options = {
      consumer,
      overlay,
      copies,
      local: payload,
      cache: join(scratch, "cache"),
      pin: {
        repository: "https://example.test/groundwork.git",
        revision: "a".repeat(40),
        manifest,
        version: "pilot-test",
      },
    };
    await install(options);
    await install({ ...options, check: true });
    const configDir = join(consumer, ".config");
    mkdirSync(configDir);
    cpSync(
      join(
        source,
        "skills/resolve-review-comments/__tests__/fixtures/review-triage.yaml",
      ),
      join(configDir, "review-triage.yaml"),
    );
    // A consumer sibling provides its CLI; the release cache deliberately lacks it.
    const driver = join(consumer, ".claude/skills/drive-pr/scripts");
    mkdirSync(driver, { recursive: true });
    writeFileSync(join(driver, "drive-state.ts"), "console.log('7');\n");
    writeFileSync(
      join(driver, "assert-post-allowed.ts"),
      "console.error('consumer fence'); process.exitCode = 11;\n",
    );
    const childEnv = { ...env };
    delete childEnv.GROUNDWORK_OVERLAY;
    delete childEnv.GROUNDWORK_REVIEW_TRIAGE_CONFIG;
    for (const surface of [".claude", ".agents"]) {
      const scripts = join(
        consumer,
        surface,
        "skills/resolve-review-comments/scripts",
      );
      const round = spawnSync(
        process.execPath,
        [join(scripts, "current-round.ts"), "42"],
        { cwd: consumer, env: childEnv, encoding: "utf8" },
      );
      expectSpawnExit({ ...round, exitCode: round.status }, 0);
      expect(round.stdout.trim()).toBe("7");
      const invalidAwait = spawnSync(
        process.execPath,
        [join(scripts, "await-round.ts"), "--invalid-flag"],
        { cwd: consumer, env: childEnv, encoding: "utf8", input: "" },
      );
      expectSpawnExit({ ...invalidAwait, exitCode: invalidAwait.status }, 2);
      expect(invalidAwait.stderr).toContain("unknown flag: --invalid-flag");
      expect(invalidAwait.stderr).not.toContain("reply-to-thread.ts:");
      const post = spawnSync(
        process.execPath,
        [join(scripts, "reply-to-thread.ts"), "PRRT_test"],
        {
          cwd: consumer,
          env: { ...childEnv, DRIVE_PR_TARGET: "42" },
          encoding: "utf8",
          input: "**accepted** Added the guard.\n",
        },
      );
      expectSpawnExit({ ...post, exitCode: post.status }, 11);
      expect(post.stderr).toContain("consumer fence");
      const probe = join(consumer, "probe.ts");
      writeFileSync(
        probe,
        `import { defaultConfigPath, loadLadder } from ${JSON.stringify(join(scripts, "lib/ladder.ts"))}; const loaded = await loadLadder(defaultConfigPath()); console.log(JSON.stringify({path: defaultConfigPath(),valid: loaded.config !== null}));\n`,
      );
      const ladder = spawnSync(process.execPath, [probe], {
        cwd: consumer,
        env: childEnv,
        encoding: "utf8",
      });
      expectSpawnExit({ ...ladder, exitCode: ladder.status }, 0);
      expect(JSON.parse(ladder.stdout)).toEqual({
        path: join(realpathSync(configDir), "review-triage.yaml"),
        valid: true,
      });
    }
    writeFileSync(join(consumer, ".groundwork/overlay.json"), "{}\n");
    await expect(install({ ...options, check: true })).rejects.toThrow(
      "runtime overlay changed",
    );
    await expect(install(options)).rejects.toThrow(
      "unmanaged or changed runtime overlay",
    );
  });

test.skipIf(process.platform === "win32")(
  "public bundles share one cancellation handler and preserve default termination",
  async () => {
    const { spawn } = await import("node:child_process");
    const probe = join(scratch, "cancel-probe.ts");
    const publicLib = join(
      payload,
      "skills/resolve-review-comments/scripts/lib",
    );
    writeFileSync(
      probe,
      `
const before = process.listenerCount("SIGTERM");
await import(${JSON.stringify(join(publicLib, "proc.ts"))});
await import(${JSON.stringify(join(publicLib, "gh-conditional.ts"))});
console.log(process.listenerCount("SIGTERM") - before);
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [probe], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ended = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const count = await new Promise<string>((resolve, reject) => {
        child.stdout.once("data", (data) => resolve(String(data).trim()));
        child.once("error", reject);
        timer = setTimeout(
          () => reject(new Error("probe did not start")),
          5000,
        );
      });
      clearTimeout(timer);
      expect(count).toBe("1");
      child.kill("SIGTERM");
      const result = await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("cancellation suppressed default termination")),
            2000,
          );
        }),
      ]);
      expect(result.signal).toBe("SIGTERM");
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      await ended;
    }
  },
);

test("public cancellation registrations release only their own ownership", () => {
  const probe = join(scratch, "ownership-probe.ts");
  writeFileSync(
    probe,
    `
import { registerCancellationGroup } from ${JSON.stringify(join(payload, "skills/resolve-review-comments/scripts/lib/proc.ts"))};
const signals: number[] = [];
process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
process.on("SIGTERM", () => {});
const first = registerCancellationGroup(777);
const second = registerCancellationGroup(777);
first();
process.emit("SIGTERM");
if (signals.join(",") !== "-777,-777") throw Error("one release removed another owner");
second();
signals.length = 0;
process.emit("SIGTERM");
if (signals.length) throw Error("released ownership remained");
const third = registerCancellationGroup(777);
first(); second();
process.emit("SIGTERM");
if (signals.join(",") !== "-777,-777") throw Error("stale release removed new ownership");
third();
console.log("owned");
`,
  );
  const child = spawnSync(process.execPath, [probe], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  expectSpawnExit({ ...child, exitCode: child.status }, 0);
  expect(child.stdout.trim()).toBe("owned");
});
