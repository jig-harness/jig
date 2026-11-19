/**
 * A systemd job read as systemd runs it: the unit `jobFiles` writes, read
 * back, with a host's drop-ins applied. A drop-in that replaces the command
 * with a credential wrapper gives the wrapper; one this reader cannot
 * reproduce is refused with its reason, never read as the base command.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readInstalledJob } from "../installed-job.ts";
import { type Job, jobFiles } from "../scheduler.ts";
import {
  type DropIn,
  effectiveJob,
  type Specifiers,
  unitWords,
} from "../systemd-dropins.ts";

const SPECIFIERS: Specifiers = {
  home: "/home/someone",
  user: "someone",
  uid: "1000",
  unit: "jig-dispatch.service",
  runtimeDir: "/run/user/1000",
};

const JOB: Job = {
  command: [
    "/usr/bin/bun",
    "--no-env-file",
    "--config=/state/launcher/bunfig.toml",
    "/state/launcher/launcher.ts",
    "--claude=/usr/bin/claude",
    "--",
    "dispatch",
    "--apply",
  ],
  env: {
    HOME: "/home/someone",
    PATH: "/usr/bin",
    JIG_LAUNCHER_DEADLINE_SEC: "600",
  },
  spec: {
    name: "jig-dispatch",
    label: "dev.jig.dispatch",
    description: "Jig dispatch",
    timerDescription: "Jig dispatch's timer",
    stateRoot: "/state",
    args: ["dispatch", "--apply"],
    schedule: { everyMinutes: 5 },
  },
};

/** The base job as the wake waiter reads it back from the installed unit. */
function installed(): { command: string[]; env: Record<string, string> } {
  const files = Object.fromEntries(
    Object.entries(jobFiles("systemd", JOB)).map(([name, text]) => [
      `/units/${name}`,
      text,
    ]),
  );
  const job = readInstalledJob({
    scheduler: "systemd",
    spec: JOB.spec,
    files,
    launcher: {},
    enabled: true,
    active: true,
  });
  if (job === null) throw new Error("the written unit did not read back");
  return job;
}

const dropIn = (
  text: string,
  path = "/units/jig-dispatch.service.d/a.conf",
): DropIn => ({
  path,
  text,
});

/** A host's credential drop-in: the base command replaced by a wrapper that runs the `jig` command. */
const CREDENTIAL = dropIn(`# Run the dispatcher with its credential.
[Service]
ExecStart=
ExecStart=%h/bin/with-op --set jig-dispatch -- /usr/bin/env -u TOKEN %h/.local/bin/jig dispatch --apply
`);

describe("effectiveJob", () => {
  test("is the base job when no drop-in applies", () => {
    const base = installed();
    expect(effectiveJob(base, [], SPECIFIERS)).toEqual({
      ok: true,
      value: { command: JOB.command, env: JOB.env, changed: false, unset: [] },
    });
  });

  test("runs the drop-in's command in place of the base unit's", () => {
    const result = effectiveJob(installed(), [CREDENTIAL], SPECIFIERS);
    expect(result).toEqual({
      ok: true,
      value: {
        command: [
          "/home/someone/bin/with-op",
          "--set",
          "jig-dispatch",
          "--",
          "/usr/bin/env",
          "-u",
          "TOKEN",
          "/home/someone/.local/bin/jig",
          "dispatch",
          "--apply",
        ],
        env: JOB.env,
        changed: true,
        unset: [],
      },
    });
  });

  test("applies drop-ins in their order, a later command and environment over an earlier", () => {
    const result = effectiveJob(
      installed(),
      [
        CREDENTIAL,
        dropIn(
          `[Service]\nExecStart=\nExecStart=-"/opt/my tools/wrap" '%u' 100%% \\\n  dispatch --apply\nEnvironment="A=one two" B=%t\nEnvironment=PATH=/opt/bin\n`,
          "/units/jig-dispatch.service.d/b.conf",
        ),
      ],
      SPECIFIERS,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        command: [
          "/opt/my tools/wrap",
          "someone",
          "100%",
          "dispatch",
          "--apply",
        ],
        env: {
          ...JOB.env,
          A: "one two",
          B: "/run/user/1000",
          PATH: "/opt/bin",
        },
        changed: true,
        unset: [],
      },
    });
  });

  test("skips a comment line inside a continued line, as systemd does", () => {
    const result = effectiveJob(
      installed(),
      [
        dropIn(
          "[Service]\nExecStart=\nExecStart=/wrap jig \\\n# run the dispatcher\n  dispatch --apply\n",
        ),
      ],
      SPECIFIERS,
    );
    expect(result.ok && result.value.command).toEqual([
      "/wrap",
      "jig",
      "dispatch",
      "--apply",
    ]);
  });

  test("an empty Environment= clears the base unit's variables", () => {
    const result = effectiveJob(
      installed(),
      [dropIn("[Service]\nEnvironment=\nEnvironment=ONLY=this\n")],
      SPECIFIERS,
    );
    expect(result.ok && result.value.env).toEqual({ ONLY: "this" });
  });

  test("leaves sections other than [Service] alone", () => {
    const result = effectiveJob(
      installed(),
      [dropIn("[Unit]\nExecStart=/not/a/service/key\nEnvironmentFile=/x\n")],
      SPECIFIERS,
    );
    expect(result.ok && result.value.command).toEqual(JOB.command);
  });

  test.each([
    [
      "an environment file",
      "[Service]\nEnvironmentFile=/etc/secret.env\n",
      "EnvironmentFile=",
    ],
    [
      "a credential",
      "[Service]\nLoadCredential=key:/etc/key\n",
      "LoadCredential=",
    ],
    [
      "a command run first",
      "[Service]\nExecStartPre=/bin/unlock\n",
      "ExecStartPre=",
    ],
    [
      "a second command",
      "[Service]\nExecStart=/bin/wrap dispatch --apply\n",
      "more than one command",
    ],
    ["no command", "[Service]\nExecStart=\n", "no command"],
    [
      "a variable",
      "[Service]\nExecStart=\nExecStart=/bin/wrap $TOKEN dispatch --apply\n",
      "variable",
    ],
    [
      "a braced variable",
      "[Service]\nExecStart=\nExecStart=/bin/wrap $" +
        "{TOKEN} dispatch --apply\n",
      "variable",
    ],
    [
      "an unknown specifier",
      "[Service]\nExecStart=\nExecStart=%Y/wrap dispatch --apply\n",
      "%Y",
    ],
    [
      "a privileged prefix",
      "[Service]\nExecStart=\nExecStart=+/bin/wrap dispatch --apply\n",
      "prefix +",
    ],
    [
      "an open quote",
      '[Service]\nExecStart=\nExecStart=/bin/wrap "dispatch --apply\n',
      "quote",
    ],
  ])("refuses a drop-in with %s, naming why", (_, text, reason) => {
    const result = effectiveJob(installed(), [dropIn(text)], SPECIFIERS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("unsupported");
      expect(result.failure.reason).toContain(reason);
    }
  });

  test("reads a doubled dollar as a dollar", () => {
    const result = effectiveJob(
      installed(),
      [
        dropIn(
          "[Service]\nExecStart=\nExecStart=/bin/wrap price$$ dispatch --apply\n",
        ),
      ],
      SPECIFIERS,
    );
    expect(result.ok && result.value.command).toEqual([
      "/bin/wrap",
      "price$",
      "dispatch",
      "--apply",
    ]);
  });
});

describe("unitWords", () => {
  test("splits on whitespace, joins quoted runs and reads escapes", () => {
    expect(unitWords(`a "b c"d 'e\\'f' g\\sh i\\\\j`, SPECIFIERS)).toEqual({
      ok: true,
      value: ["a", "b cd", "e'f", "g h", "i\\j"],
    });
  });

  test.each(["\\x41", "\\101", "\\u0041", "\\q"])(
    "refuses the escape %s rather than misread it",
    (sequence) => {
      const result = unitWords(`/opt/wrap${sequence}`, SPECIFIERS);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.reason).toContain("escape");
    },
  );

  test("keeps an empty quoted word", () => {
    expect(unitWords(`a "" b`, SPECIFIERS)).toEqual({
      ok: true,
      value: ["a", "", "b"],
    });
  });
});

describe("readDropIns", () => {
  /** `readDropIns` in a child whose `systemctl` is a script printing `answer` and exiting `exit`. */
  function read(answer: string, exit = 0): unknown {
    const dir = mkdtempSync(join(tmpdir(), "dropins-"));
    try {
      writeFileSync(join(dir, "a.conf"), "[Service]\nEnvironment=A=1\n");
      writeFileSync(join(dir, "b.conf"), "[Service]\nEnvironment=B=2\n");
      const systemctl = join(dir, "systemctl");
      writeFileSync(
        systemctl,
        `#!/bin/sh\nprintf '%s\\n' '${answer.replaceAll("DIR", dir)}'\nexit ${exit}\n`,
      );
      chmodSync(systemctl, 0o755);
      const module = resolve(import.meta.dir, "../systemd-dropins.ts");
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const { readDropIns } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(await readDropIns("jig-dispatch.service")));`,
        ],
        {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
          timeout: 10_000,
        },
      );
      expectSpawnExit(result, 0);
      const out = JSON.parse(result.stdout.toString()) as unknown;
      return JSON.parse(JSON.stringify(out).replaceAll(dir, "DIR")) as unknown;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.skipIf(process.platform === "win32")(
    "reads each drop-in systemd names, in its order",
    () => {
      expect(
        read("NeedDaemonReload=no\nDropInPaths=DIR/b.conf DIR/a.conf"),
      ).toEqual({
        ok: true,
        value: [
          { path: "DIR/b.conf", text: "[Service]\nEnvironment=B=2\n" },
          { path: "DIR/a.conf", text: "[Service]\nEnvironment=A=1\n" },
        ],
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "reads no drop-in when systemd names none",
    () => {
      expect(read("NeedDaemonReload=no\nDropInPaths=")).toEqual({
        ok: true,
        value: [],
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "is unreadable when systemd does not answer or names a file that is gone",
    () => {
      expect(read("", 1)).toMatchObject({
        ok: false,
        failure: { code: "unreadable" },
      });
      expect(
        read("NeedDaemonReload=yes\nDropInPaths=DIR/a.conf"),
      ).toMatchObject({
        ok: false,
        failure: { code: "unreadable" },
      });
      expect(
        read("NeedDaemonReload=no\nDropInPaths=DIR/gone.conf"),
      ).toMatchObject({
        ok: false,
        failure: { code: "unreadable" },
      });
    },
  );
});

describe("effectiveJob, what systemd would apply", () => {
  const dropIn = (text: string) => [{ path: "x.conf", text }];
  const refused = (text: string) =>
    effectiveJob(JOB, dropIn(`[Service]\n${text}\n`), SPECIFIERS);

  test("refuses a sandboxing directive it cannot reproduce", () => {
    expect(refused("NoNewPrivileges=yes")).toMatchObject({ ok: false });
    expect(refused("ProtectSystem=strict")).toMatchObject({ ok: false });
  });

  test("an empty assignment does not lift a refusal, since a scalar keeps its earlier value", () => {
    expect(refused("NoNewPrivileges=yes\nNoNewPrivileges=")).toMatchObject({
      ok: false,
    });
    expect(refused("EnvironmentFile=/a\nEnvironmentFile=")).toMatchObject({
      ok: false,
    });
    expect(refused("ExecStartPre=")).toMatchObject({ ok: true });
  });

  test("refuses UMask, spelled as systemd spells it", () => {
    expect(refused("UMask=0077")).toMatchObject({ ok: false });
  });

  test("refuses an invalid variable name and an unprintable value", () => {
    expect(refused("Environment=BAD-NAME=v")).toMatchObject({ ok: false });
    expect(refused('Environment="A=x\\ny"')).toMatchObject({ ok: false });
  });

  test("names the base variables a drop-in clears", () => {
    const result = effectiveJob(
      { command: JOB.command, env: { TRACKER_SCOPE: "a", KEEP: "b" } },
      dropIn("[Service]\nEnvironment=\nEnvironment=KEEP=b\n"),
      SPECIFIERS,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { unset: ["TRACKER_SCOPE"] },
    });
  });
});
