/**
 * A systemd job read as systemd runs it: the unit `jobFiles` writes, read
 * back, with a host's drop-ins applied. A drop-in that replaces the command
 * with a credential wrapper gives the wrapper; one this reader cannot
 * reproduce is refused with its reason, never read as the base command.
 */
import { describe, expect, test } from "bun:test";
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
      value: { command: JOB.command, env: JOB.env, changed: false },
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
      },
    });
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
      "[Service]\nExecStart=\nExecStart=/bin/wrap ${TOKEN} dispatch --apply\n",
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
    expect(unitWords(`a "b c"d 'e\\'f' g\\ h`, SPECIFIERS)).toEqual({
      ok: true,
      value: ["a", "b cd", "e'f", "g h"],
    });
  });

  test("keeps an empty quoted word", () => {
    expect(unitWords(`a "" b`, SPECIFIERS)).toEqual({
      ok: true,
      value: ["a", "", "b"],
    });
  });
});
