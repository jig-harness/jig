/**
 * do-item's pre-push protocol tells a lock-wait timeout from a hook that ran
 * and failed by the host's test lock's own refusal, which it quotes. The
 * quote and the lock's message are held together here: rewording either
 * fails this test, so the protocol never classifies by a message the lock
 * no longer prints.
 */
import { expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

const SKILL = readFileSync(resolve(import.meta.dir, "../SKILL.md"), "utf8");
const LOCK = resolve(import.meta.dir, "../../../shared/resource-lock.ts");
/** The lock run as a command: its `main` over `-- true`. */
const RUN = `const { main } = await import(${JSON.stringify(LOCK)}); process.exitCode = await main(["--", "true"]);`;

/** The refusal the protocol quotes, with its placeholders. */
function quotedRefusal(): string {
  const protocol = SKILL.slice(
    SKILL.indexOf("**Pre-push hook failure protocol:**"),
  );
  const quoted = /`(ERROR: could not acquire lock [^`]+)`/.exec(protocol)?.[1];
  if (quoted === undefined)
    throw new TypeError("the pre-push protocol quotes no lock refusal");
  return quoted;
}

/** The quote as a pattern: `<name>` a lock name, `<N>` a number of seconds, `…` anything. */
function asPattern(quoted: string): RegExp {
  const parts = quoted.split(/(<name>|<N>|…)/);
  const source = parts
    .map((part) =>
      part === "<name>"
        ? "[^']+"
        : part === "<N>"
          ? "\\d+"
          : part === "…"
            ? ".*"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "m");
}

it("names the lock wrapper's exit for a lock-wait timeout", () => {
  const protocol = SKILL.slice(
    SKILL.indexOf("**Pre-push hook failure protocol:**"),
    SKILL.indexOf("When the hook ran and failed"),
  );
  expect(protocol).toContain("`with-resource-lock` exits `3`");
});

it.skipIf(
  skipsOnWindows(
    "file-system",
    "the lock's slot is a symlink to a pid, which Windows refuses",
  ),
)(
  "quotes the refusal the host's test lock prints when its wait runs out, which exits 3",
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "jig-prepush-lock-")));
    try {
      // This test's own process holds the lock's only slot.
      symlinkSync(String(process.pid), join(dir, "jig-lock.heavy"));
      // A CI runner sets CI, which makes the lock run its command unlocked.
      const { CI: _ci, RESOURCE_LOCK_BYPASS: _bypass, ...env } = process.env;
      const run = Bun.spawnSync([process.execPath, "-e", RUN], {
        cwd: dir,
        env: {
          ...env,
          HOME: dir,
          USERPROFILE: dir,
          LOCK_ROOT: dir,
          LOCK_NAME: "heavy",
          LOCK_SLOTS: "1",
          LOCK_TIMEOUT: "0",
          LOCK_POLL: "0.05",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(run, 3);
      expect(run.stderr.toString()).toMatch(asPattern(quotedRefusal()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
