/**
 * `answer --all --approve`: approve the recommendation of every eligible
 * parked item of a pull request at once, one comment per item, each written
 * as `answer <key>` with `--approve` would write it (`answer-choice.ts`).
 *
 * Eligible is an open item (no answer the readers count, and none disputed)
 * whose class the shared acts table (`shared/acts.ts`) lists as Decide by
 * name, with a framed decision that recommends an option and a decision
 * digest. Left out, and named with why: an answered or disputed item; a
 * class whose act is Authorize (or Merge, or Reply); a class the table does
 * not list, a repository's own, which reads Decide only as a fallback; an
 * item with no framed decision or no recommendation; and a park from before
 * digests, which no set token can bind. Each of those is approved only by
 * its own key.
 *
 * Binding: the dry run lists each eligible item with its digest and prints
 * one set token, the first 12 hexadecimal characters of the SHA-256 of the
 * sorted `<key> <digest>` lines. The real send must name it
 * (`--decision-set`); it reads the items again and refuses, writing
 * nothing, when the token it computes differs, so an item added or framed
 * again since the dry run is never approved unseen.
 */
import { createHash } from "node:crypto";
import { failed, ok } from "../../shared/outcome.ts";
import { listedActOfClass } from "../../shared/acts.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  answerComment,
  answerLine,
  postAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-comment.ts";
import { answerDecision } from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { type Resolved, resolveChoice } from "./answer-choice.ts";
import {
  ANSWER_READER,
  type ReadParks,
  READABLE_NOTICE,
  readParks,
  TICK,
} from "./answer-parks.ts";
import { type Planned, refused } from "./plan.ts";

interface Eligible {
  item: ParkedItem;
  digest: string;
  resolved: Resolved;
}

/** The set token of `eligible`: what the person saw, as one value to name. */
function decisionSetToken(
  eligible: ReadonlyArray<{ key: string; digest: string }>,
): string {
  const lines = eligible.map((e) => `${e.key} ${e.digest}`).sort();
  return createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 12);
}

const classOf = (item: ParkedItem) =>
  item.class ?? answerDecision(item)?.class ?? null;

/** Why `item` is left out of `--all --approve`, or what it approves. */
function eligibility(
  item: ParkedItem,
  found: ReadParks,
  login: string,
): string | Eligible {
  if (found.answered.some((v) => v.key === item.key))
    return "already answered; answer it by its key to change your answer";
  if (found.disputed.some((v) => v.item.key === item.key))
    return "its answers are disputed; answer it by its key";
  const cls = classOf(item);
  const act = listedActOfClass(cls);
  if (act === undefined)
    return `the acts table does not list ${cls === null ? "a park with no class" : `class ${cls}`} as Decide by name, so it is approved only by its own key`;
  if (act !== "Decide")
    return `its class asks a person to ${act}, so it is approved only by its own key`;
  if (item.digest === undefined)
    return "it has no decision digest (it was parked before digests), so no set token can bind it; approve it by its own key";
  const resolved = resolveChoice(item, { kind: "approve" }, undefined, login);
  if (!resolved.ok) return resolved.failure.reason;
  return { item, digest: item.digest, resolved: resolved.value };
}

/** The plan of approving every eligible item, or why it is not sent. */
export async function planAnswerAll(
  ctx: AskContext,
  decisionSet: string | undefined,
  login: string,
  writesAs: string,
  dryRun: boolean,
): Promise<Planned> {
  const read = await readParks(ctx);
  if (!read.ok) return read;
  const { pr, doc, ledger, found } = read.value;
  const eligible: Eligible[] = [];
  const leftOut: string[] = [];
  for (const item of ledger.parked) {
    const e = eligibility(item, found, login);
    if (typeof e === "string")
      leftOut.push(`${item.key} (${classOf(item) ?? "no class"}): ${e}`);
    else eligible.push(e);
  }
  if (eligible.length === 0)
    return refused(
      `no parked item of pull request ${pr} can be approved with --all${
        leftOut.length === 0 ? "; it has none" : `: ${leftOut.join("; ")}`
      }`,
    );
  const token = decisionSetToken(
    eligible.map((e) => ({ key: e.item.key, digest: e.digest })),
  );
  if (decisionSet !== undefined && decisionSet !== token)
    return refused(
      `the eligible items or a decision digest changed since the dry run that printed --decision-set ${decisionSet}, and nothing is sent; run the dry run again and read what it lists`,
    );
  if (decisionSet === undefined && !dryRun)
    return refused(
      "name the set you read: run this with --dry-run, read each item it lists, then send the command it prints, which names the set with --decision-set",
    );
  const lines = eligible.map((e) => answerLine(e.item.key, e.resolved.text));
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: "answer",
    writesAs,
    record: `${eligible.length === 1 ? "a comment" : "one comment per item"} on pull request ${pr}: ${lines.map((l) => `"${l}"`).join(", ")}, ${eligible.length === 1 ? "with" : "each with"} the record envelope naming ${login} and this host (as a digest), the decision's digest and the option chosen in a hidden marker`,
    where: doc.url,
    reader: ANSWER_READER,
    tick: TICK,
    undo: "none once the re-arm has read them; until then, delete a comment, or answer that item again by its key: your latest answer is the one that counts",
    notice: `${READABLE_NOTICE}; each approves the option the item's decision recommends, as your verdict on it`,
    detail: [
      [
        "approves",
        eligible
          .map(
            (e) =>
              `${e.item.key} (${classOf(e.item)}) [${e.digest}]: ${e.resolved.option.name}: ${e.resolved.option.summary}`,
          )
          .join("\n"),
      ],
      ...(leftOut.length === 0
        ? []
        : [["left out", leftOut.join("\n")] as [string, string]]),
      ["set", token],
      ...(dryRun
        ? [
            [
              "send",
              `jig send ${ctx.name} answer --all --approve --decision-set ${token}`,
            ] as [string, string],
          ]
        : []),
    ],
    write: async () => {
      const links: string[] = [];
      for (const e of eligible) {
        const body = answerComment(
          e.item.key,
          e.resolved.text,
          pr,
          localWriter("forge", login),
          new Date().toISOString(),
          e.resolved.parts,
        );
        const posted = await postAnswerComment(ctx.address.repo, pr, body);
        if (!posted.ok)
          return failed(
            "refused",
            `${links.length === 0 ? "nothing was posted" : `posted ${links.length} of ${eligible.length} (${links.join(", ")})`}, then ${e.item.key}: ${posted.failure.reason}`,
          );
        links.push(posted.value ?? doc.url);
      }
      return ok(links.join("\n"));
    },
  });
}
