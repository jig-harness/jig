/**
 * Deferral without a tracker: a finding recorded in the pull request's
 * `## Deferred` section by read-modify-write against the body's `updated_at`,
 * so a person's edit survives, and `file-deferred.ts` filing each entry
 * through a tracker adapter (the GitHub adapter over a fake transport) and
 * replacing it with its issue.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
  repoLabels,
} from "../../do-item/__tests__/github-fixtures.ts";
import { deferInPr, deferralRoute } from "../scripts/defer-in-pr.ts";
import {
  fileDeferred,
  identityLine,
  missingEntries,
  textLine,
} from "../scripts/file-deferred.ts";
import {
  deferredEntries,
  SECTION_END,
  SECTION_START,
  withDeferredEntry,
  withFiledEntry,
} from "../scripts/lib/deferred-section.ts";
import type {
  AnswerComment,
  PrBody,
  PrBodyForge,
} from "../scripts/lib/pr-body.ts";

const PR_URL = "https://github.com/example/project/pull/42";
const THREAD = `${PR_URL}#discussion_r1001`;
const FINDING =
  "The retry budget is read without validation.\n\nIt can go negative.";

/** A pull request body in memory, with a hook that runs before each read. */
function fakeForge(initial: string): PrBodyForge & {
  state: PrBody;
  beforeRead: Array<(s: PrBody) => void>;
  writes: number;
  answered: AnswerComment[];
  failWrites: boolean;
} {
  let clock = 0;
  const state: PrBody = {
    body: initial,
    updatedAt: "2026-10-29T00:00:00Z",
    url: PR_URL,
  };
  const forge = {
    state,
    beforeRead: [] as Array<(s: PrBody) => void>,
    writes: 0,
    answered: [] as AnswerComment[],
    failWrites: false,
    async answers() {
      return forge.answered;
    },
    async read() {
      forge.beforeRead.shift()?.(state);
      return { ...state };
    },
    async write(_pr: string, body: string) {
      if (forge.failWrites) throw new Error("the forge refused the write");
      forge.writes += 1;
      state.body = body;
      state.updatedAt = `2026-10-29T00:00:0${++clock}Z`;
    },
  };
  return forge;
}

describe("the deferred section", () => {
  test("is created at the end of the body and read back", () => {
    const { body, added } = withDeferredEntry("## Summary\n\nWhat changed.", {
      source: THREAD,
      finding: FINDING,
      reason: "it needs the configuration rework first",
    });
    expect(added).toBe(true);
    expect(body).toStartWith("## Summary\n\nWhat changed.\n\n## Deferred");
    expect(body).toContain(SECTION_START);
    expect(body).toContain(SECTION_END);
    expect(body).toContain("> The retry budget is read without validation.");
    const [entry] = deferredEntries(body);
    expect(entry?.source).toBe(THREAD);
    expect(entry?.filed).toBeUndefined();
    expect(entry?.text).toContain("it needs the configuration rework first");
  });

  test("does not add the same finding twice", () => {
    const once = withDeferredEntry("", {
      source: THREAD,
      finding: FINDING,
      reason: "later",
    }).body;
    expect(
      withDeferredEntry(once, {
        source: THREAD,
        finding: FINDING,
        reason: "later",
      }).added,
    ).toBe(false);
  });

  test("keys a summary finding on its comment and fingerprint", () => {
    const comment = `${PR_URL}#issuecomment-77`;
    let body = withDeferredEntry("", {
      source: comment,
      fingerprint: "fp-a",
      finding: "first",
      reason: "later",
    }).body;
    body = withDeferredEntry(body, {
      source: comment,
      fingerprint: "fp-b",
      finding: "second",
      reason: "later",
    }).body;
    expect(deferredEntries(body).map((e) => e.fingerprint)).toEqual([
      "fp-a",
      "fp-b",
    ]);
  });

  test("a finding or reason carrying the section's own markers closes nothing", () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: `Quoted:\n${SECTION_END}\n<!-- /deferred-entry -->\n<!-- deferred-entry: ${other} -->`,
      reason: `see ${SECTION_END}`,
    }).body;
    body = withDeferredEntry(body, {
      source: other,
      finding: "second",
      reason: "later",
    }).body;
    expect(deferredEntries(body).map((e) => e.source)).toEqual([THREAD, other]);
    const filed = withFiledEntry(
      body,
      { source: THREAD },
      { key: "#7", url: null },
    );
    expect(deferredEntries(filed).map((e) => e.source)).toEqual([
      THREAD,
      other,
    ]);
  });

  test("an entry that loses its closing marker is refused, not merged into the next", () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: "first",
      reason: "later",
    }).body;
    body = withDeferredEntry(body, {
      source: other,
      finding: "second",
      reason: "later",
    }).body;
    const broken = body.replace("<!-- /deferred-entry -->", "");
    expect(() => deferredEntries(broken)).toThrow(/opens another/);
    expect(() =>
      withFiledEntry(broken, { source: THREAD }, { key: "#7", url: null }),
    ).toThrow(/opens another/);
    const last =
      body.slice(0, body.lastIndexOf("<!-- /deferred-entry -->")) +
      body.slice(body.lastIndexOf("<!-- /deferred-entry -->") + 24);
    expect(() => deferredEntries(last)).toThrow(/never ends/);
  });
});

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

describe("written by read-modify-write against updated_at", () => {
  test("a person's edit within the same second, updated_at unchanged, survives", async () => {
    const forge = fakeForge("## Summary\n\nWhat changed.");
    forge.beforeRead.push(
      (s) => void s,
      (s) => {
        s.body = "## Summary\n\nEdited within the same second.";
      },
    );
    const r = await deferInPr(forge, {
      pr: "42",
      source: THREAD,
      reason: "later",
      finding: FINDING,
    });
    expect(r.added).toBe(true);
    expect(forge.state.body).toContain("Edited within the same second.");
    expect(deferredEntries(forge.state.body)).toHaveLength(1);
  });

  test("a person's edit between the reads survives, and the entry lands", async () => {
    const forge = fakeForge("## Summary\n\nWhat changed.");
    // The second read (just before the write) finds a person's edit.
    forge.beforeRead.push(
      (s) => void s,
      (s) => {
        s.body = "## Summary\n\nWhat changed, and why, edited by a person.";
        s.updatedAt = "2026-10-29T00:00:30Z";
      },
    );
    const r = await deferInPr(forge, {
      pr: "42",
      source: THREAD,
      reason: "it needs the configuration rework first",
      finding: FINDING,
    });
    expect(r.added).toBe(true);
    expect(r.link).toBe(`${PR_URL}#deferred`);
    expect(forge.writes).toBe(1);
    expect(forge.state.body).toContain("edited by a person");
    expect(deferredEntries(forge.state.body)).toHaveLength(1);
  });

  test("a re-run after the entry landed writes nothing", async () => {
    const forge = fakeForge("");
    const args = {
      pr: "42",
      source: THREAD,
      reason: "later",
      finding: FINDING,
    };
    await deferInPr(forge, args);
    const again = await deferInPr(forge, args);
    expect(again.added).toBe(false);
    expect(forge.writes).toBe(1);
  });
});

describe("file-deferred.ts files each entry through the tracker", () => {
  function trackerThatFiles(
    existing: Array<{ number: number; body: string }> = [],
  ) {
    let next = 40;
    return gitHub((c) => {
      if (c.op === "TrackerSearch")
        return {
          search: {
            issueCount: existing.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: existing.map((e) => issueNode(e)),
          },
        };
      if (c.op === "TrackerIssue") {
        const n = Number(String(c.variables.number ?? "").replace("#", ""));
        const hit = existing.find((e) => e.number === n) ?? existing[0];
        return oneIssue(
          hit === undefined
            ? null
            : issueNode({ ...hit, extra: { subIssues: conn([]) } }),
        );
      }
      if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
      if (c.op === "TrackerLabels") return repoLabels("pr-followup");
      if (c.op === "TrackerCreate") {
        next += 1;
        return {
          createIssue: {
            issue: {
              number: next,
              url: `https://github.com/acme/app/issues/${next}`,
            },
          },
        };
      }
      throw new Error(`unexpected ${c.op}`);
    });
  }

  test("replaces each entry with its issue, leaving the rest of the body", async () => {
    let body = "## Summary\n\nWhat changed.";
    for (const n of [1, 2])
      body = withDeferredEntry(body, {
        source: `${PR_URL}#discussion_r${n}`,
        finding: `Finding ${n} is real.`,
        reason: `reason ${n}`,
      }).body;
    const forge = fakeForge(body);
    const { t, calls } = trackerThatFiles();
    const r = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(r.filed.map((f) => f.key)).toEqual(["#41", "#42"]);
    expect(r.remaining).toEqual([]);
    const entries = deferredEntries(forge.state.body);
    expect(entries.map((e) => e.filed?.key)).toEqual(["#41", "#42"]);
    expect(forge.state.body).toStartWith("## Summary\n\nWhat changed.");
    expect(forge.state.body).toContain(
      "filed as [#41](https://github.com/acme/app/issues/41)",
    );
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(created).toHaveLength(2);
    const input = created[0]?.variables.input as {
      title: string;
      body: string;
    };
    expect(input.title).toBe("Deferred from PR #42: Finding 1 is real.");
    expect(input.body).toContain("Filed by `file-deferred.ts`");
    expect(input.body).toContain("reason 1");
  });

  test("a second run files nothing more", async () => {
    const forge = fakeForge(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    );
    await fileDeferred(forge, trackerThatFiles().t, "42", {
      label: "pr-followup",
    });
    const { t, calls } = trackerThatFiles();
    const again = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(again.filed).toEqual([]);
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
  });

  test("an issue an earlier run filed for the entry is reused, not filed twice", async () => {
    const forge = fakeForge(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    );
    const [entry] = deferredEntries(forge.state.body);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `Filed by file-deferred.ts.\n\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(r.why).toBeNull();
    expect(r.filed).toEqual([
      expect.objectContaining({ key: "#7", reused: true }),
    ]);
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
    expect(deferredEntries(forge.state.body)[0]?.filed?.key).toBe("#7");
  });

  test("an issue filed from an earlier text of a corrected entry does not replace the correction", async () => {
    const original = withDeferredEntry("", {
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    const [before] = deferredEntries(original);
    const corrected = original.replace("deferred: r", "deferred: r, corrected");
    const forge = fakeForge(corrected);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `${identityLine({ source: THREAD })}\n${textLine({ text: before?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(r.filed).toEqual([]);
    expect(r.unrecorded.map((f) => f.key)).toEqual(["#7"]);
    expect(r.why).toContain("earlier text");
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
    expect(forge.state.body).toBe(corrected);
  });

  test("an issue that only mentions the source, or names another fingerprint on it, is not reused", async () => {
    const comment = `${PR_URL}#issuecomment-77`;
    let body = withDeferredEntry("", {
      source: comment,
      fingerprint: "fp-a",
      finding: "first",
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      source: comment,
      fingerprint: "fp-b",
      finding: "second",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `Mentions ${comment}.\n\n${identityLine({ source: comment, fingerprint: "fp-a" })}\n${textLine({ text: deferredEntries(body)[0]?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(r.filed.map((f) => [f.key, f.reused])).toEqual([
      ["#7", true],
      ["#41", false],
    ]);
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(created).toHaveLength(1);
    expect(
      String(
        (created[0]?.variables.input as { body?: string } | undefined)?.body,
      ),
    ).toContain(identityLine({ source: comment, fingerprint: "fp-b" }));
  });

  test("an entry a person corrects during the run is filed as corrected", async () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: "first",
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      source: other,
      finding: "second",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    // The initial read, then the first entry's fresh read and its write's
    // three; the person corrects the second entry before its fresh read.
    forge.beforeRead.push(...Array(5).fill(() => undefined), (st: PrBody) => {
      st.body = st.body.replace("> second", "> second, corrected");
    });
    const { t, calls } = trackerThatFiles();
    const r = await fileDeferred(forge, t, "42", { label: "pr-followup" });
    expect(r.why).toBeNull();
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(
      String(
        (created[1]?.variables.input as { body?: string } | undefined)?.body,
      ),
    ).toContain("second, corrected");
  });

  test("an entry removed or changed between filing and recording is reported, not counted as recorded", async () => {
    for (const edit of [
      (st: PrBody) => {
        st.body = st.body.replace(
          /<!-- deferred-entry:[\s\S]*?<!-- \/deferred-entry -->/,
          "",
        );
      },
      (st: PrBody) => {
        st.body = st.body.replace("deferred: r", "deferred: r, and more");
      },
    ]) {
      const forge = fakeForge(
        withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
          .body,
      );
      // The initial read and the fresh read, then the person edits.
      forge.beforeRead.push(
        () => undefined,
        () => undefined,
        edit,
      );
      const r = await fileDeferred(forge, trackerThatFiles().t, "42", {
        label: "pr-followup",
      });
      expect(r.filed).toEqual([]);
      expect(r.unrecorded.map((f) => f.key)).toEqual(["#41"]);
      expect(r.why).toContain(
        "#41 was filed, but its entry could not be replaced",
      );
    }
  });

  test("a filing whose entry cannot be replaced is reported with its key", async () => {
    const forge = fakeForge(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    );
    forge.failWrites = true;
    const heard: string[] = [];
    const r = await fileDeferred(forge, trackerThatFiles().t, "42", {
      label: "pr-followup",
      onFiled: (f) => heard.push(f.key),
    });
    expect(heard).toEqual(["#41"]);
    expect(r.unrecorded.map((f) => f.key)).toEqual(["#41"]);
    expect(r.why).toContain(
      "#41 was filed, but its entry could not be replaced",
    );
  });

  test("an issue url carrying = survives the entry's marker", async () => {
    const body = withDeferredEntry("", {
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    const filed = withFiledEntry(
      body,
      { source: THREAD },
      {
        key: "ENG-9",
        url: "https://tracker.example/issue?id=ENG-9&view=a",
      },
    );
    expect(deferredEntries(filed)[0]?.filed).toEqual({
      key: "ENG-9",
      url: "https://tracker.example/issue?id=ENG-9&view=a",
    });
  });

  test("with no tracker, the entries stay and say why", async () => {
    const forge = fakeForge(
      withDeferredEntry("", { source: THREAD, finding: FINDING, reason: "r" })
        .body,
    );
    const r = await fileDeferred(forge, null, "42", {
      label: "pr-followup",
      noTrackerWhy: "no tracker adapter can file: none configured",
    });
    expect(r.remaining).toHaveLength(1);
    expect(r.why).toContain("none configured");
    expect(forge.writes).toBe(0);
  });
});

describe("the route a deferral takes", () => {
  test("the pull request body when the adapter is not Linear", () => {
    expect(deferralRoute({ issue_tracker: { adapter: "github" } }, {})).toEqual(
      {
        route: "pr-body",
        why: "the batch step files on Linear only, and issue_tracker.adapter is github",
      },
    );
    expect(deferralRoute({}, {}).route).toBe("pr-body");
  });

  test("the pull request body on Linear with no credential", () => {
    expect(
      deferralRoute({ issue_tracker: { adapter: "linear" } }, {}).route,
    ).toBe("pr-body");
  });

  test("the batch step on Linear with a credential", () => {
    expect(
      deferralRoute(
        { issue_tracker: { adapter: "linear" } },
        { LINEAR_API_KEY: "x" },
      ).route,
    ).toBe("defer-batch");
  });

  test("the command line prints the route", async () => {
    const proc = Bun.spawn(
      scriptArgv(
        join(import.meta.dir, "..", "scripts", "defer-in-pr.ts"),
        "route",
      ),
      {
        env: { ...process.env, JIG__ISSUE_TRACKER__ADAPTER: "github" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    await expectSpawnExited(proc, 0);
    expect(out).toStartWith("pr-body: ");
  });
});
