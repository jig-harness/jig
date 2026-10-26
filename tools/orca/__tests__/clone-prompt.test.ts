/**
 * The clone's command, run by real git: whatever askpass the machine has
 * configured, a source that asks for credentials gets no prompt, while a
 * credential helper is still asked; and SSH runs in batch mode, with
 * OpenSSH's arguments whatever SSH variant the machine names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { withoutLeakyGitEnv } from "../../../plugin/shared/guarded-git-spawn.ts";
import { cloneCommand } from "../clone.ts";

let dir = "";
let server: ReturnType<typeof Bun.serve> | undefined;

/** A server that asks every request for credentials, as a private repository does. */
const source = (): string => `http://127.0.0.1:${server?.port}/acme/app.git`;

/** A program that records it ran in `marker` and answers as a person might. */
async function recorder(name: string, marker: string, reply: string) {
  const path = join(dir, name);
  await writeFile(
    path,
    `#!/bin/sh\necho "$@" >> '${marker}'\nprintf '%s\\n' '${reply}'\nexit 0\n`,
  );
  await chmod(path, 0o755);
  return path;
}

/** This process's environment without an askpass or display of its own. */
function inherited(): Record<string, string | undefined> {
  const {
    GIT_ASKPASS: _git,
    SSH_ASKPASS: _ssh,
    DISPLAY: _display,
    ...rest
  } = withoutLeakyGitEnv();
  return rest;
}

/** Run `argv` as the clone's machine would, with `env` added to a clean environment. */
async function run(argv: string[], env: Record<string, string>) {
  const [command, ...args] = argv;
  const proc = Bun.spawn([command ?? "", ...args], {
    cwd: dir,
    env: {
      ...inherited(),
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  await expectSpawnExited(proc, 128, argv.join(" "));
}

/** Each way a machine can configure askpass, as the environment of the clone. */
const askpassBy = (
  program: string,
): Record<string, Record<string, string>> => ({
  GIT_ASKPASS: { GIT_ASKPASS: program },
  SSH_ASKPASS: { SSH_ASKPASS: program, DISPLAY: ":0" },
  "core.askPass": {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.askPass",
    GIT_CONFIG_VALUE_0: program,
  },
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jig-orca-clone-prompt-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response("", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="repo"' },
      }),
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("the clone's command", () => {
  for (const by of Object.keys(askpassBy(""))) {
    test(`runs no askpass set by ${by}, where a plain clone runs it`, async () => {
      const marker = join(dir, `asked-${by}`);
      const askpass = await recorder(`askpass-${by}`, marker, "secret");
      const env = askpassBy(askpass)[by] ?? {};
      await run(
        ["git", "clone", "--", source(), join(dir, `plain-${by}`)],
        env,
      );
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await run(cloneCommand(source(), join(dir, `clone-${by}`)), env);
      expect(existsSync(marker)).toBe(false);
    });
  }

  test("still asks a credential helper", async () => {
    const marker = join(dir, "helper-asked");
    const helper = await recorder("helper", marker, "");
    await run(cloneCommand(source(), join(dir, "clone-helper")), {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: helper,
    });
    expect(readFileSync(marker, "utf8")).toContain("get");
  });

  /** Each way a machine can name an SSH variant other than OpenSSH's. */
  const variantBy: Record<string, Record<string, string>> = {
    none: {},
    GIT_SSH_VARIANT: { GIT_SSH_VARIANT: "simple" },
    "ssh.variant": {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "ssh.variant",
      GIT_CONFIG_VALUE_0: "plink",
    },
  };

  for (const [by, variant] of Object.entries(variantBy)) {
    test(`runs SSH in batch mode with OpenSSH's arguments, whatever variant ${by} names`, async () => {
      const marker = join(dir, `ssh-args-${by}`);
      const bin = join(dir, "bin");
      await Bun.$`mkdir -p ${bin}`.quiet();
      await writeFile(
        join(bin, "ssh"),
        `#!/bin/sh\necho "$@" >> "$SSH_MARKER"\nexit 255\n`,
      );
      await chmod(join(bin, "ssh"), 0o755);
      await run(
        cloneCommand(
          "ssh://git@example.invalid:2222/acme/app.git",
          join(dir, `ssh-${by}`),
        ),
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          SSH_MARKER: marker,
          ...variant,
        },
      );
      const args = readFileSync(marker, "utf8");
      expect(args).toContain("-o BatchMode=yes");
      expect(args).toContain("-p 2222");
    });
  }
});
