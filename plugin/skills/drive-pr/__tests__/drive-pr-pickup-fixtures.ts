/**
 * drive-pr suite: fixtures shared by the files that test picking a stopped
 * drive up (`drive-pr-drive-pickup*.test.ts`): stand-in drivers and their
 * claims, back-dated progress, billing-account hashes and scratch trees.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { formatClaim } from "../scripts/lib/claim.ts";
import { accountHash } from "../scripts/lib/identity.ts";
import {
  binDir,
  gitCleanEnv,
  makeScratchRepo,
  tmpRoot,
} from "./drive-pr-harness.ts";
import { state } from "./drive-loop-harness.ts";

/** The hashed account a Claude pass logged in as `email` bills. */
export function loginAccount(email: string): string {
  const hash = accountHash({
    account: email,
    vendor: "claude",
    provenance: "oauthAccount",
    reason: null,
  });
  if (hash === null) throw new Error("a resolved login always hashes");
  return hash;
}

/**
 * The environment of a Claude pass logged in as `email`: a config directory
 * whose `.claude.json` names it, and no token or API key in front of it.
 */
export function loginEnv(email: string): Record<string, string> {
  const dir = join(tmpRoot, `login-${email.replace(/[^a-z0-9]/gi, "-")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
  return {
    CLAUDE_CONFIG_DIR: dir,
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
  };
}

/** Whether a process is still running, by the signal-0 probe. */
export function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

/** A scratch repository of the test's own, so leftovers stay out of the shared one. */
export function ownTree(name: string): string {
  return makeScratchRepo(`pickup-${name}`).dir;
}

/** A scratch tree that tracks a remote, so its leftovers can be counted. */
export function trackedTree(name: string): string {
  const tree = ownTree(name);
  const origin = join(tmpRoot, `pickup-${name}-origin`);
  const git = (cwd: string, ...args: string[]) =>
    expectSpawnExit(
      Bun.spawnSync(["git", ...args], {
        cwd,
        env: gitCleanEnv(),
        stdout: "pipe",
        stderr: "pipe",
      }),
      0,
    );
  git(tmpRoot, "init", "-q", "--bare", origin);
  git(tree, "remote", "add", "origin", origin);
  git(tree, "push", "-q", "-u", "origin", "main");
  return tree;
}

/**
 * A process whose command line reads as a driver's, as `--stop` checks it;
 * with `pass`, it keeps a child running, as a driver does during a pass.
 */
export function fakeDriver(pass = false) {
  const body = pass
    ? "Bun.spawn(['sleep', '60']); setInterval(() => {}, 1000)"
    : "setInterval(() => {}, 1000)";
  return Bun.spawn([process.execPath, "-e", body, "drive.ts", "999"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** A pid that is really dead: a child that ran and exited. */
export async function deadPid(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

/** Plant PR 999's lock, claimed by `pid` driving from `worktree`. */
export function plantPrLock(
  stateDir: string,
  pid: number,
  worktree: string,
): void {
  const lock = join(stateDir, "pr-drive-999.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "claim.feedc0de"),
    formatClaim(pid, hostname(), {
      pr: "999",
      worktree,
      log: join(stateDir, "drive-pr-999.log"),
      started: new Date().toISOString(),
      account: {
        account: "dev@example.invalid",
        vendor: "claude",
        provenance: "oauthAccount",
        reason: null,
      },
    }),
  );
}

/** Set the drive's last progress (`''` for never), as the doctor reads it. */
export async function progressAt(stateDir: string, iso: string): Promise<void> {
  await state(stateDir, ["phase", "999", "--set", "probe"]);
  const file = join(stateDir, "drive-pr-999.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...s, lastProgressAt: iso }));
}

/** Five hours ago: progress past the doctor's stall threshold. */
export function stale(): string {
  return new Date(Date.now() - 5 * 3600_000).toISOString();
}

/**
 * A `gh` in front of the suite's stub that answers what `reply-to-thread.ts`
 * asks (the thread's owning PR, open, and the reply mutation) and records
 * every reply body in `<dir>/replies.log`. Returns the directory to put first
 * on PATH.
 */
export function replyRecordingGh(name: string): { bin: string; log: string } {
  const bin = join(tmpRoot, `pickup-${name}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "replies.log");
  const stub = join(binDir, "gh");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      'tid=""',
      'for a in "$@"; do case "$a" in threadId=*) tid=$(printf %s "$a" | cut -d= -f2-) ;; esac; done',
      'for a in "$@"; do case "$a" in *"pullRequest { number state }"*)',
      '  printf \'{"data":{"node":{"__typename":"PullRequestReviewThread","id":"%s","pullRequest":{"number":999,"state":"OPEN"}}}}\' "$tid"; exit 0 ;;',
      "esac; done",
      'case " $* " in *" --input "*)',
      "  body=$(cat)",
      '  case "$body" in *addPullRequestReviewThreadReply*)',
      `    printf '%s\\n' "$body" >> '${log}'`,
      '    echo "https://example.invalid/reply"; exit 0 ;;',
      "  esac",
      `  printf '%s' "$body" | exec '${stub}' "$@" ;;`,
      "esac",
      `exec '${stub}' "$@"`,
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}
