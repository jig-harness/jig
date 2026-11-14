/** Process-boundary recovery, credential publication and duplicate-reader exclusion. */
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { delimiter, dirname } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { readAccess, reportGeneration } from "../dashboard-reader.ts";
import { ownIdentity } from "../../shared/liveness.ts";

const reader = resolve(import.meta.dir, "../dashboard-reader.ts");
const runTest = skipsOnWindows(
  "process-lifecycle",
  "the installed reader requires Linux service managers and owner-only file modes",
)
  ? test.skip
  : test;

async function until<T>(
  probe: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeout = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (accept(value)) return value;
    if (Date.now() >= deadline)
      throw new Error("dashboard lifecycle probe exceeded its deadline");
    await Bun.sleep(20);
  }
}

runTest(
  "a reader excludes duplicates, recovers after a crash, and renews on copy change",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jig-reader-"));
    const enabled = join(root, "enabled");
    const copy = join(root, "copy");
    const script = join(root, "reader.ts");
    writeFileSync(enabled, "installation");
    writeFileSync(copy, "v1");
    writeFileSync(
      script,
      `
import { readFileSync } from "node:fs";
import { keepDashboard } from ${JSON.stringify(reader)};
const root = process.argv[2];
const version = readFileSync(root + "/copy", "utf8");
process.exitCode = await keepDashboard({root, dataRoot: root + "/data", listen: {host:"127.0.0.1",port:0}, requireToken:true,allowedHosts:[],pollMs:20,current:async()=>readFileSync(root + "/copy","utf8")===version});
`,
    );
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const spawn = () => {
      const child = Bun.spawn([process.execPath, script, root], {
        stdout: "pipe",
        stderr: "pipe",
      });

      children.push(child);
      return child;
    };
    const result = async (child: ReturnType<typeof spawn>) => ({
      exitCode: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    });
    const access = async () => {
      const value = readAccess(root);
      return value.ok ? value.value.url : null;
    };
    try {
      const first = spawn();
      const firstUrl = (await until(
        access,
        (value) => value !== null,
      )) as string;
      expect(statSync(join(root, "access.json")).mode & 0o777).toBe(0o600);
      const response = await fetch(firstUrl);
      expect(response.status).toBe(200);
      await response.body?.cancel();
      expect((await fetch(new URL("/", firstUrl))).status).toBe(403);
      expect((await fetch(firstUrl, { method: "POST" })).status).toBe(405);
      const duplicate = spawn();
      expectSpawnExit(await result(duplicate), 0);
      expect(await access()).toBe(firstUrl);
      first.kill("SIGKILL");
      const crashed = await result(first);
      expectSpawnExitNot(crashed, 0);
      expect(crashed.stdout).not.toContain("token=");
      expect(crashed.stderr).not.toContain("token=");
      const replacement = spawn();
      const secondUrl = (await until(
        access,
        (value) => value !== null && value !== firstUrl,
      )) as string;
      expect((await fetch(firstUrl).catch(() => null))?.status ?? 0).not.toBe(
        200,
      );
      expect((await fetch(secondUrl)).status).toBe(200);
      // The same transition the installed-copy watcher observes: old reader exits;
      // the next timer invocation runs the next copy, with a fresh access record.
      writeFileSync(copy, "v2");
      expectSpawnExit(await result(replacement), 0);
      const updated = spawn();
      const thirdUrl = (await until(
        access,
        (value) => value !== null,
      )) as string;
      expect(thirdUrl).not.toBe(secondUrl);
      // Removing the install marker stops the reader without trusting a stored PID.
      rmSync(enabled);
      const removed = await result(updated);
      expectSpawnExit(removed, 0);
      expect(removed.stdout).not.toContain("token=");
      expect(existsSync(join(root, "access.json"))).toBe(false);
      const uninstalled = spawn();
      expectSpawnExit(await result(uninstalled), 0);
      expect(existsSync(join(root, "access.json"))).toBe(false);
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

runTest(
  "access refuses stale, public, broad-permission and symlink records without echoing their credentials",
  () => {
    const root = mkdtempSync(join(tmpdir(), "jig-reader-record-"));
    try {
      const file = join(root, "access.json");
      writeFileSync(file, "secret token credential", { mode: 0o600 });
      expect(readAccess(root).ok).toBe(false);
      chmodSync(file, 0o644);
      const broad = readAccess(root);
      expect(broad.ok).toBe(false);
      expect(JSON.stringify(broad)).not.toContain("secret token credential");
      expect(readFileSync(file, "utf8")).toBe("secret token credential");
      chmodSync(file, 0o600);
      writeFileSync(
        file,
        JSON.stringify({
          url: "http://8.8.8.8/?token=secret",
          configuration: "fixture",
          identity: ownIdentity(),
        }),
      );
      expect(readAccess(root).ok).toBe(false);
      writeFileSync(
        file,
        JSON.stringify({
          url: "http://127.0.0.1/?token=secret",
          configuration: "fixture",
          identity: { ...ownIdentity(), pid: 2147483646 },
        }),
      );
      expect(readAccess(root).ok).toBe(false);
      const target = join(root, "target.json");
      writeFileSync(
        target,
        JSON.stringify({
          url: "http://127.0.0.1/?token=secret",
          configuration: "fixture",
          identity: ownIdentity(),
        }),
        { mode: 0o600 },
      );
      rmSync(file);
      symlinkSync(target, file);
      expect(readAccess(root).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

runTest(
  "the reader keeps serving after its launching parent process exits",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jig-reader-parent-"));
    const enabled = join(root, "enabled");
    const log = join(root, "reader.log");
    const worker = join(root, "worker.ts");
    writeFileSync(enabled, "installation");
    writeFileSync(
      worker,
      `import {keepDashboard} from ${JSON.stringify(reader)}; process.exitCode=await keepDashboard({root:${JSON.stringify(root)},dataRoot:${JSON.stringify(join(root, "data"))},listen:{host:"127.0.0.1",port:0},requireToken:true,allowedHosts:[],pollMs:20,current:async()=>true});`,
    );
    const launcher = join(root, "parent.ts");
    writeFileSync(
      launcher,
      `import {spawn} from "node:child_process"; import {openSync,closeSync} from "node:fs"; const fd=openSync(${JSON.stringify(log)},"a",0o600); const child=spawn(process.execPath,[${JSON.stringify(worker)}],{detached:true,stdio:["ignore",fd,fd]}); child.unref(); closeSync(fd);`,
    );
    const parent = Bun.spawn([process.execPath, launcher], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expectSpawnExit(
        {
          exitCode: await parent.exited,
          stdout: await new Response(parent.stdout).text(),
          stderr: await new Response(parent.stderr).text(),
        },
        0,
      );
      const access = await until(
        () => readAccess(root),
        (value) => value.ok,
      );
      expect(access.ok).toBe(true);
      if (access.ok) expect((await fetch(access.value.url)).status).toBe(200);
      rmSync(enabled);
      await until(
        () => readAccess(root).ok,
        (value) => !value,
      );
      expect(readFileSync(log, "utf8")).not.toContain("token=");
    } finally {
      rmSync(enabled, { force: true });
      await until(
        () => readAccess(root).ok,
        (value) => !value,
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

runTest(
  "scheduled reader renews after the harness switches copies and removes the old entry",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jig-reader-registry-"));
    const home = join(root, "home"),
      bin = join(root, "bin"),
      jigHome = join(root, "jig-home");
    const state = join(home, ".local/state/jig/dispatch/dashboard");
    const registry = join(root, "registry"),
      calls = join(root, "calls");
    const firstEntry = join(root, "v1/jig.ts"),
      secondEntry = join(root, "v2/jig.ts");
    for (const directory of [
      home,
      bin,
      jigHome,
      state,
      dirname(firstEntry),
      dirname(secondEntry),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(join(state, "enabled"), "installation");
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    reservation.stop(true);
    writeFileSync(
      join(jigHome, "dispatch.yaml"),
      `dashboard:\n  listen: 127.0.0.1:${port}\n`,
    );
    const module = resolve(import.meta.dir, "../dashboard-install.ts");
    const code = `import {scheduledDashboard} from ${JSON.stringify(module)}; process.exitCode=await scheduledDashboard(import.meta.path);`;
    writeFileSync(firstEntry, code);
    writeFileSync(secondEntry, code);
    writeFileSync(registry, dirname(firstEntry));
    writeFakeProgram(
      join(bin, "claude"),
      `#!/usr/bin/env bun\nimport{readFileSync,writeFileSync}from"node:fs"; const directory=readFileSync(${JSON.stringify(registry)},"utf8"); console.log(JSON.stringify([{id:"jig@jig",scope:"user",installPath:directory}]));writeFileSync(${JSON.stringify(calls)},directory);`,
    );
    const env = {
      ...process.env,
      HOME: home,
      JIG_HOME: jigHome,
      PATH: bin + delimiter + process.env.PATH,
    };
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const start = (entry: string) => {
      const child = Bun.spawn([process.execPath, entry], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    };
    const result = async (child: ReturnType<typeof start>) => ({
      exitCode: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    });
    try {
      const first = start(firstEntry);
      await until(() => existsSync(calls) || first.exitCode !== null, Boolean);
      if (first.exitCode !== null) expectSpawnExit(await result(first), 0);
      const initial = readAccess(state);
      expect(initial.ok).toBe(true);
      writeFileSync(registry, dirname(secondEntry));
      rmSync(dirname(firstEntry), { recursive: true });
      await until(
        () => first.exitCode,
        (value) => value !== null,
        75_000,
      );
      expectSpawnExit(await result(first), 0);
      const second = start(secondEntry);
      const renewed = await until(
        () => readAccess(state),
        (value) => value.ok,
      );
      expect(renewed.ok).toBe(true);
      if (initial.ok && renewed.ok)
        expect(renewed.value.url).not.toBe(initial.value.url);
      rmSync(join(jigHome, "dispatch.yaml"));
      await until(
        () => second.exitCode,
        (value) => value !== null,
      );
      const stopped = await result(second);
      expectSpawnExit(stopped, 0);
      expect(stopped.stdout + stopped.stderr).not.toContain("token=");
    } finally {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

test("an installation marker that cannot be read is a failure, not an absence", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-marker-"));
  try {
    const absent = reportGeneration(root);
    expect(absent.ok && absent.value).toBeNull();
    mkdirSync(join(root, "enabled"));
    const unreadable = reportGeneration(root);
    expect(unreadable.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

runTest(
  "a marker that becomes unreadable while serving stops the reader with a failure, not as an uninstall",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "jig-reader-marker-"));
    const enabled = join(root, "enabled");
    const worker = join(root, "worker.ts");
    const file = join(root, "marker-file");
    const folder = join(root, "marker-folder");
    const swap = join(root, "marker-swap");
    writeFileSync(file, "installation");
    mkdirSync(folder);
    symlinkSync(file, enabled);
    writeFileSync(
      worker,
      `import {keepDashboard} from ${JSON.stringify(reader)}; process.exitCode=await keepDashboard({root:${JSON.stringify(root)},dataRoot:${JSON.stringify(join(root, "data"))},listen:{host:"127.0.0.1",port:0},requireToken:true,allowedHosts:[],entry:"/the/entry/jig.ts",pollMs:20,current:async()=>true});`,
    );
    const child = Bun.spawn([process.execPath, worker], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const access = await until(
        () => readAccess(root),
        (value) => value.ok,
      );
      expect(access.ok && access.value.entry).toBe("/the/entry/jig.ts");
      // One atomic rename, so a poll never sees the marker absent in between.
      symlinkSync(folder, swap);
      renameSync(swap, enabled);
      expectSpawnExit(
        {
          exitCode: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        },
        1,
      );
      expect(readAccess(root).ok).toBe(false);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
