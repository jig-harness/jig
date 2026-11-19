import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import packageJson from "../package.json" with { type: "json" };

test("audit checks the pushed branch against the remote default branch", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jig-audit-"));
  const cwd = join(scratch, "checkout");
  const untrustedBin = join(scratch, "untrusted-bin");
  mkdirSync(cwd);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expectSpawnExit(result, 0, args.join(" "));
    return result.stdout.toString().trim();
  };
  const audit = (upstreamBase?: string) =>
    Bun.spawnSync([process.execPath, "run", "audit"], {
      cwd,
      env: {
        ...Bun.env,
        FALLOW_AUDIT_BASE: upstreamBase,
        PATH:
          untrustedBin +
          delimiter +
          join(import.meta.dir, "../node_modules/.bin") +
          delimiter +
          (Bun.env.PATH ?? ""),
      },
    });
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Audit Test");
    git("config", "user.email", "audit@example.invalid");
    git("init", "--bare", join(scratch, "remote"));
    git("remote", "add", "origin", join(scratch, "remote"));
    mkdirSync(untrustedBin);
    const hijackedGit = join(untrustedBin, "git");
    writeFileSync(
      hijackedGit,
      `#!/bin/sh\ntouch ${join(scratch, "hijacked-git")}\n`,
    );
    chmodSync(hijackedGit, 0o755);
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          audit: packageJson.scripts.audit.replace(
            "scripts/audit.ts",
            JSON.stringify(join(import.meta.dir, "audit.ts")),
          ),
        },
      }),
    );
    writeFileSync(
      join(cwd, ".fallowrc.json"),
      JSON.stringify({ entry: ["index.ts"] }),
    );
    writeFileSync(join(cwd, "index.ts"), "console.log('base');\n");
    git("add", ".");
    git("commit", "-m", "Base");
    git("push", "-u", "origin", "main");
    const base = git("rev-parse", "HEAD");

    git("switch", "-c", "topic");
    const branches = Array.from(
      { length: 30 },
      (_, i) => `if (value === ${i}) return "${i}";`,
    );
    writeFileSync(
      join(cwd, "index.ts"),
      `function auditFinding(value: number) {\n${branches.join("\n")}\nreturn "";\n}\nconsole.log(auditFinding(0));\n`,
    );
    git("commit", "-am", "Introduce complexity");
    git("push", "-u", "origin", "topic");
    const topic = git("rev-parse", "@{upstream}");

    const result = audit();
    expectSpawnExit(result, 1);
    expect(existsSync(join(scratch, "hijacked-git"))).toBeFalse();
    expect(result.stdout.toString() + result.stderr.toString()).toContain(
      "auditFinding",
    );
    expect(result.stdout.toString() + result.stderr.toString()).toContain(base);

    git("update-ref", "-d", "refs/remotes/origin/main");
    const missing = audit(topic);
    expectSpawnExit(missing, 2);
    expect(missing.stderr.toString()).toContain("origin/main");

    git("update-ref", "refs/remotes/origin/default", base);
    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/default",
    );
    const symbolic = audit(topic);
    expectSpawnExit(symbolic, 1);
    expect(symbolic.stdout.toString()).toContain(base);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
