/**
 * How a dispatched drive hands its closing report to the wrapper that runs
 * it. The wrapper (`dispatch/run.ts`) starts `drive.ts` with
 * `JIG_DRIVER_REPORT` naming a file in the run's own state directory
 * (`~/.local/state/jig/dispatch/runs/<record>/drive-report.json`, readable
 * only by its owner); `drive.ts`, when it stops, writes there the closing
 * report it composed (`skills/drive-pr/scripts/lib/driver/closing-report.ts`),
 * stamped with its launch record; and the wrapper reads it once the drive
 * has ended, checks it again and records it under the record, written by
 * the driver (`dispatch/lib/run-report.ts`).
 *
 * Only the wrapper sets the variable, and the driver hands it to none of its
 * passes, so a drive armed any other way writes no file, and a drive armed
 * from inside a dispatched session never writes onto that session's record.
 */
import {
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  type ClosingReport,
  closingReportOf,
  REPORT_BYTE_LIMIT,
} from "./closing-report.ts";
import { isRecord } from "./guards.ts";
import { failed, JigError, ok, type Outcome } from "./outcome.ts";

/**
 * The text of the file at `path`, read no further than `max` bytes; `null`
 * when the file holds more, so an oversized file is refused without being
 * held whole in memory. The file is opened without blocking and must be a
 * regular file: a FIFO or device at the path would otherwise stall the
 * synchronous open or read with no timeout able to interrupt it, so it is
 * refused (throws) instead.
 */
export function readBoundedText(path: string, max: number): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile())
      throw new JigError("unreadable", "not a regular file");
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return length > max ? null : buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

/** The variable naming the file a dispatched drive writes its closing report to. */
export const DRIVER_REPORT_VARIABLE = "JIG_DRIVER_REPORT";

const DRIVER_REPORT_SCHEMA = "driver-closing-report/v1";

/** The file as the driver writes it: its launch record and its report. */
interface DriverReportFile {
  schema: typeof DRIVER_REPORT_SCHEMA;
  launch: string;
  report: ClosingReport;
}

/** The file a dispatched drive writes its closing report to, or `null` when no wrapper named one. */
export function driverReportPath(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const path = (env[DRIVER_REPORT_VARIABLE] ?? "").trim();
  return path === "" ? null : path;
}

/** Write `report`, stamped with `launch`, to `path`: whole or not at all, in a directory only its owner reads. */
export function writeDriverReport(
  path: string,
  launch: string,
  report: ClosingReport,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file: DriverReportFile = {
    schema: DRIVER_REPORT_SCHEMA,
    launch,
    report,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The report at `path` for launch record `launch`, checked again; `null`
 * when there is no file. A file that does not read, that names another
 * launch, or whose report the check refuses, is a failure naming why.
 */
export function readDriverReport(
  path: string,
  launch: string,
): Outcome<ClosingReport | null, "unreadable"> {
  if (!existsSync(path)) return ok(null);
  let value: unknown;
  try {
    const text = readBoundedText(path, REPORT_BYTE_LIMIT * 2);
    if (text === null)
      return failed("unreadable", "the driver's report file is too large");
    value = JSON.parse(text);
  } catch (error) {
    return failed(
      "unreadable",
      `the driver's report file does not read: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (
    !isRecord(value) ||
    value.schema !== DRIVER_REPORT_SCHEMA ||
    value.launch !== launch
  )
    return failed(
      "unreadable",
      `the driver's report file is not one for launch record ${launch}`,
    );
  const checked = closingReportOf(JSON.stringify(value.report));
  return checked.ok
    ? ok(checked.value)
    : failed(
        "unreadable",
        `the driver's report does not pass the check: ${checked.failure.reason}`,
      );
}
