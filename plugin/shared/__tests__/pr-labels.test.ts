/**
 * The pull request state labels' own writes (`shared/pr-labels/`): each
 * writer writes only the states it owns, in one edit and only when the
 * labels disagree; a drive leaves a held pull request as it is; a failure is
 * a value, never a throw; and `dispatch.labels` reads the same from any
 * configuration.
 */
import { describe, expect, it } from "bun:test";
import { failed, ok, type Outcome } from "../outcome.ts";
import { parseLabelConfig } from "../pr-labels/config.ts";
import {
  DEFAULT_LABELS,
  type LabelConfig,
  ledgerState,
  type Projected,
} from "../pr-labels/projection.ts";
import {
  type OwnForge,
  type OwnWriter,
  ownWriteLine,
  writeOwnState,
} from "../pr-labels/write.ts";

const ON: LabelConfig = { enabled: true, prefix: "jig:", onlyLabeled: false };
const EXITS = { converged: 0, takenOver: 20 };

/** A forge whose pull request carries `labels`; its edits are kept in `edits`. */
function forge(
  labels: string[],
  edit: () => Outcome<void> = () => ok(undefined),
  head?: string,
) {
  const edits: Array<{ add: readonly string[]; remove: readonly string[] }> =
    [];
  const f: OwnForge = {
    labels: async () => ok(head === undefined ? { labels } : { labels, head }),
    edit: async (_pr, add, remove) => {
      edits.push({ add, remove });
      return edit();
    },
  };
  return { f, edits };
}

const write = (
  writer: OwnWriter,
  projected: Projected,
  f: OwnForge,
  config = ON,
) => writeOwnState({ config, pr: 7, projected, writer, forge: f });

describe("a writer's own state label", () => {
  it("arms with driving and removes the drive command in one edit", async () => {
    const { f, edits } = forge(["jig:drive", "jig:stale", "area:docs"]);
    const r = await write("drive", ledgerState({ class: "driven" }, EXITS), f);
    expect(r).toEqual({
      outcome: "written",
      detail: "+jig:driving -jig:stale -jig:drive",
    });
    expect(edits).toEqual([
      { add: ["jig:driving"], remove: ["jig:stale", "jig:drive"] },
    ]);
  });

  it("maps a stop the way the tick does: converged, parked", () => {
    expect(ledgerState({ class: "done", exit: 0 }, EXITS)).toEqual({
      state: "converged",
    });
    expect(ledgerState({ class: "parked" }, EXITS)).toEqual({
      state: "parked",
    });
    expect(ledgerState({ class: "needs-person" }, EXITS)).toEqual({
      state: "parked",
    });
  });

  it("writes nothing when the labels already agree", async () => {
    const { f, edits } = forge(["jig:converged"]);
    const r = await write("drive", { state: "converged" }, f);
    expect(r).toEqual({ outcome: "agrees" });
    expect(edits).toEqual([]);
    expect(ownWriteLine(7, r)).toBeNull();
  });

  it("never writes a state another writer owns", async () => {
    for (const [writer, state] of [
      ["drive", "stale"],
      ["drive", "held"],
      ["drive", "followed-up"],
      ["drive", "followup-failed"],
      ["followup", "driving"],
      ["followup", "stale"],
    ] as const) {
      const { f, edits } = forge([]);
      const r = await write(writer, { state }, f);
      expect(r.outcome).toBe("kept");
      expect(edits).toEqual([]);
    }
  });

  it("leaves a pull request carrying hold or held as it is, for a drive", async () => {
    for (const label of ["jig:hold", "jig:held"]) {
      const { f, edits } = forge([label]);
      const r = await write("drive", { state: "driving" }, f);
      expect(r).toEqual({ outcome: "held", detail: `it carries ${label}` });
      expect(edits).toEqual([]);
    }
  });

  it("sets a follow-up's end whatever command labels the merged pull request carries", async () => {
    const { f, edits } = forge(["jig:hold", "jig:converged"]);
    const r = await write("followup", { state: "followed-up" }, f);
    expect(r.outcome).toBe("written");
    expect(edits).toEqual([
      { add: ["jig:followed-up"], remove: ["jig:converged"] },
    ]);
  });

  it("returns a refused read and a refused edit as values, and lets a throw through as a defect", async () => {
    const unread: OwnForge = {
      labels: async () => failed("unreadable", "HTTP 502"),
      edit: async () => ok(undefined),
    };
    expect(await write("drive", { state: "driving" }, unread)).toEqual({
      outcome: "refused",
      detail: "HTTP 502",
    });
    const { f } = forge([], () => failed("refused", "'jig:driving' not found"));
    const refused = await write("drive", { state: "driving" }, f);
    expect(refused).toEqual({
      outcome: "refused",
      detail: "'jig:driving' not found",
    });
    // Accurate with no dispatcher: a tick corrects it only where one runs.
    expect(ownWriteLine(7, refused)).toContain(
      "a dispatcher's next tick corrects it where one runs; otherwise `jig dispatch labels --yes` creates a missing label",
    );
    // A throw is a defect, not a refusal: it reaches the writer's boundary.
    const throwing: OwnForge = {
      labels: async () => {
        throw new Error("spawn failed");
      },
      edit: async () => ok(undefined),
    };
    await expect(
      write("drive", { state: "driving" }, throwing),
    ).rejects.toThrow("spawn failed");
  });

  it("reads and writes nothing while the labels are off", async () => {
    const { f, edits } = forge(["jig:stale"]);
    expect(
      await write("drive", { state: "driving" }, f, DEFAULT_LABELS),
    ).toEqual({ outcome: "off" });
    expect(edits).toEqual([]);
  });
});

describe("converged only at the head the drive verified", () => {
  it("writes converged while the head is the verified one", async () => {
    const { f, edits } = forge(["jig:driving"], undefined, "aaa");
    const r = await writeOwnState({
      config: ON,
      pr: 7,
      projected: { state: "converged" },
      writer: "drive",
      forge: f,
      head: "aaa",
    });
    expect(r.outcome).toBe("written");
    expect(edits).toHaveLength(1);
  });

  it("leaves the labels, a newer stale among them, once the head moved", async () => {
    const { f, edits } = forge(["jig:stale"], undefined, "bbb");
    const r = await writeOwnState({
      config: ON,
      pr: 7,
      projected: { state: "converged" },
      writer: "drive",
      forge: f,
      head: "aaa",
    });
    expect(r.outcome).toBe("moved");
    expect(edits).toEqual([]);
    expect(ownWriteLine(7, r)).toContain(
      "is not the head aaa the drive verified",
    );
  });
});

describe("ownership asked after the label read", () => {
  it("leaves the labels when the writer lost its claim during the read", async () => {
    const { f, edits } = forge(["jig:driving"]);
    const r = await writeOwnState({
      config: ON,
      pr: 7,
      projected: { state: "parked" },
      writer: "drive",
      forge: f,
      beforeEdit: async () =>
        "its drive ledger no longer belongs to this driver",
    });
    expect(r.outcome).toBe("held");
    expect(edits).toEqual([]);
  });

  it("leaves a converged label when the head moves during the ownership check", async () => {
    const edits: unknown[] = [];
    let heads = ["aaa", "bbb"];
    const f: OwnForge = {
      labels: async () =>
        ok({ labels: ["jig:driving"], head: heads.shift() ?? "bbb" }),
      edit: async (_pr, add, remove) => {
        edits.push({ add, remove });
        return ok(undefined);
      },
    };
    const r = await writeOwnState({
      config: ON,
      pr: 7,
      projected: { state: "converged" },
      writer: "drive",
      forge: f,
      head: "aaa",
      beforeEdit: async () => null,
    });
    expect(r.outcome).toBe("moved");
    expect(edits).toEqual([]);
  });

  it("writes while the writer still owns the pull request", async () => {
    const { f, edits } = forge(["jig:driving"]);
    const r = await writeOwnState({
      config: ON,
      pr: 7,
      projected: { state: "parked" },
      writer: "drive",
      forge: f,
      beforeEdit: async () => null,
    });
    expect(r.outcome).toBe("written");
    expect(edits).toHaveLength(1);
  });
});

describe("dispatch.labels", () => {
  it("reads the setting and its prefix, off by default", () => {
    expect(parseLabelConfig(undefined)).toEqual(ok(DEFAULT_LABELS));
    expect(parseLabelConfig({ enabled: true, prefix: "bot/" })).toEqual(
      ok({ enabled: true, prefix: "bot/", onlyLabeled: false }),
    );
  });

  it("refuses a value the dispatcher refuses", () => {
    expect(parseLabelConfig({ enabled: "yes" }).ok).toBe(false);
  });
});
