/**
 * This host's own failing rows told by cause (`failures.group: cause`, the
 * default): one fault on every repository is one notice naming each scope,
 * a scope failing with another cause keeps its own, `scope` tells each row
 * on its own, and the cause is read from a row's reason against a closed
 * list.
 */
import { describe, expect, it } from "bun:test";
import { rowCause } from "../lib/failure-groups.ts";
import { failureCauses, hostNoticeKeys } from "../lib/failure-notices.ts";
import { FAILURE_DEFAULTS, type FailureRow } from "../lib/failures.ts";
import {
  type MachineRepository,
  parseMachineConfigText,
} from "../lib/machine-config.ts";

const LATER = "2026-11-06T11:00:00.000Z";
const RUNTIME =
  "the runtime record (orca) did not read: the runtime could not be read: orca exited 1";

function turn(
  path: string,
  reason: string,
  firstAt = "2026-11-06T10:00:00.000Z",
): FailureRow {
  return {
    repo: path,
    key: "repository",
    kind: "repository",
    target: `o${path}`,
    count: 3,
    firstAt,
    lastAt: "2026-11-06T10:20:00.000Z",
    reason,
    nextAtMs: Date.parse("2026-11-06T10:20:00.000Z"),
    quietAt: null,
    renewals: 0,
  };
}

const repository = (path: string): MachineRepository => ({
  path,
  stages: ["rearm", "notify"],
  followupSince: null,
  owner: true,
});

const machine = (group?: "cause" | "scope") => ({
  // The host tells its own failures at its first owned repository: /home.
  repositories: ["/home", "/a", "/b", "/c"].map(repository),
  ...(group === undefined ? {} : { failures: { ...FAILURE_DEFAULTS, group } }),
});

describe("this host's failures told by cause", () => {
  it("raises one host need naming all three repositories for the same runtime failure", () => {
    const rows = [
      turn("/a", RUNTIME, "2026-11-06T10:05:00.000Z"),
      turn("/b", RUNTIME),
      turn("/c", RUNTIME, "2026-11-06T10:10:00.000Z"),
    ];
    const told = failureCauses("o/home", "/home", rows, machine());
    expect(told).toHaveLength(1);
    const [need] = told;
    expect(need).toMatchObject({
      stage: "notify",
      cause: "host-failing",
      target: "this host's failures from the session runtime",
      evidence: {
        fault: "runtime",
        since: "2026-11-06T10:00:00.000Z",
        scopes: "o/a, o/b, o/c",
      },
    });
    for (const slug of ["o/a", "o/b", "o/c"])
      expect(need?.notice?.text).toContain(
        `- the dispatcher's turn for ${slug}: failed 3 times in a row since`,
      );
    expect(need?.notice?.key).toBe("host runtime failing");
    // The key stands while those rows do, so the notice is kept and not sent twice.
    expect(hostNoticeKeys(rows).has(need?.notice?.key ?? "")).toBe(true);
  });

  it("keeps the same notice while a later scope joins the cause", () => {
    const first = failureCauses(
      "o/home",
      "/home",
      [turn("/a", RUNTIME), turn("/b", RUNTIME)],
      machine(),
    );
    const joined = failureCauses(
      "o/home",
      "/home",
      [
        turn("/a", RUNTIME),
        turn("/b", RUNTIME),
        turn("/c", RUNTIME, "2026-11-06T11:00:00.000Z"),
      ],
      machine(),
    );
    expect(joined[0]?.notice?.key).toBe(first[0]?.notice?.key);
  });

  it("keeps the same notice while a scope leaves the cause or moves to another and back", () => {
    const key = (rows: FailureRow[]) =>
      failureCauses("o/home", "/home", rows, machine()).map(
        (c) => c.notice?.key,
      );
    const both = key([turn("/a", RUNTIME), turn("/b", RUNTIME, LATER)]);
    expect(key([turn("/b", RUNTIME, LATER)])).toEqual(both);
    expect(
      key([turn("/a", "the forge record (github) did not read: HTTP 502")]),
    ).toEqual(["host forge failing"]);
    expect(key([turn("/a", RUNTIME)])).toEqual(both);
  });

  it("reads a tick's cause from the failed turn's reason, not the repository's name", () => {
    const config = "the dispatch section is invalid: a mapping was expected";
    const told = failureCauses(
      "o/home",
      "/home",
      [
        turn("/a", config),
        {
          ...turn(
            "/a",
            `a repository's turn failed, example/orca-plugin: ${config}`,
          ),
          repo: "",
          key: "ticks /a",
          kind: "tick",
          target: "ticks of example/orca-plugin",
        },
      ],
      machine(),
    );
    expect(told.map((c) => c.evidence.fault)).toEqual(["configuration"]);
  });

  it("keeps a scope that fails with another cause its own need", () => {
    const told = failureCauses(
      "o/home",
      "/home",
      [
        turn("/a", RUNTIME),
        turn("/b", RUNTIME),
        turn(
          "/c",
          "the tracker record (linear) did not read: the tracker refused the credential",
        ),
      ],
      machine(),
    );
    expect(told.map((c) => c.evidence.fault)).toEqual(["runtime", "tracker"]);
    expect(told.map((c) => c.evidence.scopes)).toEqual(["o/a, o/b", "o/c"]);
  });

  it("raises one need per repository under failures.group: scope", () => {
    const told = failureCauses(
      "o/home",
      "/home",
      ["/a", "/b", "/c"].map((p) => turn(p, RUNTIME)),
      machine("scope"),
    );
    expect(told.map((c) => [c.cause, c.target])).toEqual([
      ["repository-failing", "o/a"],
      ["repository-failing", "o/b"],
      ["repository-failing", "o/c"],
    ]);
  });

  it("tells nothing until one of the cause's rows reaches the threshold", () => {
    const below = ["/a", "/b"].map((p) => ({ ...turn(p, RUNTIME), count: 2 }));
    expect(failureCauses("o/home", "/home", below, machine())).toEqual([]);
  });
});

describe("a failing row's cause", () => {
  it("reads the system a record that did not read names first", () => {
    expect(rowCause(RUNTIME)).toBe("runtime");
    expect(
      rowCause(
        "the tracker record (github) did not read: GitHub answered HTTP 502",
      ),
    ).toBe("tracker");
    expect(
      rowCause("the forge record (github) did not read: HTTP 422 from gh"),
    ).toBe("forge");
  });

  it("reads the system a reason names, the configuration only when none failed", () => {
    expect(
      rowCause(
        "the dispatch section on the default branch cannot be read, so nothing is planned: gh exited 1: HTTP 404",
      ),
    ).toBe("forge");
    expect(
      rowCause(
        "the dispatch section on the default branch cannot be read, so nothing is planned: a mapping was expected at line 3",
      ),
    ).toBe("configuration");
    expect(
      rowCause("the change-area catalog does not read: unknown field paths"),
    ).toBe("configuration");
    expect(
      rowCause("the outcome log was not written: database is locked"),
    ).toBe("state");
    expect(rowCause("the tick exited 1 with no cause on its receipt")).toBe(
      "other",
    );
  });
});

describe("the machine file's failures.group", () => {
  const parse = (failures: string) =>
    parseMachineConfigText(
      `repositories: []\nfailures:\n${failures}\n`,
      "dispatch.yaml",
    );

  it("defaults to cause and takes scope", () => {
    const absent = parse("  notify_after: 3");
    expect(absent.ok && absent.value.failures?.group).toBe("cause");
    const scope = parse("  group: scope");
    expect(scope.ok && scope.value.failures?.group).toBe("scope");
  });

  it("refuses any other value", () => {
    const refused = parse("  group: repository");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.failure.reason).toContain(
      "failures.group must be cause or scope",
    );
  });
});
