/** Native Windows preview and parser checks, where PowerShell is available. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { byPlatform } from "../../lib/test-helpers/windows-skip.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";

const pwsh = Bun.which("pwsh");
const script = join(import.meta.dirname, "bootstrap.ps1");

test.skipIf(!pwsh)(
  "PowerShell provisioning captures output and terminates a stalled command",
  () => {
    const result = Bun.spawnSync(
      [
        pwsh as string,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:BOOTSTRAP_SCRIPT,[ref]$tokens,[ref]$errors)
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Provision'},$true)
if(-not $function) { throw 'Missing provisioning runner' }
Invoke-Expression $function.Extent.Text
$env:JIG_SETUP_TIMEOUT_SECONDS='10'
if((Invoke-Provision $env:TEST_PWSH @('-NoProfile','-NonInteractive','-Command',"Write-Output 'provision-ok'")).Trim() -ne 'provision-ok') { throw 'Output lost' }
$env:JIG_SETUP_TIMEOUT_SECONDS='0.1'
try { Invoke-Provision $env:TEST_PWSH @('-NoProfile','-NonInteractive','-Command','[Threading.Thread]::Sleep(30000)'); exit 1 }
catch { if($_.Exception.Message -notmatch 'Provisioning timed out') { throw }; Write-Output 'timeout confirmed' }`,
      ],
      {
        env: {
          ...process.env,
          BOOTSTRAP_SCRIPT: script,
          TEST_PWSH: pwsh as string,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    expectSpawnExit(result, 0);
    expect(result.stdout.toString()).toContain("timeout confirmed");
  },
  25_000,
);

test.skipIf(!pwsh)(
  "PowerShell entry point parses without syntax errors",
  () => {
    const result = Bun.spawnSync(
      [
        pwsh as string,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:BOOTSTRAP_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count) { $errors | Write-Error; exit 1 }",
      ],
      {
        env: { ...process.env, BOOTSTRAP_SCRIPT: script },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    expectSpawnExit(result, 0);
  },
);

test.skipIf(!pwsh)(
  "Windows preview checks auth and registration without installer or profile writes",
  () => {
    const platform = byPlatform(
      "the native PowerShell entry point targets Windows",
      { windows: "windows", posix: "posix" },
    );
    if (platform === "posix") {
      const result = Bun.spawnSync(
        [
          pwsh as string,
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          "-Revision",
          "a".repeat(40),
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
      );
      expectSpawnExit(result, 1);
      expect(result.stderr.toString()).toContain("bootstrap.sh");
      return;
    }
    const scratch = mkdtempSync(join(tmpdir(), "jig-pwsh-entry-"));
    const log = join(scratch, "calls.jsonl");
    writeFileSync(log, "");
    const revision = "a".repeat(40);
    const fake = (name: string, body: string) =>
      writeFakeProgram(
        join(scratch, name),
        `#!/usr/bin/env bun
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);const key=args.join(' ');
appendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(name)},...args])+'\\n');
${body}`,
      );
    fake(
      "git",
      `if(['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_CONFIG'].some(key=>process.env[key]))process.exit(44);
if(args.includes('rev-parse'))console.log('${revision}');else if(key==='--version')console.log('git version 2.50.0');`,
    );
    fake(
      "gh",
      "if(key==='--version')console.log('gh version 2.80.0');else if(args.includes('user'))console.log('test-user');else if(args[0]==='api')console.log('jig-harness/jig');else if(args[0]!=='auth')process.exit(1);",
    );
    fake(
      "codex",
      "if(key==='--version')console.log('codex-cli 0.159.0');else if(key==='plugin marketplace list --json')console.log('{\"marketplaces\":[]}');else if(key==='plugin list --json')console.log('{\"installed\":[]}');else process.exit(1);",
    );
    try {
      const result = Bun.spawnSync(
        [
          pwsh as string,
          "-NoProfile",
          "-NonInteractive",
          "-File",
          script,
          "-Revision",
          revision,
          "-Codex",
        ],
        {
          env: {
            ...process.env,
            HOME: scratch,
            USERPROFILE: scratch,
            CODEX_HOME: scratch,
            JIG_MARKETPLACE: "",
            GIT_DIR: "C:/other/git",
            GIT_WORK_TREE: "C:/other",
            GIT_INDEX_FILE: "C:/other/index",
            GIT_COMMON_DIR: "C:/other/common",
            GIT_OBJECT_DIRECTORY: "C:/other/objects",
            GIT_ALTERNATE_OBJECT_DIRECTORIES: "C:/other/alternate",
            GIT_CONFIG: "C:/other/config",
            PATH: [scratch, dirname(process.execPath)].join(delimiter),
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      expectSpawnExit(result, 0);
      expect(result.stdout.toString()).toContain("Preview only");
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        calls.some((call) => call[0] === "gh" && call.includes("user")),
      ).toBe(true);
      expect(
        calls
          .filter((call) => call[0] === "codex")
          .every(
            (call) => call.includes("--json") || call.includes("--version"),
          ),
      ).toBe(true);
      expect(
        calls.some(
          (call) => call.includes("install") || call.includes("login"),
        ),
      ).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  45_000,
);
