/**
 * The lifecycle verbs end to end, each run as the installed plugin copy runs,
 * in a child with a scratch home and fake schedulers and agent tools
 * (`lifecycle-fixtures.ts`): what `jig install`, `jig uninstall`, `jig status`
 * and `jig run` write and report, and the `jig` command on `PATH`.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";
import { load } from "../shared/yaml.ts";
import { SCHEDULERS, machine } from "./lifecycle-fixtures.ts";

const onWindows = skipsOnWindows(
  "powershell",
  "the platform schedulers the jobs are written for are launchd, systemd and cron",
);

test.skipIf(onWindows).each(SCHEDULERS)(
  "without the dispatcher's machine file, install writes collection's job and this repository's entry, and says why the dispatcher is skipped (%s)",
  (variant) => {
    const m = machine(variant);
    const preview = m.jig(["install"]);
    expectSpawnExit(preview, 0);
    expect(m.hasJob("jig-gc")).toBe(false);
    expect(existsSync(join(m.home, ".local", "bin", "jig"))).toBe(false);

    const result = m.jig(["install", "--yes"]);
    expectSpawnExit(result, 0);
    const out = result.stdout.toString();
    expect(out).toContain("dispatch: skipped: no machine file");
    expect(out).toContain(join(m.home, ".jig", "dispatch.yaml"));
    expect(m.hasJob("jig-gc")).toBe(true);
    expect(m.hasJob("jig-dispatch")).toBe(false);
    expect(
      load(readFileSync(join(m.home, ".jig", "jig.yaml"), "utf8")),
    ).toMatchObject({
      gc: { repositories: [{ path: m.repo }] },
    });
    const command = join(m.home, ".local", "bin", "jig");
    expect(statSync(command).mode & 0o111).not.toBe(0);

    const status = m.jig(["status", "--json"]);
    expectSpawnExit(status, 0);
    expect(JSON.parse(status.stdout.toString())).toMatchObject([
      { component: "gc", installed: true, schedule: "daily at 04:00" },
      {
        component: "dispatch",
        installed: false,
        detail: expect.stringContaining("no machine file"),
      },
      { component: "hub", installed: false },
    ]);
  },
);

test.skipIf(onWindows).each(SCHEDULERS)(
  "with the machine file, install also writes the dispatcher's timer, and uninstall --machine removes both jobs and the jig command (%s)",
  (variant) => {
    const m = machine(variant);
    m.writeDispatchFile();
    const installed = m.jig(["install", "--yes"]);
    expectSpawnExit(installed, 0);
    // The hub is opted in by name, as its own OS user, never by a bare install.
    expect(installed.stdout.toString()).not.toContain("dispatch: skipped");
    expect(installed.stdout.toString()).toContain("hub: skipped");
    expect(m.hasJob("jig-gc")).toBe(true);
    expect(m.hasJob("jig-dispatch")).toBe(true);
    const status = m.jig(["status", "dispatch", "--json"]);
    expectSpawnExit(status, 0);
    expect(JSON.parse(status.stdout.toString())).toMatchObject([
      { component: "dispatch", installed: true, schedule: "every 5 minutes" },
    ]);

    // Without --machine the jobs stay: the dispatcher's serves every
    // repository its file lists, and collection's keeps machine policy.
    const kept = m.jig(["uninstall", "dispatch", "--yes"]);
    expectSpawnExit(kept, 0);
    expect(m.hasJob("jig-dispatch")).toBe(true);

    const removed = m.jig(["uninstall", "--machine", "--yes"]);
    expectSpawnExit(removed, 0);
    expect(m.hasJob("jig-gc")).toBe(false);
    expect(m.hasJob("jig-dispatch")).toBe(false);
    expect(existsSync(join(m.home, ".local", "bin", "jig"))).toBe(false);
    for (const component of ["gc", "dispatch"])
      expect(
        existsSync(
          join(m.home, ".local", "state", "jig", component, "launcher"),
        ),
      ).toBe(false);
    expect(existsSync(join(m.home, ".local", "state", "jig", "launcher"))).toBe(
      false,
    );
  },
);

/** Runs `jig <args>` as `m.jig` does, without blocking, so a child this process started is reaped while it runs. */
async function jigAsync(m: ReturnType<typeof machine>, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(m.plugin, "gc", "bunfig.toml")}`,
      join(m.plugin, "jig.ts"),
      ...args,
    ],
    { cwd: m.repo, env: m.env, stdout: "pipe", stderr: "pipe", timeout: 60000 },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test.skipIf(onWindows).each(SCHEDULERS)(
  "the hub's job is the machine's: uninstall leaves it without --machine, has nothing to remove where none is installed, and stops the running hub (%s)",
  async (variant) => {
    const m = machine(variant);
    const bare = m.jig(["uninstall", "--yes"]);
    expectSpawnExit(bare, 0);
    expect(bare.stdout.toString()).toContain("jig uninstall hub --machine");
    const none = m.jig(["uninstall", "hub", "--machine", "--yes"]);
    expectSpawnExit(none, 0);
    expect(none.stdout.toString()).toContain("nothing to remove");
    expect(none.stdout.toString()).not.toContain("Removed:");

    // A running hub: its install record, and a process holding its lock.
    const hub = join(m.home, ".jig", "hub");
    mkdirSync(hub, { recursive: true, mode: 0o700 });
    const record = join(hub, "install.json");
    writeFileSync(
      record,
      JSON.stringify({ runtime: null, settings: join(hub, "settings.yaml") }),
    );
    const holder = Bun.spawn(
      [
        "bun",
        join(
          import.meta.dir,
          "..",
          "hub",
          "process",
          "__tests__",
          "fixtures",
          "hold-serve-lock.ts",
        ),
      ],
      { env: m.env, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("held");
      reader.releaseLock();
      const removed = await jigAsync(m, [
        "uninstall",
        "hub",
        "--machine",
        "--yes",
      ]);
      expectSpawnExit(removed, 0);
      expect(removed.stdout).toContain(`Stopped the hub: `);
      expect(removed.stdout).toContain("Removed:");
      await expectSpawnExited(holder, 0, "the lock holder");
      expect(existsSync(record)).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }
  },
);

test.skipIf(onWindows)(
  "the jig command runs the plugin copy the agent tool names at each run, so a plugin update reaches it without a new install",
  () => {
    const m = machine(SCHEDULERS[0]);
    expectSpawnExit(m.jig(["install", "--yes"]), 0);
    const command = join(m.home, ".local", "bin", "jig");
    const run = (...args: string[]) =>
      Bun.spawnSync([command, ...args], {
        cwd: m.repo,
        env: m.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60000,
      });
    const help = run("--help");
    expectSpawnExit(help, 0);
    expect(help.stdout.toString()).toContain("Usage: jig install");

    // The update: the agent tool now names another copy of the plugin.
    const next = join(m.root, "next-release");
    mkdirSync(join(next, "gc"), { recursive: true });
    writeFileSync(join(next, "gc", "bunfig.toml"), "");
    writeFileSync(
      join(next, "jig.ts"),
      'console.log("next release: " + process.argv.slice(2).join(" "));\n',
    );
    m.movePlugin(next);
    const updated = run("status", "--json");
    expectSpawnExit(updated, 0);
    expect(updated.stdout.toString()).toBe("next release: status --json\n");
  },
);

test.skipIf(onWindows)(
  "run gc runs the command collection's timer runs, and writes its receipt",
  () => {
    const m = machine(SCHEDULERS[0]);
    const result = m.jig(["run", "gc"]);
    expectSpawnExit(result, 0);
    expect(result.stderr.toString()).toContain(
      "gc: running jig gc --scheduled",
    );
    const receipts = join(m.home, ".local", "state", "jig", "gc");
    expect(
      readdirSync(receipts).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)),
    ).toHaveLength(1);
  },
);

test.skipIf(onWindows)(
  "install refuses to replace a jig command it did not write",
  () => {
    const m = machine(SCHEDULERS[0]);
    const command = join(m.home, ".local", "bin", "jig");
    mkdirSync(join(m.home, ".local", "bin"), { recursive: true });
    writeFileSync(command, "#!/bin/sh\necho mine\n");
    const result = m.jig(["install", "--yes"]);
    expectSpawnExit(result, 1);
    expect(result.stderr.toString()).toContain("jig install did not write it");
    expect(readFileSync(command, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(m.hasJob("jig-gc")).toBe(false);
  },
);
