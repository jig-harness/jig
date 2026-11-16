/**
 * gc's admission around a removal through Orca: the admission is marked
 * submitted just before `orca worktree rm`, an unanswered call keeps it, and
 * only the call's answer releases it. `orca` is injected, so a timeout is the
 * answer the process runner gives when the deadline ends the call.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardKey } from "../../shared/orca-guard.ts";
import { ok } from "../../shared/outcome.ts";
import { guardedCollection } from "../kinds/worktree-guard.ts";
import { type OrcaCall, removeThroughOrca } from "../worktree-removal.ts";

const PATH = "/home/someone/orca/workspaces/app/topic";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "worktree-guard-"));
  temporary.push(dir);
  return dir;
}

type Answer = Awaited<ReturnType<OrcaCall>>;

/**
 * Collect the worktree under gc's admission in `root`, with `orca worktree
 * rm` answering `answer`; what the admission held when the call was made,
 * and the receipt's reason and details.
 */
async function collect(root: string, answer: Answer) {
  const file = join(root, "admissions", `${guardKey(PATH)}.json`);
  let atCall: Record<string, unknown> | null = null;
  const collected = await guardedCollection(
    { id: PATH, details: { runtime: "orca" } },
    PATH,
    async (guard) => {
      const removed = await removeThroughOrca({
        worktree: PATH,
        id: "wt-1",
        force: false,
        log: () => undefined,
        orca: async () => {
          atCall = JSON.parse(readFileSync(file, "utf8"));
          return answer;
        },
        steps: {
          hook: () => null,
          runHook: () => ok(undefined),
          park: async () => ok(undefined),
          submit: () => guard.submit(),
        },
      });
      guard.settle(removed);
      return removed.ok
        ? { outcome: "collected", reason: "removed" }
        : { outcome: "failed", reason: removed.failure.reason };
    },
    root,
  );
  return { collected, atCall, file };
}

const timedOut: Answer = {
  code: 124,
  stdout: "",
  stderr: "",
  timedOut: true,
};
const exited: Answer = { code: 1, stdout: "", stderr: "orca: lost" };
const garbled: Answer = { code: 0, stdout: "orca: sideways", stderr: "" };
const removed: Answer = {
  code: 0,
  stdout: JSON.stringify({ ok: true, result: { removed: true } }),
  stderr: "",
};
const refused: Answer = {
  code: 1,
  stdout: JSON.stringify({
    ok: false,
    error: { code: "worktree_dirty", message: "worktree_dirty" },
  }),
  stderr: "",
};

const stillDeleting: Answer = {
  code: 1,
  stdout: JSON.stringify({
    ok: false,
    error: {
      code: "worktree_removal_in_progress",
      message: "Stopped waiting, but Orca may still be deleting the checkout.",
    },
  }),
  stderr: "",
};
const accepted: Answer = {
  code: 0,
  stdout: JSON.stringify({ ok: true, result: { removing: true } }),
  stderr: "",
};

const emptyRefusal = (error: Record<string, string>): Answer => ({
  code: 1,
  stdout: JSON.stringify({ ok: false, error }),
  stderr: "",
});

describe("the admission around orca worktree rm", () => {
  it.each([
    ["a timeout", timedOut, "did not answer before its deadline"],
    [
      "a refusal with empty code and message",
      emptyRefusal({ code: "", message: "" }),
      "orca worktree rm failed (exit 1)",
    ],
    [
      "a refusal with whitespace-only code and message",
      emptyRefusal({ code: " ", message: "\t " }),
      "orca worktree rm failed (exit 1)",
    ],
    ["a nonzero exit", exited, "orca worktree rm failed (exit 1)"],
    ["output that is not Orca's", garbled, "unreadable output"],
    [
      "Orca stopping its wait while it deletes",
      stillDeleting,
      "Orca is still deleting the checkout in the background",
    ],
    [
      "an answer on accepting the removal",
      accepted,
      "Orca is still deleting the checkout in the background",
    ],
  ])("is kept, marked submitted, after %s", async (_name, answer, why) => {
    const root = scratch();
    const { collected, atCall, file } = await collect(root, answer);
    expect(atCall).toMatchObject({ submitted: expect.any(String) });
    expect(collected.outcome).toBe("failed");
    expect(collected.details).toMatchObject({ claim: "kept" });
    expect(collected.reason).toContain(why);
    expect(collected.reason).toContain(
      "the launch guard claim stays: orca worktree rm was called under it",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(atCall);
  });

  it.each([
    ["a removal", removed, "collected" as const],
    ["Orca's explicit refusal", refused, "failed" as const],
  ])("is released after %s", async (_name, answer, outcome) => {
    const root = scratch();
    const { collected, atCall, file } = await collect(root, answer);
    expect(atCall).toMatchObject({ submitted: expect.any(String) });
    expect(collected.outcome).toBe(outcome);
    expect(collected.reason).not.toContain("the launch guard claim stays");
    expect((collected.details as { claim?: string }).claim).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("is released, and orca worktree rm never called, when the mark cannot be written", async () => {
    const root = scratch();
    const file = join(root, "admissions", `${guardKey(PATH)}.json`);
    let called = false;
    const collected = await guardedCollection(
      { id: PATH },
      PATH,
      async (guard) => {
        // Another collection's admission now stands where gc's was.
        const text = JSON.parse(readFileSync(file, "utf8"));
        writeFileSync(
          file,
          JSON.stringify({ ...text, at: "2000-01-01T00:00:00.000Z" }),
        );
        const removal = await removeThroughOrca({
          worktree: PATH,
          id: "wt-1",
          force: false,
          log: () => undefined,
          orca: async () => {
            called = true;
            return removed;
          },
          steps: {
            hook: () => null,
            runHook: () => ok(undefined),
            park: async () => ok(undefined),
            submit: () => guard.submit(),
          },
        });
        return removal.ok
          ? { outcome: "collected", reason: "removed" }
          : { outcome: "failed", reason: removal.failure.reason };
      },
      root,
    );
    expect(called).toBe(false);
    expect(collected.outcome).toBe("failed");
    expect(collected.reason).toContain("is no longer this collection's");
    expect(collected.reason).not.toContain("the launch guard claim stays");
  });
});
