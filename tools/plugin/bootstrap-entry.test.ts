/** Entry-point failures must stop before executing or installing a downloaded binary. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";

const shellOnly = skipsOnWindows(
  "powershell",
  "the native Windows entry point uses PowerShell, not Bash",
);
const revision = "a".repeat(40);
function entry(
  args: string[],
  response = "bad-checksum",
  extra: Record<string, string> = {},
) {
  const scratch = mkdtempSync(join(tmpdir(), "jig-entry-"));
  const program = (name: string, source: string) =>
    writeFileSync(join(scratch, name), `#!/bin/sh\n${source}\n`, {
      mode: 0o755,
    });
  program(
    "git",
    `if [ "$RESPONSE" = git-env ] && [ -n "$GIT_DIR$GIT_WORK_TREE$GIT_INDEX_FILE$GIT_COMMON_DIR$GIT_OBJECT_DIRECTORY$GIT_ALTERNATE_OBJECT_DIRECTORIES$GIT_CONFIG$GIT_CONFIG_COUNT$GIT_CONFIG_PARAMETERS$GIT_CONFIG_KEY_0$GIT_CONFIG_VALUE_0" ]; then exit 128; fi
if [ "$1" = -c ]; then test "$2" = core.fsmonitor=false || exit 129; shift 2; fi
case "$1" in rev-parse) echo '${revision}';; esac\ncase "$4" in status) if [ "$RESPONSE" = git-failed ]; then exit 128; fi;; esac
case "$3" in rev-parse) if [ "$RESPONSE" = wrong-revision ]; then echo wrong; else echo '${revision}'; fi;; status) if [ "$RESPONSE" = git-failed ]; then exit 128; fi;; esac`,
  );
  program("gh", "exit 0");
  program("codex", "exit 0");
  if (response === "git-env")
    program(
      "bun",
      'test -z "$GIT_DIR$GIT_WORK_TREE$GIT_INDEX_FILE$GIT_COMMON_DIR$GIT_OBJECT_DIRECTORY$GIT_ALTERNATE_OBJECT_DIRECTORIES$GIT_CONFIG$GIT_CONFIG_COUNT$GIT_CONFIG_PARAMETERS$GIT_CONFIG_KEY_0$GIT_CONFIG_VALUE_0"',
    );
  if (response === "provisioned")
    program("unzip", "printf '#!/bin/sh\\nexit 0\\n'");
  if (response === "package-timeout" || response === "apt-timeout") {
    rmSync(join(scratch, "gh"));
    for (const name of ["dirname", "sleep"])
      symlinkSync(Bun.which(name) as string, join(scratch, name));
    program("uname", 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi');
    if (response === "apt-timeout") {
      program("sudo", 'exec "$@"');
      program("apt-get", "while :; do sleep 1; done");
      program(
        "timeout",
        'test "$1" = --foreground || exit 43\nexec "$REAL_TIMEOUT" "$@"',
      );
    } else {
      symlinkSync(Bun.which("timeout") as string, join(scratch, "timeout"));
      program("brew", "while :; do sleep 1; done");
    }
  }
  program(
    "curl",
    `if [ "$1" = --version ]; then if [ "$RESPONSE" = old-curl ]; then echo 'curl 8.3.0'; else echo 'curl 8.4.0'; fi; exit 0; fi
echo called >> '${scratch}/calls'
if [ "$RESPONSE" = curl-config ] && [ "$1" != -q ]; then exit 42; fi
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done\nprintf invalid > "$destination"\ncase "$RESPONSE" in redirect) printf '302 https://127.0.0.1/private';; interrupted) exit 18;; *) printf '200 ';; esac`,
  );
  const result = Bun.spawnSync(
    [
      "/bin/bash",
      join(import.meta.dirname, "bootstrap.sh"),
      "--revision",
      revision,
      "--codex",
      ...args,
    ],
    {
      env: {
        ...process.env,
        HOME: scratch,
        PATH:
          response === "package-timeout" || response === "apt-timeout"
            ? scratch
            : [scratch, "/usr/bin", "/bin"].join(delimiter),
        RESPONSE: response,
        REAL_TIMEOUT: Bun.which("timeout") ?? "",
        TMPDIR: scratch,
        ...extra,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  const output = {
    ...result,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    downloaded: existsSync(join(scratch, "calls"))
      ? readFileSync(join(scratch, "calls"), "utf8").trim().split("\n").length
      : 0,
    installed: existsSync(join(scratch, ".bun/bin/bun")),
    leftover: readdirSync(scratch).filter((name) => name.startsWith("tmp.")),
  };
  rmSync(scratch, { recursive: true, force: true });
  return output;
}

test.skipIf(shellOnly)(
  "missing tools and malformed options never provision without consent",
  () => {
    const preview = entry([]);
    expectSpawnExit(preview, 1);
    expect(preview.stdout).toContain("Preview only");
    expect(preview.downloaded).toBe(0);
    const bad = entry(["--provision", "--typo"]);
    expectSpawnExit(bad, 2);
    expect(bad.downloaded).toBe(0);
  },
);
test.skipIf(shellOnly)(
  "failed, redirected and corrupt downloads never install Bun",
  () => {
    for (const failure of [
      "bad-checksum",
      "redirect",
      "interrupted",
      "invalid-zip",
    ]) {
      const result = entry(
        [
          "--provision",
          "--bun-version",
          "1.4.4",
          "--bun-sha256",
          failure === "invalid-zip"
            ? new Bun.CryptoHasher("sha256").update("invalid").digest("hex")
            : "0".repeat(64),
        ],
        failure,
      );
      expectSpawnExit(
        result,
        failure === "interrupted" ? 18 : failure === "invalid-zip" ? 9 : 1,
        failure,
      );
      expect(result.downloaded).toBe(1);
      expect(result.installed).toBe(false);
    }
  },
);

test.skipIf(shellOnly)(
  "wrong revisions and unreadable Git status stop before provisioning",
  () => {
    for (const failure of ["wrong-revision", "git-failed"]) {
      const result = entry(["--provision"], failure);
      expectSpawnExit(result, 1);
      expect(result.downloaded).toBe(0);
      expect(result.installed).toBe(false);
    }
  },
);

test.skipIf(shellOnly)("older curl is refused before any download", () => {
  const result = entry(
    ["--provision", "--bun-version", "1.4.4", "--bun-sha256", "0".repeat(64)],
    "old-curl",
  );
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("curl 8.4.0 or later");
  expect(result.downloaded).toBe(0);
  expect(result.installed).toBe(false);
});

test.skipIf(shellOnly)(
  "Git routing variables reach neither verification nor the installer",
  () => {
    const result = entry([], "git-env", {
      GIT_DIR: "/other/git",
      GIT_WORK_TREE: "/other",
      GIT_INDEX_FILE: "/other/index",
      GIT_COMMON_DIR: "/other/common",
      GIT_OBJECT_DIRECTORY: "/other/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/other/alternate",
      GIT_CONFIG: "/other/config",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "/other",
      GIT_CONFIG_PARAMETERS: "'core.worktree'='/other'",
    });
    expectSpawnExit(result, 0);
  },
);

test.skipIf(shellOnly)("download ignores ambient curl configuration", () => {
  const result = entry(
    ["--provision", "--bun-version", "1.4.4", "--bun-sha256", "0".repeat(64)],
    "curl-config",
  );
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("checksum mismatch");
});

test.skipIf(shellOnly)(
  "successful Bun provisioning removes temporary downloads before handoff",
  () => {
    const result = entry(
      [
        "--provision",
        "--bun-version",
        "1.4.4",
        "--bun-sha256",
        new Bun.CryptoHasher("sha256").update("invalid").digest("hex"),
      ],
      "provisioned",
    );
    expectSpawnExit(result, 0);
    expect(result.installed).toBe(true);
    expect(result.leftover).toEqual([]);
  },
);

test.skipIf(shellOnly || !Bun.which("timeout"))(
  "package provisioning has a deadline",
  () => {
    for (const response of ["package-timeout", "apt-timeout"]) {
      const result = entry(
        [
          "--provision",
          "--bun-version",
          "1.4.4",
          "--bun-sha256",
          "0".repeat(64),
        ],
        response,
        { JIG_SETUP_TIMEOUT_SECONDS: "0.1" },
      );
      expectSpawnExit(result, 124);
      expect(result.stderr).toContain("Provisioning timed out");
    }
  },
);
