/**
 * `jig upgrade` and `jig doctor` end to end, each run as the installed plugin
 * copy runs, in a child with a scratch home and fake schedulers and agent
 * tools (`lifecycle-fixtures.ts`, `agent-fakes.ts`): the plugin moved to the
 * channel's newest release in both harnesses, a launcher change in that
 * release reaching the installed jobs, and the checks that pass on a healthy
 * machine and name the fix on a broken one.
 */
import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";
import { newRunId, writeReceipt } from "../dispatch/receipts.ts";
import { type Machine, machine, SCHEDULERS } from "./lifecycle-fixtures.ts";

const onWindows = skipsOnWindows(
  "powershell",
  "the platform schedulers the jobs are written for are launchd, systemd and cron",
);

/** A finished dispatcher tick's receipt, with its exit status. */
function dispatchReceipt(m: Machine, exitStatus: number): void {
  const now = new Date();
  writeReceipt(
    {
      version: 1,
      runId: newRunId(now),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      completed: true,
      apply: true,
      exitStatus,
      repos: [],
    },
    join(m.home, ".local", "state", "jig", "dispatch"),
  );
}

/**
 * A development shim for claude inside a checkout, ahead of the real one on
 * `PATH`: the `PATH` that puts it first.
 */
function shimFirst(m: Machine): string {
  const checkout = join(m.root, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "bin"));
  writeFakeProgram(
    join(checkout, "bin", "claude"),
    `#!/bin/sh\nexec '${join(m.root, "bin", "claude")}' "$@"\n`,
  );
  return `${join(checkout, "bin")}${delimiter}${m.env.PATH}`;
}

test.skipIf(onWindows)(
  "jig doctor names the failing check and the command that fixes it when claude on PATH resolves inside a git checkout",
  () => {
    const m = machine(SCHEDULERS[0]);
    const checkout = join(m.root, "checkout");
    const real = join(m.root, "bin");
    const result = m.jig(["doctor"], { PATH: shimFirst(m) });
    expectSpawnExit(result, 1);
    const out = result.stdout.toString();
    expect(out).toContain(
      `FAIL  path:claude: ${join(checkout, "bin", "claude")} is inside a git checkout`,
    );
    expect(out).toContain(
      `fix: PATH="${real}${delimiter}$PATH" jig install --yes`,
    );
    expect(out).toContain("Failing: path:claude.");
  },
);

test.skipIf(onWindows)(
  "jig doctor passes when both jobs are installed and last ran green",
  () => {
    const m = machine(SCHEDULERS[0]);
    m.writeDispatchFile();
    writeFakeProgram(join(m.root, "bin", "orca"), "#!/bin/sh\nexit 0\n");
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    expectSpawnExit(m.jig(["run", "gc"]), 0);
    dispatchReceipt(m, 0);

    const result = m.jig(["doctor", "--json"]);
    expectSpawnExit(result, 0);
    const report = JSON.parse(result.stdout.toString()) as {
      ok: boolean;
      checks: { id: string; status: string }[];
    };
    expect(report.ok).toBe(true);
    const status = Object.fromEntries(
      report.checks.map((check) => [check.id, check.status]),
    );
    expect(status).toMatchObject({
      bun: "pass",
      "path:claude": "pass",
      "path:codex": "pass",
      "plugin:claude": "pass",
      "plugin:codex": "pass",
      "command:launcher": "pass",
      "gc:machine-file": "pass",
      "gc:launcher": "pass",
      "gc:programs": "pass",
      "gc:last-run": "pass",
      "dispatch:machine-file": "pass",
      "dispatch:orca": "pass",
      "dispatch:launcher": "pass",
      "dispatch:programs": "pass",
      "dispatch:last-run": "pass",
      "config-fit": "pass",
    });

    // A failed tick is named, with where to read why.
    dispatchReceipt(m, 1);
    const failed = m.jig(["doctor", "dispatch"]);
    expectSpawnExit(failed, 1);
    expect(failed.stdout.toString()).toMatch(
      /FAIL {2}dispatch:last-run: \S+ exited 1\n {6}fix: jig receipts dispatch \S+/,
    );
  },
);

test.skipIf(onWindows)(
  "jig upgrade moves both harnesses to the channel's newest version, printing each command before it runs",
  () => {
    const m = machine(SCHEDULERS[0]);
    m.release("0.3.0", m.plugin);
    const result = m.jig(["upgrade", "--json"]);
    expectSpawnExit(result, 0);
    const report = JSON.parse(result.stdout.toString()) as {
      harnesses: Record<string, unknown>[];
      jobs: { outcome: string }[];
    };
    for (const harness of ["claude", "codex"])
      expect(report.harnesses).toContainEqual(
        expect.objectContaining({
          harness,
          outcome: "updated",
          before: "0.2.0",
          version: "0.3.0",
          follows: "the stable channel",
        }),
      );
    expect(report.jobs.map((job) => job.outcome)).not.toContain("failed");
    const calls = m.agentCalls();
    for (const call of [
      "claude plugin marketplace update jig",
      "claude plugin update jig@jig --scope user",
      "codex plugin marketplace upgrade jig",
      "codex plugin add jig@jig",
    ]) {
      expect(calls).toContain(call);
      expect(result.stderr.toString()).toContain(`$ ${call}\n`);
    }
    expect(m.agents().claude.version).toBe("0.3.0");
    expect(m.agents().codex.version).toBe("0.3.0");
  },
);

/** The next release, whose launcher differs from the installed one's; offered on the channel. */
function nextRelease(m: Machine): string {
  const next = join(m.root, "next-release");
  cpSync(m.plugin, next, { recursive: true });
  const launcher = join(next, "runtime", "launcher.ts");
  writeFileSync(
    launcher,
    `${readFileSync(launcher, "utf8")}// the next release\n`,
  );
  m.release("0.3.0", next);
  return launcher;
}

test.skipIf(onWindows)(
  "with a shim inside a checkout first on PATH, jig upgrade finds the new release through the agent tools the installed command and jobs record",
  () => {
    const m = machine(SCHEDULERS[0]);
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    const launcher = nextRelease(m);
    const result = m.jig(["upgrade"], { PATH: shimFirst(m) });
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain("jig-gc: refreshed");
    expect(
      readFileSync(
        join(m.home, ".local", "state", "jig", "gc", "launcher", "launcher.ts"),
        "utf8",
      ),
    ).toBe(readFileSync(launcher, "utf8"));
  },
);

/** How each scheduler's text spells the launcher option the next release adds. */
const ADDED = {
  systemd: ['"--no-env-file"', '"--no-env-file" "--smol"'],
  cron: ["'--no-env-file'", "'--no-env-file' '--smol'"],
  launchd: [
    "<string>--no-env-file</string>",
    "<string>--no-env-file</string><string>--smol</string>",
  ],
} as const;

test.skipIf(onWindows).each(SCHEDULERS)(
  "a launcher change in a new plugin version reaches the installed jobs through jig upgrade: each launcher copy is refreshed and each job rewritten, keeping what its install recorded (%s)",
  (variant) => {
    const m = machine(variant);
    m.writeDispatchFile();
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    const jobs = ["jig-gc", "jig-dispatch"];
    const before = Object.fromEntries(jobs.map((job) => [job, m.jobText(job)]));
    const command = join(m.home, ".local", "bin", "jig");
    const commandBefore = readFileSync(command, "utf8");

    // The next release: its launcher differs, and it runs it with one more option.
    const launcher = nextRelease(m);
    const scheduler = join(m.root, "next-release", "runtime", "scheduler.ts");
    const source = readFileSync(scheduler, "utf8");
    const changed = source.replace(
      '    "--no-env-file",\n    `--config=',
      '    "--no-env-file",\n    "--smol",\n    `--config=',
    );
    expect(changed).not.toBe(source);
    writeFileSync(scheduler, changed);

    const result = m.jig(["upgrade"]);
    expectSpawnExit(result, 0);
    const out = result.stdout.toString();
    const nextLauncher = readFileSync(launcher, "utf8");
    const state = join(m.home, ".local", "state", "jig");
    for (const directory of [
      join(state, "gc", "launcher"),
      join(state, "dispatch", "launcher"),
      join(state, "launcher"),
    ])
      expect(readFileSync(join(directory, "launcher.ts"), "utf8")).toBe(
        nextLauncher,
      );
    const [from, to] = ADDED[variant];
    for (const job of jobs) {
      expect(out).toContain(`${job}: refreshed`);
      // Only the new option changed: environment, programs and schedule stay.
      expect(m.jobText(job)).toBe((before[job] as string).replaceAll(from, to));
    }
    expect(readFileSync(command, "utf8")).toBe(
      commandBefore.replaceAll(ADDED.cron[0], ADDED.cron[1]),
    );
    if (variant === "systemd")
      for (const flag of ["enabled", "active"])
        for (const job of jobs)
          expect(
            readFileSync(join(m.state, `${flag}-${job}.timer`), "utf8"),
          ).toBe("");

    // Nothing differs any more, so nothing is written.
    const again = m.jig(["upgrade"]);
    expectSpawnExit(again, 0);
    for (const target of [...jobs, "jig command"])
      expect(again.stdout.toString()).toContain(`${target}: unchanged`);
  },
);

test.skipIf(onWindows)(
  "jig doctor fails the dispatcher's missing machine file while its timer is installed",
  () => {
    const m = machine(SCHEDULERS[0]);
    m.writeDispatchFile();
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    rmSync(join(m.home, ".jig", "dispatch.yaml"));
    const result = m.jig(["doctor", "dispatch"]);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toContain("FAIL  dispatch:machine-file");
  },
);

test.skipIf(onWindows)(
  "jig upgrade fails an installed job it cannot read instead of skipping it as absent",
  () => {
    const m = machine("cron");
    expectSpawnExit(m.jig(["install", "gc", "--yes"]), 0);
    const crontab = join(m.state, "crontab");
    writeFileSync(
      crontab,
      readFileSync(crontab, "utf8").replace("'env'", "'nv'"),
    );
    const result = m.jig(["upgrade"]);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toContain("jig-gc: failed");
  },
);

test.skipIf(onWindows)(
  "jig doctor fails a job whose timer is missing while its service remains, instead of skipping it as absent",
  () => {
    const m = machine("systemd");
    expectSpawnExit(m.jig(["install", "gc", "--yes"]), 0);
    rmSync(join(m.home, ".config", "systemd", "user", "jig-gc.timer"));
    const result = m.jig(["doctor", "gc"]);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toMatch(
      /FAIL {2}gc:launcher: the job is only partly installed/,
    );
  },
);

test.skipIf(onWindows)(
  "jig doctor fails the jig command when the Bun it records no longer exists",
  () => {
    const m = machine("systemd");
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    const command = join(m.home, ".local", "bin", "jig");
    const text = readFileSync(command, "utf8");
    const bun = /^exec '([^']*)'/m.exec(text)?.[1] as string;
    writeFileSync(command, text.replaceAll(bun, join(m.root, "gone", "bun")));
    const result = m.jig(["doctor"]);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toMatch(
      /FAIL {2}command:launcher: .*gone\/bun does not exist\n {6}fix: bun --no-env-file \S*--config=\S*bunfig\.toml\S* \S*jig\.ts\S* install --yes\n/,
    );
  },
);

test.skipIf(onWindows)(
  "jig doctor reports a configuration error the check found as the finding, not as an incomplete check",
  () => {
    const m = machine("systemd");
    writeFileSync(
      join(m.repo, ".config", "jig.yaml"),
      "autonomy:\n  level: nonsense\n",
    );
    const result = m.jig(["doctor"]);
    expectSpawnExit(result, 1);
    const out = result.stdout.toString();
    expect(out).toMatch(/FAIL {2}config-fit: \.config\/jig\.yaml: config\//);
    expect(out).not.toContain("did not complete");
  },
);

test.skipIf(onWindows)(
  "jig doctor fails the jig command whose script names no agent tool, with the confirmed repair",
  () => {
    const m = machine("systemd");
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    const command = join(m.home, ".local", "bin", "jig");
    const text = readFileSync(command, "utf8");
    writeFileSync(command, text.replace(/ '--(claude|codex)=[^']*'/g, ""));
    const result = m.jig(["doctor"]);
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toMatch(
      /FAIL {2}command:launcher: .*names no agent tool\n {6}fix: bun --no-env-file \S*--config=\S*bunfig\.toml\S* \S*jig\.ts\S* install --yes\n/,
    );
  },
);
