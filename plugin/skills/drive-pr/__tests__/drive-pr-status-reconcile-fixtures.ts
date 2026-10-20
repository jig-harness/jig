import { existsSync, readFileSync } from "node:fs";

import { join } from "node:path";

import { SCRIPTS, type FixtureThread } from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

export function createStatusReconcileFixtures() {
  /** A thread whose last trusted comment already answered it, unresolved. */
  function repliedThread(id: string, token: string): FixtureThread {
    return {
      id,
      path: "a.ts",
      bot: false,
      comments: [
        { author: "example-review[bot]", bot: true, body: "a finding" },
        {
          author: "agent",
          authorAssociation: "MEMBER",
          body: `${token} — settled in an earlier, interrupted pass`,
        },
      ],
    };
  }

  function resolvedIn(dir: string): string[] {
    const f = join(dir, "resolved-threads.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  }

  /**
   * Both readers below FAIL on a non-zero exit rather than returning the
   * empty answer.
   *
   * `held-keys` returns `''` and `held` returns `[]` when `drive-state.ts`
   * writes nothing to stdout — and those are exactly the values three of the
   * assertions in this describe block treat as the passing result. A broken
   * `drive-state.ts held` would therefore have kept them green while proving
   * nothing about the sweep at all: the vacuous-pass shape.
   */
  function requireOk(exitCode: number, command: string): void {
    if (exitCode !== 0) {
      throw new Error(
        `drive-state.ts ${command} exited ${exitCode}; its empty result would ` +
          'otherwise read as "nothing held"',
      );
    }
  }

  async function heldKeysIn(stateDir: string): Promise<string> {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "held-keys", "999"),
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    requireOk(code, "held-keys");
    return out.trim();
  }

  /**
   * The held RECORDS, not just their keys. A key proves only that some hold
   * mentioning the thread exists — an ordinary claimable hold at the current
   * round satisfies that just as well as the unconfirmed one the sweep is
   * required to write, so a regression from the latter to the former is
   * invisible to a key-only assertion and would let a fix-dependent thread be
   * resolved with no push verification.
   */
  async function heldIn(
    stateDir: string,
  ): Promise<Array<Record<string, unknown>>> {
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "drive-state.ts"), "held", "999"),
      {
        env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    requireOk(code, "held");
    return JSON.parse(out.trim() === "" ? "[]" : out.trim());
  }

  /**
   * Same shape as `repliedThread`, but STARTED by a human — the first comment
   * decides, which is what `list-unresolved-threads.ts --bots-only` filters
   * on. The reply is still a trusted MEMBER one, so the only thing separating
   * this from the bot fixtures is the authorship the social boundary turns on.
   */
  function humanRepliedThread(id: string, token: string): FixtureThread {
    return {
      id,
      path: "a.ts",
      bot: false,
      comments: [
        {
          author: "a-human-reviewer",
          authorAssociation: "MEMBER" as const,
          body: "a finding",
        },
        {
          author: "agent",
          authorAssociation: "MEMBER" as const,
          body: `${token} — settled in an earlier, interrupted pass`,
        },
      ],
    };
  }
  return {
    repliedThread,
    resolvedIn,
    requireOk,
    heldKeysIn,
    heldIn,
    humanRepliedThread,
  };
}
