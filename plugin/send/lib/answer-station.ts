/**
 * `answer <key> --approve|--choose <option>` to a need's decision other
 * than a drive's park (`shared/decisions/station.ts`): a follow-up's, a
 * pickup's, or the dispatcher's own framing of a stopped drive, a checkout
 * that holds a branch or a stuck launch record. The decision is read from
 * this machine's newest line (`dispatch/lib/line-store.ts`), as the
 * dashboard and `jig ask --waiting` read it, and the answer is the comment
 * a person could type by hand: `answer <key>: approve [<digest>]` or
 * `answer <key>: choose <option> [<digest>]`, with a `note <key>:` line
 * when `--note` gives one, on the need's pull request, or on its item where
 * the items are the forge's issues. The tick on the host that owns the
 * repository reads it (`dispatch/lib/station-answers.ts`) and carries out
 * the option once.
 *
 * Checked before the write: the line holds a need of this address whose
 * decision has this key; the answer is a structured form (the tick carries
 * out an option, not words); the option is one the decision offers; and the
 * send names the digest the person read (`--decision`, which `--dry-run`
 * prints), which must still be the decision's. An item on a tracker other
 * than the forge is refused: its answers are not read there yet.
 */
import { ok } from "../../shared/outcome.ts";
import { stationSendCommand } from "../../shared/decisions/station.ts";
import { localWriter } from "../../shared/records/writer.ts";
import { readLine } from "../../dispatch/lib/line-store.ts";
import type {
  LineDecision,
  LineNeed,
} from "../../dispatch/lib/dashboard-contract.ts";
import {
  answerComment,
  answerLine,
  postAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import { stationItem } from "../../dispatch/lib/station-answers.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import type { AnswerRequest } from "./answer-request.ts";
import { optionInFull, resolveChoice } from "./answer-choice.ts";
import { asFlag, type Sender, TICK } from "./answer-parks.ts";
import { type Planned, refused } from "./plan.ts";

type OneAnswer = Extract<AnswerRequest, { all: false }>;

/** The target a need of `ctx`'s address has on the line. */
function targetOf(ctx: AskContext): string {
  return ctx.address.station === "pickup"
    ? ctx.address.key
    : `PR #${ctx.address.key}`;
}

/** The repository and number the answer comment goes on: the pull request, or the forge issue the need links to. */
function postTarget(
  ctx: AskContext,
  need: LineNeed,
): { repo: string; number: number } | null {
  if (need.pr !== null) return { repo: ctx.address.repo, number: need.pr };
  const issue = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(
    need.url ?? "",
  );
  return issue === null
    ? null
    : { repo: issue[1] ?? "", number: Number(issue[2]) };
}

/** The needs of `ctx`'s address in this machine's newest line, or why there is no line to read. */
function lineNeeds(ctx: AskContext): LineNeed[] | string {
  const root = ctx.dispatcher;
  if (root === null)
    return "this machine never dispatched, so it has no line to read the need's decision from; answer on the host that dispatches the repository";
  const line = readLine(root);
  if (!line.ok)
    return `the decision cannot be read from this machine's line: ${line.failure.reason}`;
  if (line.value === null)
    return "the decision cannot be read from this machine's line: no tick has written one yet";
  const target = targetOf(ctx);
  return line.value.needs.filter(
    (n) => n.repo === ctx.address.repo && n.target === target,
  );
}

/**
 * The plan of an answer to a need's decision keyed `request.key`, or
 * `null` when a drive's address has no such need, so its parks answer it.
 */
export function planStationAnswer(
  ctx: AskContext,
  request: OneAnswer,
  sender: Sender,
): Planned | null {
  const drive = ctx.address.station === "drive";
  const needs = lineNeeds(ctx);
  if (typeof needs === "string") return drive ? null : refused(needs);
  const keyed = needs.flatMap((n) =>
    n.decisions
      .filter((d) => d.answer !== undefined)
      .map((d) => ({ need: n, decision: d })),
  );
  const found = keyed.find(
    (k) => k.decision.key.toLowerCase() === request.key.toLowerCase(),
  );
  if (found !== undefined)
    return planFound(ctx, request, sender, found.need, found.decision);
  if (drive) return null;
  const keys =
    keyed.length === 0
      ? ""
      : `; its keys are ${keyed.map((k) => k.decision.key).join(", ")}`;
  return refused(
    `${ctx.name} has no need waiting on a decision keyed ${request.key} in this machine's newest line${keys}`,
  );
}

/** Why the answer cannot be sent to `decision` as it stands; `null` when it can. */
function answerFault(
  request: OneAnswer,
  sender: Sender,
  need: LineNeed,
  decision: LineDecision,
): string | null {
  const { key } = request;
  if (decision.answer?.on === "tracker")
    return `${need.target}'s item is on a tracker other than the forge, where answers are not read yet; settle it on the tracker by hand`;
  const digest = decision.digest;
  if (digest === undefined)
    return `${key}'s decision has no digest to bind an answer to`;
  if (request.decision !== undefined && request.decision !== digest)
    return `--decision ${request.decision} is not the digest of ${key}'s decision now: its facts changed since you read it, and nothing is sent; run the dry run again and send the command it prints`;
  if (request.decision === undefined && !sender.dryRun)
    return "name the decision you read: run this with --dry-run, read the option it shows, then send the command it prints, which names the decision's digest with --decision";
  return null;
}

function planFound(
  ctx: AskContext,
  request: OneAnswer,
  sender: Sender,
  need: LineNeed,
  decision: LineDecision,
): Planned {
  const { key, form } = request;
  if (form.kind === "free")
    return refused(
      `the tick carries out an option of ${key}'s decision, not words: answer with --approve or --choose, after a --dry-run shows the options and the digest`,
    );
  const fault = answerFault(request, sender, need, decision);
  if (fault !== null) return refused(fault);
  const digest = decision.digest ?? "";
  const item = stationItem(decision);
  const resolved = resolveChoice(item, form, request.note, sender.login);
  if (!resolved.ok) return resolved;
  const { option, recommended, text, parts } = resolved.value;
  const posted = postTarget(ctx, need);
  if (posted === null)
    return refused(
      `${need.target} links to no pull request or forge issue to answer on`,
    );
  const lines = [
    answerLine(key, text),
    ...(parts.note === undefined ? [] : [`note ${key}: ${parts.note}`]),
  ];
  const command = `${stationSendCommand(
    { address: ctx.name },
    key,
    form.kind === "approve"
      ? { form: "approve" }
      : { form: "choose", option: option.name },
    digest,
    request.note,
  )}${asFlag(sender)}`;
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: "answer",
    writesAs: sender.writesAs,
    record: `a comment on ${posted.repo}#${posted.number}: ${lines.map((l) => `"${l}"`).join(" and ")}, with the record envelope naming ${sender.login} and this host (as a digest), the decision's digest and the option chosen in a hidden marker`,
    where: need.url ?? `${posted.repo}#${posted.number}`,
    reader: `the dispatcher's next tick on the host that owns ${ctx.address.repo}, which carries out the option once, after checking again that it still may`,
    tick: TICK,
    undo: "until the tick acts on it, delete the comment, or answer again: your latest answer is the one that counts; once the tick has acted, its step stands",
    notice:
      "the tick acts only on an answer that names the decision's digest, by a person the forge vouches for, and only when every person's latest answer chooses the same option",
    detail: [
      ["decision", digest],
      ["option", optionInFull(option, recommended)],
      ...(sender.dryRun
        ? ([["send", command]] as Array<[string, string]>)
        : []),
    ],
    write: async () => {
      const body = answerComment(
        key,
        text,
        posted.number,
        localWriter("forge", sender.login),
        new Date().toISOString(),
        parts,
      );
      const written = await postAnswerComment(posted.repo, posted.number, body);
      return written.ok ? ok(written.value ?? need.url ?? "") : written;
    },
  });
}
