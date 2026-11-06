/**
 * `jig send <address> <verb> [arguments]`: write one record of a kind the
 * line already reads, and exit (`design/addresses.md`). It types nothing
 * into a session and starts nothing itself; the record's reader acts on it
 * at its next run. The verbs are a closed list (`lib/verbs.ts`), and each
 * record is written by the writer of the component that owns it.
 *
 * Before it writes, `send` reads the address through `jig ask`'s readers
 * and refuses a request the station cannot take, then prints the
 * repository in full, the login it writes as, the record, its reader and
 * how to take it back. `--dry-run` stops there. `--as <login>` refuses when
 * the machine is signed in as someone else. A machine whose dispatch file
 * says `send: false` refuses every send, and a session the line started
 * (`JIG_LAUNCH` set) is refused the verbs that are a person's.
 *
 * It exits `0` when it sent (or, with `--dry-run`, would send), `1` when it
 * refused or the write failed, and `2` on a usage error: a malformed
 * address, an unknown station or verb, a verb the station does not take,
 * or an answer's text that is not one line within its limit.
 */
import { ExitError } from "../shared/cli.ts";
import { parseAddress } from "../shared/address.ts";
import { launchOf, LAUNCH_VARIABLE } from "../shared/launched-session.ts";
import {
  argument,
  command,
  type InferValue,
  message,
  multiple,
  object,
  option,
  optional,
  string,
} from "../shared/vendor/optique.mjs";
import {
  contextFor,
  type ResolvedAddress,
  resolveAddress,
} from "../ask/cli.ts";
import { readLogin } from "../ask/lib/forge.ts";
import { machineFile } from "../ask/lib/local.ts";
import { reading } from "../ask/lib/reading.ts";
import { planAnswer } from "./lib/answer.ts";
import { planAssign } from "./lib/assign.ts";
import { planLabel } from "./lib/labels.ts";
import { planMailbox } from "./lib/mailbox.ts";
import {
  type Planned,
  refused,
  renderPlan,
  renderSent,
  writerLogin,
} from "./lib/plan.ts";
import {
  isPersonVerb,
  isVerb,
  parseRequest,
  type Request,
} from "./lib/verbs.ts";

/** How `send` exits: sent, refused or failed, a usage error. */
const SEND_EXIT = { SENT: 0, REFUSED: 1, USAGE: 2 } as const;

export const sendCommand = command(
  "send",
  object({
    words: multiple(
      argument(string({ metavar: "WORD" }), {
        description: message`The address (station@owner/name#key, or the address and its key as two words: drive@jig 456), then the verb and its arguments. The verbs: assign (pickup); drive, answer <key> <text>, pause, resume <hold-push|pause|stop>, stop, hold-push (drive); hold, release (drive, followup).`,
      }),
    ),
    dryRun: option("--dry-run", {
      description: message`Print what the send would write, and write nothing.`,
    }),
    as: optional(
      option("--as", string({ metavar: "LOGIN" }), {
        description: message`Refuse unless this machine writes as LOGIN: the forge login, or for assign the tracker's user.`,
      }),
    ),
  }),
  {
    brief: message`Tell a station of the line what to do: write the one record its reader acts on.`,
    description: message`Checks the request against the station's records first, as jig ask reads them, prints the repository, the login it writes as, the record and its reader, then writes the record: a tracker assignment, a dispatch label, an answer comment, or a directive in a drive's mailbox on this machine.`,
  },
);

export type SendArguments = InferValue<typeof sendCommand>;

function usage(reason: string): never {
  throw new ExitError(SEND_EXIT.USAGE, `jig send: ${reason}`);
}

function refusal(reason: string): number {
  console.error(`jig send: refused: ${reason}`);
  return SEND_EXIT.REFUSED;
}

/** What this machine and this session allow before anything is read: `null` when both allow the request. */
function standing(request: Request): string | null {
  const machine = machineFile();
  if (!machine.ok)
    return `the dispatch file does not read, so whether this machine allows jig send is not known: ${machine.failure.reason}`;
  if (machine.value?.send === false)
    return `this machine refuses every send: send: false in its dispatch file (${machine.value.path})`;
  const launch = launchOf();
  if (launch !== null && isPersonVerb(request.verb))
    return `${request.verb} is a person's command, and this session was started by the line (${LAUNCH_VARIABLE}=${launch}); a person sends it from their own session`;
  return null;
}

/** The plan of `request` to the resolved address, or why it is refused. */
async function planFor(
  resolved: ResolvedAddress,
  request: Request,
  as: string | undefined,
): Promise<Planned> {
  const r = reading();
  if (request.verb === "assign") {
    const ctx = contextFor(resolved, r, null);
    return resolved.tracker === null
      ? refused("the repository's tracker is not known here")
      : planAssign(ctx, resolved.tracker, as);
  }
  const login = writerLogin(await readLogin(r), as, "the forge");
  if (!login.ok) return login;
  const ctx = contextFor(resolved, r, login.value);
  const writesAs = `${login.value}, the login the forge client here is signed in as`;
  switch (request.verb) {
    case "drive":
    case "hold":
    case "release":
      return planLabel(ctx, request.verb, writesAs);
    case "answer":
      return planAnswer(ctx, request.key, request.text, login.value, writesAs);
    default:
      return planMailbox(ctx, request, login.value, writesAs);
  }
}

export async function sendMain(args: SendArguments): Promise<number> {
  const [text, ...rest] = args.words;
  if (text === undefined)
    usage("name an address and a verb: jig send station@owner/name#key <verb>");
  // Without an inline key, the word after the address is its key, unless it is the verb.
  const second =
    text.includes("#") || isVerb(rest[0]) ? undefined : rest.shift();
  const written = parseAddress(text, second);
  if (!written.ok) usage(written.failure.reason);
  const request = parseRequest(written.value.station, rest, usage);
  const refusedHere = standing(request);
  if (refusedHere !== null) return refusal(refusedHere);
  const resolved = resolveAddress(text, second, usage);
  const planned = await planFor(resolved, request, args.as);
  if (!planned.ok) return refusal(planned.failure.reason);
  const plan = planned.value;
  console.log(renderPlan(plan, args.dryRun));
  if (args.dryRun) return SEND_EXIT.SENT;
  const wrote = await plan.write();
  if (!wrote.ok) {
    console.error(`jig send: not sent: ${wrote.failure.reason}`);
    return SEND_EXIT.REFUSED;
  }
  console.log(renderSent(plan, wrote.value));
  return SEND_EXIT.SENT;
}
