/**
 * `jig ask <address>`: who holds a station of the line, its state, what it
 * waits on and how its last launch ended, from the records alone
 * (`design/addresses.md`). `--thread` adds the address's correspondence,
 * `--json` prints the answer as one object, and `--waiting` lists every
 * address that waits on a person from the newest tick's line.
 *
 * It only reads: it writes no record, starts no session and changes nothing
 * on the forge or the tracker. Its forge reads are conditional requests,
 * whose answers the forge cache under `~/.cache/jig/gh-cache/` keeps, as it
 * does for every drive. It exits `0` when it answered, also when nobody
 * holds the address; `1` when the key names nothing; `2` on a malformed
 * address, an unknown station or another usage error.
 */
import { ExitError } from "../shared/cli.ts";
import { layeredConfig } from "../shared/consumer.ts";
import { attempt } from "../shared/outcome.ts";
import {
  argument,
  type InferValue,
  message,
  object,
  option,
  optional,
  string,
  command,
} from "../shared/vendor/optique.mjs";
import { dateValue } from "../shared/command-line.ts";
import { dispatchSection } from "../dispatch/lib/section.ts";
import {
  type Address,
  checkKey,
  formatAddress,
  parseAddress,
  resolveRepository,
  stationList,
} from "../shared/address.ts";
import { type AskAnswer, ANSWER_VERSION, ASK_EXIT } from "./lib/answer.ts";
import { askDrive } from "./lib/drive.ts";
import { readLogin } from "./lib/forge.ts";
import { askFollowup } from "./lib/followup.ts";
import {
  checkoutOf,
  dispatcherRoot,
  machineFile,
  ourHost,
  repositoryChoices,
} from "./lib/local.ts";
import { askPickup, type RepoTracker, trackerAt } from "./lib/pickup.ts";
import { type Reading, reading } from "./lib/reading.ts";
import { renderAnswer, renderWaiting } from "./lib/render.ts";
import type { AskContext, StationAnswer } from "./lib/station.ts";
import { windowed } from "./lib/thread.ts";
import { PERSON_REFUSED, waitingAnswer } from "./lib/waiting.ts";

export const askCommand = command(
  "ask",
  object({
    address: optional(
      argument(string({ metavar: "ADDRESS" }), {
        description: message`station@owner/name#key, such as drive@jig-harness/jig#456. The stations are pickup, drive and followup; the repository may be its short name where the dispatch file lists one of that name, or left out inside its checkout.`,
      }),
    ),
    key: optional(
      argument(string({ metavar: "KEY" }), {
        description: message`The key, where the address leaves it out: drive@jig 456.`,
      }),
    ),
    json: option("--json", {
      description: message`Print the answer as one JSON object.`,
    }),
    thread: option("--thread", {
      description: message`Add the address's correspondence: requests, questions, answers, launches and outcomes, the newest first cut to a window.`,
    }),
    since: optional(
      option("--since", dateValue, {
        description: message`With the thread, every entry from this date on.`,
      }),
    ),
    all: option("--all", {
      description: message`With the thread, every entry.`,
    }),
    waiting: option("--waiting", {
      description: message`List every address that waits on a person, from the newest tick's line; no forge or tracker call.`,
    }),
    person: optional(
      option("--person", string({ metavar: "LOGIN" }), {
        description: message`With --waiting, the entries that name this person; refused until parks record whom they wait on.`,
      }),
    ),
  }),
  {
    brief: message`Ask a station of the line where it stands: who holds it, its state, what it waits on and its last outcome.`,
    description: message`Reads the records the station leaves (the drive ledger, the launch claims and follow-up markers on the pull request, the tracker claim, and on this machine the launch records, the outcome log and the drive's own listing) and prints one answer. It writes nothing.`,
  },
);

export type AskArguments = InferValue<typeof askCommand>;

function usage(reason: string): never {
  throw new ExitError(ASK_EXIT.USAGE, `jig ask: ${reason}`);
}

function print(text: string): void {
  console.log(text);
}

/** `--waiting`. */
function waitingMain(args: AskArguments): number {
  if (args.address !== undefined)
    usage("--waiting lists every address; it takes none");
  if (args.person !== undefined) usage(PERSON_REFUSED);
  const answer = waitingAnswer(dispatcherRoot());
  print(args.json ? JSON.stringify(answer, null, 2) : renderWaiting(answer));
  return ASK_EXIT.ANSWERED;
}

/** The dispatch labels' prefix the repository's configuration in its checkout here names; `null` where there is no checkout or its configuration does not read. */
function labelPrefixAt(checkout: string | null): string | null {
  if (checkout === null) return null;
  const section = attempt("unreadable", "", () =>
    dispatchSection(layeredConfig(checkout).values),
  );
  return section.ok ? section.value.labels.prefix : null;
}

/**
 * An address as written, resolved in full and its key checked, with what
 * resolving it read; every refusal goes to `refuse`, a usage error. `jig
 * send` resolves its address the same way.
 */
export function resolveAddress(
  text: string | undefined,
  second: string | undefined,
  refuse: (reason: string) => never,
) {
  if (text === undefined)
    refuse(
      `name an address, station@owner/name#key; the stations are ${stationList()}`,
    );
  const written = parseAddress(text, second);
  if (!written.ok) refuse(written.failure.reason);
  const machine = machineFile();
  const choices = repositoryChoices(machine.ok ? machine.value : null);
  const repo = resolveRepository(written.value.repo, choices);
  if (!repo.ok) refuse(repo.failure.reason);
  const checkout = checkoutOf(repo.value, choices);
  const { station } = written.value;
  const tracker =
    station === "pickup" ? trackerOf(repo.value, checkout, refuse) : null;
  const key = checkKey(station, written.value.key, tracker?.keys ?? null);
  if (!key.ok) refuse(key.failure.reason);
  const address: Address = { station, repo: repo.value, key: key.value };
  return { address, machine, choices, checkout, tracker };
}

export type ResolvedAddress = ReturnType<typeof resolveAddress>;

/** What a station's readers read with, for an address resolved here. */
export function contextFor(
  found: ResolvedAddress,
  r: Reading,
  login: string | null,
  view: Pick<AskContext, "thread" | "window"> = {
    thread: false,
    window: { since: null, all: false },
  },
): AskContext {
  const { address, choices, checkout } = found;
  const dispatcher = dispatcherRoot();
  return {
    reading: r,
    address,
    name: formatAddress(address),
    ...view,
    login,
    dispatcher,
    host: dispatcher === null ? null : ourHost(dispatcher),
    checkout,
    dispatches: choices.known.some((k) => k.slug === address.repo),
    labelPrefix: labelPrefixAt(checkout),
  };
}

/** A pick-up's tracker, from a checkout of its repository here; a usage error where there is none. */
function trackerOf(
  repo: string,
  checkout: string | null,
  usage: (reason: string) => never,
): RepoTracker {
  if (checkout === null)
    usage(
      `no checkout of ${repo} on this machine names its tracker, so the item key cannot be checked or read; run it in a checkout of the repository, or one the dispatch file lists`,
    );
  const tracker = trackerAt(checkout);
  if (!tracker.ok) usage(tracker.failure.reason);
  return tracker.value;
}

/** The login the forge client is signed in as, for every station but a pick-up, which makes no forge call. */
async function loginFor(r: Reading, address: Address): Promise<string | null> {
  if (address.station === "pickup") return null;
  const login = await readLogin(r);
  r.note(
    login === null
      ? {
          record: "forge-login",
          read: false,
          detail:
            "the forge did not name its login; only authors it vouches for are trusted",
        }
      : { record: "forge-login", read: true },
  );
  return login;
}

/** The answer as `--json` prints it, with the thread cut to its window. */
function answerOf(found: StationAnswer, ctx: AskContext): AskAnswer {
  const { address } = ctx;
  const answer: AskAnswer = {
    v: ANSWER_VERSION,
    address: ctx.name,
    station: address.station,
    repo: address.repo,
    key: address.key,
    title: found.title,
    url: found.url,
    holder: found.holder,
    state: found.state,
    stateDetail: found.stateDetail,
    waitsOn: found.waitsOn,
    last: found.last,
    sources: ctx.reading.sources(),
  };
  if (!ctx.thread) return answer;
  const cut = windowed(found.entries, ctx.window);
  return { ...answer, thread: cut.entries, threadOmitted: cut.omitted };
}

export async function askMain(args: AskArguments): Promise<number> {
  if (args.waiting) return waitingMain(args);
  if (args.person !== undefined) usage("--person goes with --waiting");
  const resolved = resolveAddress(args.address, args.key, usage);
  const { address, machine, tracker } = resolved;
  const r = reading();
  if (!machine.ok)
    r.note({
      record: "dispatch-file",
      read: false,
      local: true,
      detail: machine.failure.reason,
    });
  const ctx = contextFor(resolved, r, await loginFor(r, address), {
    thread: args.thread || args.all || args.since !== undefined,
    window: { since: args.since ?? null, all: args.all },
  });
  const found =
    tracker !== null
      ? await askPickup(ctx, tracker)
      : address.station === "drive"
        ? await askDrive(ctx)
        : await askFollowup(ctx);
  const answer = answerOf(found, ctx);
  print(args.json ? JSON.stringify(answer, null, 2) : renderAnswer(answer));
  return found.found ? ASK_EXIT.ANSWERED : ASK_EXIT.NOTHING;
}
