import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVER_LOG_MAX_BYTES, DriverLog } from "../scripts/lib/driver-log.ts";
import { PLAIN_ENTRIES } from "../scripts/lib/state/state-file-patterns.ts";

const dir = mkdtempSync(join(tmpdir(), "driver-log-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `drive-pr-${++n}.log`);
const at = (iso: string) => ({ now: () => Date.parse(iso) });

describe("the driver log", () => {
  test("stamps every line with its time and level", () => {
    const path = fresh();
    const log = new DriverLog(path, { clock: at("2026-01-02T03:04:05.006Z") });
    log.append("INFO", "round 1\nround 2\n");
    log.append("WARN", new TextEncoder().encode("refused\n"));
    expect(readFileSync(path, "utf8")).toBe(
      "2026-01-02T03:04:05.006Z INFO round 1\n" +
        "2026-01-02T03:04:05.006Z INFO round 2\n" +
        "2026-01-02T03:04:05.006Z WARN refused\n",
    );
  });

  test("leaves a line split across writes stamped once", () => {
    const path = fresh();
    const log = new DriverLog(path, { clock: at("2026-01-02T03:04:05.006Z") });
    log.append("WARN", "dirty: ");
    log.append("WARN", "a.ts\nnext");
    log.append("WARN", "\n");
    expect(readFileSync(path, "utf8")).toBe(
      "2026-01-02T03:04:05.006Z WARN dirty: a.ts\n" +
        "2026-01-02T03:04:05.006Z WARN next\n",
    );
  });

  test("moves the file to .1 before a write would pass the bound", () => {
    const path = fresh();
    writeFileSync(`${path}.1`, "an older generation\n");
    const log = new DriverLog(path, { maxBytes: 200 });
    const line = `${"x".repeat(40)}\n`;
    log.append("INFO", line);
    log.append("INFO", line);
    const first = readFileSync(path, "utf8");
    expect(first.split("\n")).toHaveLength(3);
    log.append("INFO", line);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(first);
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(2);
  });

  test("counts what the file already holds against the bound", () => {
    const path = fresh();
    writeFileSync(path, "y".repeat(90));
    new DriverLog(path, { maxBytes: 100 }).append("INFO", "z\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("y".repeat(90));
    expect(readFileSync(path, "utf8")).toEndWith("INFO z\n");
  });

  test("rotates at 10 MiB by default, and the rotated file stays in the log family", () => {
    expect(DRIVER_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    const family = (name: string) =>
      PLAIN_ENTRIES.find((entry) => entry.re.test(name))?.family;
    expect(family("drive-pr-12.log")).toBe("log");
    expect(family("drive-pr-12.log.1")).toBe("log");
    expect(family("drive-pr-12.log.2")).toBeUndefined();
    expect(existsSync(join(dir, "drive-pr-0.log"))).toBe(false);
  });

  test("a second writer on the same file does not rotate the first one's history away", () => {
    const path = fresh();
    const line = `${"x".repeat(40)}\n`;
    const first = new DriverLog(path, { maxBytes: 200 });
    first.append("INFO", line);
    first.append("INFO", line);
    // A second driver opens the log, refuses, and writes its refusal after
    // the first has rotated the file under it.
    const second = new DriverLog(path, {
      maxBytes: 200,
      mayRotate: () => false,
    });
    first.append("INFO", line);
    const history = readFileSync(`${path}.1`, "utf8");
    expect(history.split("\n")).toHaveLength(3);
    second.append("WARN", "refused: another driver holds the lock\n");
    expect(readFileSync(`${path}.1`, "utf8")).toBe(history);
    expect(readFileSync(path, "utf8")).toContain("refused");
  });

  test("a writer that may not rotate only appends, even past the bound", () => {
    const path = fresh();
    writeFileSync(`${path}.1`, "the driver's history\n");
    writeFileSync(path, "y".repeat(190));
    // Neither refused driver renames the nearly-full file.
    for (const who of ["one", "two"])
      new DriverLog(path, { maxBytes: 200, mayRotate: () => false }).append(
        "WARN",
        `refused ${who}\n`,
      );
    expect(readFileSync(`${path}.1`, "utf8")).toBe("the driver's history\n");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("refused one");
    expect(text).toContain("refused two");
  });

  test("the writer that rotates counts what other writers appended", () => {
    const path = fresh();
    const line = `${"x".repeat(40)}\n`;
    const owner = new DriverLog(path, { maxBytes: 200 });
    owner.append("INFO", line);
    // A refused driver fills the file to near the bound; the owner's own
    // count of what it wrote would still leave room for another line.
    new DriverLog(path, { maxBytes: 200, mayRotate: () => false }).append(
      "WARN",
      `refused ${"y".repeat(80)}\n`,
    );
    owner.append("INFO", line);
    expect(readFileSync(`${path}.1`, "utf8")).toContain("refused");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("refused");
    expect(text.split("\n")).toHaveLength(2);
  });

  test("stamps a line continued across a rotation at the top of the new file", () => {
    const path = fresh();
    const log = new DriverLog(path, {
      maxBytes: 120,
      clock: at("2026-01-02T03:04:05.006Z"),
    });
    log.append("WARN", `${"x".repeat(60)} `);
    log.append("WARN", `${"y".repeat(60)}\n`);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(
      `2026-01-02T03:04:05.006Z WARN ${"x".repeat(60)} `,
    );
    expect(readFileSync(path, "utf8")).toBe(
      `2026-01-02T03:04:05.006Z WARN ${"y".repeat(60)}\n`,
    );
  });

  test("keeps only the last part of a single write larger than the bound", () => {
    const path = fresh();
    const stamp = "2026-01-02T03:04:05.006Z INFO ";
    const log = new DriverLog(path, {
      maxBytes: 200,
      clock: at("2026-01-02T03:04:05.006Z"),
    });
    log.append("INFO", "before\n");
    log.append("INFO", `${"é".repeat(300)}end\n`);
    const text = readFileSync(path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    expect(text).toStartWith(`${stamp}[driver log: `);
    expect(text).toEndWith("end\n");
    expect(text).not.toContain("\uFFFD");
    // The kept part starts inside the line, so it is stamped again.
    for (const line of text.split("\n").filter((l) => l !== ""))
      expect(line).toStartWith(stamp);
    expect(readFileSync(`${path}.1`, "utf8")).toContain("before");
  });

  test("does not stamp a kept part twice when it starts on a line", () => {
    const path = fresh();
    const stamp = "2026-01-02T03:04:05.006Z WARN ";
    const log = new DriverLog(path, {
      maxBytes: 200,
      clock: at("2026-01-02T03:04:05.006Z"),
    });
    // The last 200 bytes minus the note and a stamp begin exactly at "last".
    const note = `${stamp}[driver log: 0000 bytes in one write; only the last part is kept]\n`;
    const room = 200 - Buffer.byteLength(note) - Buffer.byteLength(stamp);
    const lastLine = `last ${"z".repeat(room - Buffer.byteLength(stamp) - 6)}\n`;
    const filler = `${"q".repeat(1000 - Buffer.byteLength(stamp))}\n`;
    log.append("WARN", filler + lastLine);
    const text = readFileSync(path, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    const lines = text.split("\n").filter((l) => l !== "");
    for (const line of lines) expect(line).toStartWith(stamp);
    expect(lines.at(-1)).toBe(`${stamp}${lastLine.slice(0, -1)}`);
  });

  test("keeps writing past the bound, and reports once, when the rotation fails", () => {
    const path = fresh();
    mkdirSync(`${path}.1`);
    writeFileSync(join(`${path}.1`, "occupied"), "");
    const problems: string[] = [];
    const log = new DriverLog(path, {
      maxBytes: 100,
      report: (message) => problems.push(message),
    });
    for (let i = 0; i < 5; i++) log.append("INFO", `${"y".repeat(40)} ${i}\n`);
    const text = readFileSync(path, "utf8");
    for (let i = 0; i < 5; i++) expect(text).toContain(` ${i}\n`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${path}.1`);
  });

  test("keeps a character split across two writes", () => {
    const path = fresh();
    const log = new DriverLog(path, { clock: at("2026-01-02T03:04:05.006Z") });
    const bytes = new TextEncoder().encode("café\n");
    log.append("INFO", bytes.subarray(0, 4));
    log.append("INFO", bytes.subarray(4));
    expect(readFileSync(path, "utf8")).toBe(
      "2026-01-02T03:04:05.006Z INFO café\n",
    );
  });

  test("stamps each stream's part of interleaved lines with its own level", () => {
    const path = fresh();
    const log = new DriverLog(path, { clock: at("2026-01-02T03:04:05.006Z") });
    log.append("INFO", "round ");
    log.append("WARN", "warning\n");
    log.append("INFO", "3 started\n");
    expect(readFileSync(path, "utf8")).toBe(
      "2026-01-02T03:04:05.006Z INFO round \n" +
        "2026-01-02T03:04:05.006Z WARN warning\n" +
        "2026-01-02T03:04:05.006Z INFO 3 started\n",
    );
  });

  test("separates each run's header from the last run with a blank line", () => {
    const path = fresh();
    const clock = at("2026-01-02T03:04:05.006Z");
    new DriverLog(path, { clock }).startRun("run one");
    new DriverLog(path, { clock }).startRun("run two");
    expect(readFileSync(path, "utf8")).toBe(
      "\n2026-01-02T03:04:05.006Z INFO run one\n" +
        "\n2026-01-02T03:04:05.006Z INFO run two\n",
    );
  });

  test("never throws: a log it cannot write is reported once", () => {
    const parent = join(dir, `not-a-dir-${++n}`);
    writeFileSync(parent, "");
    const problems: string[] = [];
    const log = new DriverLog(join(parent, "drive-pr-1.log"), {
      report: (message) => problems.push(message),
    });
    log.append("INFO", "a\n");
    log.append("INFO", "b\n");
    expect(problems).toHaveLength(1);
  });
});
