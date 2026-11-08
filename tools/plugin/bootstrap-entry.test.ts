/** Entry-point failures must stop before executing or installing a downloaded binary. */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
function entry(args: string[], response = "bad-checksum") {
  const scratch = mkdtempSync(join(tmpdir(), "jig-entry-"));
  const program = (name: string, source: string) =>
    writeFileSync(join(scratch, name), `#!/bin/sh\n${source}\n`, {
      mode: 0o755,
    });
  program(
    "git",
    `case "$1" in rev-parse) echo '${revision}';; esac\ncase "$3" in rev-parse) if [ "$RESPONSE" = wrong-revision ]; then echo wrong; else echo '${revision}'; fi;; status) if [ "$RESPONSE" = git-failed ]; then exit 128; fi;; esac`,
  );
  program("gh", "exit 0");
  program("codex", "exit 0");
  program(
    "curl",
    `if [ "$1" = --version ]; then if [ "$RESPONSE" = old-curl ]; then echo 'curl 8.3.0'; else echo 'curl 8.4.0'; fi; exit 0; fi
echo called >> '${scratch}/calls' \nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; destination=$1; fi; shift; done\nprintf invalid > "$destination"\ncase "$RESPONSE" in redirect) printf '302 https://127.0.0.1/private';; interrupted) exit 18;; *) printf '200 ';; esac`,
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
        PATH: [scratch, "/usr/bin", "/bin"].join(delimiter),
        RESPONSE: response,
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
