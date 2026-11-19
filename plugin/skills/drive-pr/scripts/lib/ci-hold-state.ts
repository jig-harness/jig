/**
 * The CI hold's durable record and the reads that establish it: the drive
 * state's `ciHold` field, the pull request's label and its timeline, the
 * check runs on a head, and the adoption of a live hold label the drive holds
 * no record of.
 */

import {
  type CheckRunLite,
  checkRunWatermark,
  ciHoldTransitions,
  type LabelTransition,
  parseCheckRuns,
  ownsHeldTransition,
  type PrSnapshot,
  parsePrSnapshot,
} from "./ci-hold.ts";
import { readTimeline } from "./pr-timeline.ts";
import {
  attempt,
  type Failure,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import { isGitSha } from "./cli.ts";
import {
  listingCutShort,
  type ListingCutShort,
  slurpCheckRuns,
} from "./paged-read.ts";
import { ghCall } from "./proc.ts";
import type { CiHoldState } from "./state/schema.ts";
import { openStore } from "./state/store.ts";

type HeldState = Extract<CiHoldState, { phase: "held" }>;

/** A hold read that failed: the forge was not reached, or answered with something unreadable. */
export type HoldReadFailure = Failure<"unreadable" | "malformed">;

/** The pull request's state, head and hold label. */
export async function readPrSnapshot(
  pr: string,
  holdLabel: string | null,
): Promise<Outcome<PrSnapshot, HoldReadFailure["code"]>> {
  const result = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,headRefOid,labels",
  ]);
  if (result.code !== 0)
    return failed(
      "unreadable",
      `gh pr view exited ${result.code}: ${(result.stderrTail || result.stderr).trim().slice(-500)}`,
    );
  const decoded = attempt(
    "malformed",
    "the pull request view is not JSON",
    (): unknown => JSON.parse(result.stdout),
  );
  if (!decoded.ok) return decoded;
  const snapshot = parsePrSnapshot(decoded.value, holdLabel);
  return snapshot === null
    ? failed("malformed", "the pull request view is not a snapshot")
    : ok(snapshot);
}

/** The hold label's transitions on the timeline. */
export async function readHoldTransitions(
  pr: string,
  holdLabel: string,
): Promise<Outcome<LabelTransition[], HoldReadFailure["code"]>> {
  const events = await readTimeline(pr);
  if (!events.ok) return events;
  const transitions = ciHoldTransitions(events.value, holdLabel);
  return transitions === null
    ? failed("malformed", `a '${holdLabel}' event on the timeline is malformed`)
    : ok(transitions);
}

/**
 * The authenticated actor and the live state just before a label mutation,
 * or the first read that failed.
 */
export async function readBeforeMutation(
  pr: string,
  holdLabel: string | null,
): Promise<
  Outcome<
    { login: string; live: PrSnapshot; timeline: LabelTransition[] },
    HoldReadFailure["code"]
  >
> {
  const who = await ghCall(["api", "user", "-q", ".login"]);
  const login = who.stdout.trim();
  if (who.code !== 0)
    return failed(
      "unreadable",
      `cannot identify the authenticated GitHub actor: gh api exited ${who.code}: ${(who.stderrTail || who.stderr).trim().slice(-500)}`,
    );
  if (login === "")
    return failed(
      "malformed",
      "cannot identify the authenticated GitHub actor: the answer names no login",
    );
  const live = await readPrSnapshot(pr, holdLabel);
  if (!live.ok) return live;
  const timeline = await readHoldTransitions(pr, holdLabel ?? "");
  if (!timeline.ok) return timeline;
  return ok({ login: login, live: live.value, timeline: timeline.value });
}

/** A read's value, or `null` after saying why it failed. */
export function valueOrNull<T>(read: Outcome<T, string>): T | null {
  if (read.ok) return read.value;
  console.error(`ci-hold: ${read.failure.reason}`);
  return null;
}

export async function readCiState(pr: string): Promise<CiHoldState | null> {
  return (await openStore(pr)).read().state.ciHold;
}

export async function writeCiState(
  pr: string,
  state: CiHoldState | null,
): Promise<void> {
  const store = await openStore(pr);
  await store.update((current) => ({ ...current, ciHold: state }));
}

/**
 * The check runs on `head`, or why the forge's answer could not be read.
 * Read fresh (`paged-read.ts`): they guard a hold release, a watermark
 * recorded before a label change and a re-run of cancelled jobs.
 */
export async function readCheckRuns(
  head: string,
): Promise<Outcome<CheckRunLite[], HoldReadFailure["code"]>> {
  return (await checkRunsRead(head)).runs;
}

/** `readCheckRuns`' answer, and how the listing was cut short when it was. */
export async function checkRunsRead(head: string): Promise<{
  runs: Outcome<CheckRunLite[], HoldReadFailure["code"]>;
  cutShort: ListingCutShort | null;
}> {
  const result = await slurpCheckRuns("{owner}", "{repo}", head, "fresh");
  return {
    runs: parsedCheckRuns(result),
    cutShort: result.code === 0 ? null : listingCutShort(head, result),
  };
}

function parsedCheckRuns(
  result: Awaited<ReturnType<typeof slurpCheckRuns>>,
): Outcome<CheckRunLite[], HoldReadFailure["code"]> {
  if (result.code !== 0)
    return failed(
      "unreadable",
      `gh api check-runs exited ${result.code}: ${(result.stderrTail || result.stderr).trim().slice(-500)}`,
    );
  const decoded = attempt(
    "malformed",
    "the check-runs answer is not JSON",
    (): unknown => JSON.parse(result.stdout),
  );
  if (!decoded.ok) return decoded;
  const runs = parseCheckRuns(decoded.value);
  if (runs === null)
    return failed("malformed", "the check-runs answer has an invalid shape");
  return ok(runs);
}

export async function checkRuns(head: string): Promise<CheckRunLite[] | null> {
  return valueOrNull(await readCheckRuns(head));
}

/**
 * The highest check-run id on `head`. An unreadable forge answer remains
 * distinct from malformed evidence so a caller immediately before a mutation
 * can retry transport failures without treating them as a corrupt proof.
 * A successful `null` means no run is registered yet; the caller waits, and
 * never records a zero watermark for a drive release.
 */
export async function headWatermark(
  head: string,
  why: string,
): Promise<
  | Outcome<number | null, HoldReadFailure["code"]>
  | { ok: false; failure: HoldReadFailure; cutShort: ListingCutShort }
> {
  if (!isGitSha(head))
    return failed(
      "malformed",
      `cannot establish the check-run watermark ${why}: the head is not a SHA`,
    );
  const { runs, cutShort } = await checkRunsRead(head);
  if (!runs.ok) {
    const failure = failed(
      runs.failure.code,
      `cannot establish the check-run watermark ${why}: ${runs.failure.reason}`,
    );
    return cutShort === null ? failure : { ...failure, cutShort };
  }
  return ok(checkRunWatermark(runs.value, head));
}

/**
 * Record a live hold label's newest `labeled` event as this drive's own, so
 * that the drive pushes under it and removes it at convergence. The label is
 * a CI cost setting: whoever added it, removing it costs one full CI run,
 * which convergence needs anyway, and the final head is certified only on
 * checks that started after the removal. `null` while the timeline does not
 * yet show the label being added.
 */
export async function adopt(
  pr: string,
  head: string,
  latest: LabelTransition | null,
  label: string,
): Promise<HeldState | null> {
  if (latest?.event !== "labeled") return null;
  const held: HeldState = {
    phase: "held",
    adopted: true,
    eventId: latest.id,
    addedAtHead: head,
    actor: latest.actor,
    createdAt: latest.createdAt,
    // Adoption adds no label and needs no pre-add check evidence. Release
    // captures its own watermark immediately before removing the label.
    checkRunWatermark: 0,
  };
  await writeCiState(pr, held);
  console.error(
    `ci-hold: adopted '${label}', added by ${latest.actor} at ${latest.createdAt}; the drive removes it at convergence`,
  );
  return held;
}

/** A live hold label is this drive's (`owned`), or becomes it (`adopted`). */
export async function confirmLiveHold(
  pr: string,
  head: string,
  persisted: CiHoldState | null,
  latest: LabelTransition | null,
  label: string,
): Promise<number> {
  if (ownsHeldTransition(persisted, latest)) {
    process.stdout.write(
      persisted?.phase === "held" && persisted.adopted === true
        ? "adopted\n"
        : "owned\n",
    );
    return 0;
  }
  if ((await adopt(pr, head, latest, label)) !== null) {
    process.stdout.write("adopted\n");
    return 0;
  }
  await writeCiState(pr, null);
  console.error(
    `ci-hold: '${label}' is present but the timeline does not show it being added yet; retrying later`,
  );
  return 4;
}
