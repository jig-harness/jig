import { describe, expect, test } from "bun:test";
import {
  captureTree,
  liveTargets,
  type PsRow,
  recaptureOwned,
  type Target,
  witnessStep,
} from "../scripts/lib/process-witness.ts";

const row = (pid: number, start: string, stat = "S"): PsRow => ({
  pid,
  ppid: 1,
  start,
  stat,
});
const T1: Target = { pid: 10, start: "A" };
const T2: Target = { pid: 11, start: "B" };
const T3: Target = { pid: 12, start: "C" };

describe("process-witness", () => {
  test("a live target is signalled and reported live", () => {
    const killed: number[] = [];
    const left = witnessStep(
      [T1],
      [row(10, "A")],
      (p) => killed.push(p),
      () => true,
    );
    expect(left).toEqual([T1]);
    expect(killed).toEqual([10]);
  });

  test("a zombie or absent target is dead: not signalled, not reported", () => {
    const killed: number[] = [];
    const left = witnessStep(
      [T1, T2],
      [row(10, "A", "Z+")],
      (p) => killed.push(p),
      () => true,
    );
    expect(left).toEqual([]);
    expect(killed).toEqual([]);
  });

  test("a reused pid (different start time) is a different process: never signalled", () => {
    const killed: number[] = [];
    const left = witnessStep(
      [T1],
      [row(10, "OTHER")],
      (p) => killed.push(p),
      () => true,
    );
    expect(left).toEqual([]);
    expect(killed).toEqual([]);
  });

  test("feeding the result back never re-signals a target already seen dead", () => {
    const killed: number[] = [];
    const kill = (p: number) => killed.push(p);
    let targets = [T1, T2, T3];
    // Poll 1: all live. Poll 2: T1 and T2 exited and their pids were reused.
    targets = witnessStep(
      targets,
      [row(10, "A"), row(11, "B"), row(12, "C")],
      kill,
      () => true,
    );
    expect(killed).toEqual([10, 11, 12]);
    targets = witnessStep(
      targets,
      [row(10, "X"), row(11, "Y"), row(12, "C")],
      kill,
      () => true,
    );
    expect(targets).toEqual([T3]);
    targets = witnessStep(
      targets,
      [row(10, "X"), row(11, "Y"), row(12, "C")],
      kill,
      () => true,
    );
    expect(killed).toEqual([10, 11, 12, 12, 12]);
  });

  test("witness distinguishes live, zombie and absent states", () => {
    const rows = [row(10, "A"), row(11, "B", "Z")];
    expect(liveTargets([T1, T2, T3], rows)).toEqual([T1]);
  });

  test("ps unavailable: nothing is signalled, liveness falls back to the probe", () => {
    const killed: number[] = [];
    const left = witnessStep(
      [T1, T2],
      null,
      (p) => killed.push(p),
      (p) => p === 11,
    );
    expect(left).toEqual([T2]);
    expect(killed).toEqual([]);
  });

  test("captureTree: an unreadable process table is unresolved (null), never an empty or invented tree", () => {
    expect(captureTree(10, null)).toBeNull();
  });

  test("captureTree: failed capture followed by a successful one identifies the same live command, which the witness then kills", () => {
    const killed: number[] = [];
    expect(captureTree(10, null)).toBeNull();
    const rows = [row(10, "A"), { ...row(11, "B"), ppid: 10 }];
    const tree = captureTree(10, rows);
    expect(tree).toEqual([T2, T1]);
    const left = witnessStep(
      tree as Target[],
      rows,
      (p) => killed.push(p),
      () => true,
    );
    expect(left).toEqual([T2, T1]);
    expect(killed).toEqual([11, 10]);
  });

  test("captureTree: a root absent from a readable table is already dead and yields no target", () => {
    expect(captureTree(10, [row(99, "Z")])).toEqual([]);
  });

  test("recaptureOwned: root reaped with no recorded identity is unverifiable, never an empty tree", () => {
    expect(recaptureOwned(10, null, true, [row(99, "Z")]).kind).toBe(
      "unverifiable",
    );
    expect(recaptureOwned(10, null, true, [row(10, "X")]).kind).toBe(
      "unverifiable",
    );
    expect(recaptureOwned(10, null, false, null).kind).toBe("unresolved");
  });

  test("recaptureOwned: a pid reused by a stranger is never captured or signalled", () => {
    const stranger = [row(10, "STRANGER"), { ...row(50, "D"), ppid: 10 }];
    expect(recaptureOwned(10, T1, true, stranger)).toEqual({
      kind: "tree",
      root: T1,
      targets: [],
    });
  });

  test("recaptureOwned: the recorded identity still owning the pid captures its tree; the first live sighting records it", () => {
    const rows = [row(10, "A"), { ...row(11, "B"), ppid: 10 }];
    expect(recaptureOwned(10, T1, false, rows)).toEqual({
      kind: "tree",
      root: T1,
      targets: [T2, T1],
    });
    expect(recaptureOwned(10, null, false, rows)).toEqual({
      kind: "tree",
      root: T1,
      targets: [T2, T1],
    });
  });
});
