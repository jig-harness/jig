/**
 * Capture the exact pickup selected by its immutable token.
 * The writer archives rendered content with its owned identifiers. Later
 * pickups may overwrite item aliases and session copies, but cannot change
 * the bytes addressed by this token. Never infer a source from mutable files.
 * Capture checks the open PR and worktree head, then binds an archive's owned
 * identifier to that head or a PR claim. Existing valid pins are first-write-wins.
 */

import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  readPickup,
  renewPickup,
  withFileLock,
} from "../../../do-issue/scripts/lib/intent-chain-pickup.ts";
import { topLevelParagraphs } from "./markdown-paragraphs.ts";
import {
  INTENT_CHAIN_SUBDIR,
  identifierFromBranchName,
  prCaptureFileName,
} from "./state/handoff.ts";

/** A snapshot is budgeted at 4000 characters by the writer; this bound only
 * refuses a file that is not one, rather than copy something unbounded. */
export { PICKUP_MAX_BYTES as CAPTURE_MAX_BYTES } from "../../../do-issue/scripts/lib/intent-chain-pickup.ts";

export interface CaptureInput {
  pr: string;
  /** `gh pr view --json state`. */
  state: string;
  headRefName: string;
  title: string;
  body: string;
  /** `git rev-parse --abbrev-ref HEAD` of the worktree being driven. */
  checkedOutBranch: string;
  /** The `.context/` directory holding `intent-chain/`. */
  contextDir: string;
  /** Overwrite an existing pin. */
  refresh: boolean;
  /** Immutable pickup token emitted by intent-chain.ts; required for a new pin. */
  pickupId?: string;
}

export type CaptureResult =
  | {
      kind: "captured";
      identifier: string;
      via: "branch" | "claim";
      path: string;
    }
  | { kind: "kept"; path: string }
  | { kind: "skipped"; reason: string };

// A trailer line is the keyword followed by nothing but identifiers and their
// separators — "Fixes the flake an earlier change introduced." is prose, not a claim.
const ID = "[A-Za-z][A-Za-z0-9]*-\\d+";
// Horizontal whitespace only, and a real separator between identifiers: `\\s`
// spans newlines and an optional separator lets `an earlier changean earlier change` or a line break
// glue two identifiers into one "trailer".
const SEP = "(?:[ \\t]*[,&][ \\t]*|[ \\t]+and[ \\t]+)";
const TRAILER_RE = new RegExp(
  `^[ \\t]*(?:references?|closes?|fixes?|resolves?)(?::[ \\t]*|[ \\t]+)${ID}(?:${SEP}${ID})*[ \\t\\r]*$`,
  "gim",
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text a body actually asserts: the raw source of its top-level
 * paragraphs. Fenced and indented code, HTML (comments included), block quotes
 * (lazy continuations too), lists and headings are all dropped — a
 * `References: ENG-12` sample inside any of them is an example, not a claim.
 * The scanner follows the CommonMark block rules rather than matching
 * patterns, and its tests pin each construct. */
function claimText(body: string): string {
  return topLevelParagraphs(body).join("\n");
}

/** Does the PR itself claim `identifier`: in its title, or on a trailer line? */
export function prClaimsIdentifier(
  identifier: string,
  title: string,
  body: string,
): boolean {
  // An identifier-token boundary on both sides: a trailing digit or letter
  // makes it a different issue.
  const token = new RegExp(
    `(?<![A-Za-z0-9])${escapeRe(identifier)}(?![A-Za-z0-9])`,
    "i",
  );
  if (token.test(title)) return true;
  return (claimText(body).match(TRAILER_RE) ?? []).some((line) =>
    token.test(line),
  );
}

const ARM_LINE_RE = /^<!-- refocus-arm: (on|off) -->$/;

function regularFileSize(file: string): number | null {
  try {
    const st = lstatSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** An existing pin is kept only if it is a regular file the round can render:
 * `intentChainSection` refuses a first line that is not the writer's arm line,
 * so keeping one would strand the PR without a chain until a manual refresh. */
function pinIsValid(file: string): boolean {
  if (regularFileSize(file) === null) return false;
  try {
    const first = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    return ARM_LINE_RE.test(first);
  } catch {
    return false;
  }
}

/** Replaces a pin the round cannot render, without ever displacing a valid one.
 * Repair and `--refresh` are the only operations that overwrite an existing
 * pin, and both run under the same pin lock; creators `link`, which fails while
 * any pin exists. Under the lock the pin can therefore change only by our hand,
 * so the validity re-check still holds at the rename. Moving a suspect pin
 * aside instead leaves the slot empty for a third writer while a valid winner
 * sits displaced. Consumes `tmp` either way.
 */
function replaceInvalidPin(tmp: string, pin: string): "captured" | "kept" {
  return withFileLock(pinLock(pin), () => {
    // The slot may have been emptied (pruned) or repaired since our check.
    try {
      linkSync(tmp, pin);
      unlinkSync(tmp);
      return "captured";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (pinIsValid(pin)) {
      unlinkSync(tmp);
      return "kept";
    }
    renameSync(tmp, pin);
    return "captured";
  });
}

function pinLock(pin: string): string {
  return `${pin}.lock`;
}

export function captureIntentChain(input: CaptureInput): CaptureResult {
  const skip = (reason: string): CaptureResult => ({ kind: "skipped", reason });
  if (!/^[0-9]+$/.test(input.pr))
    return skip(`'${input.pr}' is not a PR number`);
  if (input.state !== "OPEN") {
    return skip(
      `PR #${input.pr} is ${input.state || "in an unreadable state"}, not OPEN`,
    );
  }
  if (input.headRefName === "")
    return skip("the PR's head branch was not reported");
  if (input.checkedOutBranch !== input.headRefName) {
    return skip(
      `this worktree is on '${input.checkedOutBranch || "(no branch)"}', not PR #${input.pr}'s head branch '${input.headRefName}' — its .context/ does not describe this PR`,
    );
  }

  const chainDir = join(input.contextDir, INTENT_CHAIN_SUBDIR);
  const pin = join(chainDir, prCaptureFileName(input.pr));
  if (!input.refresh && pinIsValid(pin)) {
    // A live drive re-arming is use: keep the pin out of the writer's prune.
    // Validity is re-checked under the lock: the writer's prune can delete an
    // expired pin between the check above and this renewal, and `kept` must
    // only be reported for a pin that still exists.
    let renewed = false;
    try {
      renewed = withFileLock(pinLock(pin), () => {
        if (!pinIsValid(pin)) return false;
        const now = new Date();
        utimesSync(pin, now, now);
        return true;
      });
    } catch {
      // Best effort; the pin is still valid if it was not pruned.
      renewed = pinIsValid(pin);
    }
    if (renewed) return { kind: "kept", path: pin };
  }

  if (!input.pickupId) {
    return skip(
      "a new pin requires --pickup <token> from the intended intent-chain.ts invocation; mutable item aliases and .current are never capture sources",
    );
  }
  let pickup: ReturnType<typeof readPickup>;
  try {
    pickup = readPickup(chainDir, input.pickupId);
  } catch (err) {
    return skip(`immutable pickup is unusable: ${(err as Error).message}`);
  }
  const branchId = identifierFromBranchName(input.headRefName);
  const identifier =
    branchId === null
      ? pickup.identifiers.find((id) =>
          prClaimsIdentifier(id, input.title, input.body),
        )
      : pickup.identifiers.find(
          (id) => id.toLowerCase() === branchId.toLowerCase(),
        );
  if (!identifier) {
    return skip(
      "the selected pickup owns no identifier named by this PR head or claimed in its title/trailers",
    );
  }
  const via = branchId === null ? "claim" : "branch";

  // Atomic, like the writer: a reader must never see half a pin.
  const tmp = `${pin}.tmp-${process.pid}`;
  try {
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(tmp, pickup.text, { mode: 0o600 });
    if (input.refresh) {
      withFileLock(pinLock(pin), () => renameSync(tmp, pin));
    } else {
      // First-write-wins must hold across concurrent invocations of the
      // manual CLI, so creation is exclusive: `link` fails with EEXIST where a
      // check-then-rename would let the last writer win.
      try {
        linkSync(tmp, pin);
        unlinkSync(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (pinIsValid(pin)) {
          unlinkSync(tmp);
          return { kind: "kept", path: pin };
        }
        if (replaceInvalidPin(tmp, pin) === "kept") {
          return { kind: "kept", path: pin };
        }
      }
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone; the write error below is the one worth reporting.
    }
    return skip(`cannot write ${pin}: ${(err as Error).message}`);
  }
  // Capture is use of the archive: restart its retention so an unrelated
  // pickup cannot prune the source a deliberate refresh still needs.
  try {
    renewPickup(chainDir, input.pickupId);
  } catch {
    // Best effort; the pin is already written.
  }
  return { kind: "captured", identifier, via, path: pin };
}
