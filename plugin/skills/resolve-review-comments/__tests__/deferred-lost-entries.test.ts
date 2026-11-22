/**
 * Deferral without a tracker: a deferred reply whose entry the body lost is
 * named, by thread or by summary-finding fingerprint.
 */
import { describe, expect, test } from "bun:test";
import { missingEntries } from "../scripts/file-deferred.ts";
import { withDeferredEntry } from "../scripts/lib/deferred-section.ts";
import type { AnswerComment } from "../scripts/lib/pr-body.ts";
import { fakeForge, PR_URL } from "./deferred-forge.ts";

const THREAD = `${PR_URL}#discussion_r1001`;
const FINDING =
  "The retry budget is read without validation.\n\nIt can go negative.";

describe("a deferred reply whose entry the body lost", () => {
  test("is named, and an entry still there is not", async () => {
    const other = `${PR_URL}#discussion_r2002`;
    const forge = fakeForge(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    );
    forge.answered = [
      threadReply(THREAD, `${THREAD}-reply`),
      threadReply(other, `${other}-reply`),
    ];
    expect(await missingEntries(forge, "42")).toEqual([
      { thread: other, reply: `${other}-reply` },
    ]);
  });

  test("a summary finding's lost entry is named by its fingerprint, beside a sibling still there", async () => {
    const comment = `${PR_URL}#issuecomment-77`;
    const forge = fakeForge(
      withDeferredEntry("", {
        source: comment,
        fingerprint: "fp-a",
        finding: "first",
        reason: "r",
      }).body,
    );
    forge.answered = [
      summaryAnswer(`${PR_URL}#issuecomment-90`, ["fp-a", "fp-b"]),
    ];
    expect(await missingEntries(forge, "42")).toEqual([
      { fingerprint: "fp-b", reply: `${PR_URL}#issuecomment-90` },
    ]);
  });

  test("an answer from an author the forge does not vouch for obliges nothing", async () => {
    const forge = fakeForge("");
    forge.answered = [
      threadReply(THREAD, `${THREAD}-reply`, "NONE"),
      summaryAnswer(`${PR_URL}#issuecomment-90`, ["fp-a"], "CONTRIBUTOR"),
    ];
    expect(await missingEntries(forge, "42")).toEqual([]);
  });

  test("only a link to this pull request's own section counts", async () => {
    const forge = fakeForge("");
    const elsewhere = [
      "https://github.com/example/project/issues/7#deferred",
      `${PR_URL}0#deferred`,
      `${PR_URL}#deferred-later`,
      `https://example.com/?u=${PR_URL}#deferred`,
    ];
    forge.answered = elsewhere.map((link, n) => ({
      thread: `${PR_URL}#discussion_r${n}`,
      url: `${PR_URL}#discussion_r${n}-reply`,
      body: `**deferred** — tracked in ${link}`,
      association: "MEMBER",
    }));
    expect(await missingEntries(forge, "42")).toEqual([]);
    forge.answered.push(threadReply(THREAD, `${THREAD}-reply`));
    expect(await missingEntries(forge, "42")).toEqual([
      { thread: THREAD, reply: `${THREAD}-reply` },
    ]);
  });

  test("a reply that does not open with **deferred** obliges nothing", async () => {
    const forge = fakeForge("");
    forge.answered = [
      {
        ...threadReply(THREAD, `${THREAD}-reply`),
        body: `**wont-fix** — see [the section](${PR_URL}#deferred).`,
      },
    ];
    expect(await missingEntries(forge, "42")).toEqual([]);
  });
});

/** A `**deferred**` reply on a resolved thread, as defer-in-pr links it. */
function threadReply(
  thread: string,
  url: string,
  association = "MEMBER",
): AnswerComment {
  return {
    thread,
    url,
    body: `**deferred** — recorded in [the Deferred section](${PR_URL}#deferred).`,
    association,
  };
}

/** A summary finding's `**deferred**` answer, as answer-summary-finding writes it. */
function summaryAnswer(
  url: string,
  fingerprints: string[],
  association = "OWNER",
): AnswerComment {
  return {
    url,
    body: [
      `**deferred** — recorded in ${PR_URL}#deferred`,
      ...fingerprints.map((fp) => `<!-- drive-pr-addressed: ${fp} -->`),
    ].join("\n"),
    association,
  };
}
