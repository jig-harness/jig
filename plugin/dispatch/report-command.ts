/**
 * `jig dispatch report <record> <token> <file>`: a dispatched pass (a
 * pickup's, a follow-up's or the steward's) writes its closing report, a
 * `closing-report/v1` record (`shared/closing-report.ts`) as JSON in `file`,
 * or `-` for standard input, under the token its prompt names. The report is
 * redacted and checked, then kept on the launch record and on its outcome
 * row (`lib/closing-report-store.ts`), written by the agent (`by: agent`).
 *
 * It is separate from `jig dispatch result`: a pass may run it more than
 * once, before or after its result, and the last report that passes the
 * check stands. A report the check refuses records nothing and names every
 * problem, so the pass can fix it and run the command again; no report ever
 * touches a recorded result. A drive's record is refused: its driver writes
 * its report.
 *
 * Exit codes: 0 recorded; 2 usage, no such record, a token that is not the
 * record's, a drive's record, or a report the check refuses.
 */
import { closingReportOf } from "../shared/closing-report.ts";
import { recordReport } from "./lib/closing-report-store.ts";
import { isDrive, isRecordId, readRecord } from "./lib/launches.ts";
import { sameToken } from "./result.ts";
import { stateRoot } from "./receipts.ts";

const NAME = "jig dispatch report";

/** Record the report `text` holds for record `id`, under `token`; the exit code. */
function reportMain(
  id: string,
  token: string,
  text: string,
  root = stateRoot(),
): number {
  const record = isRecordId(id) ? readRecord(id, root) : null;
  if (record === null || !sameToken(record.token, token)) {
    console.error(`${NAME}: ${id} is not a launch record with that token`);
    return 2;
  }
  if (isDrive(record)) {
    console.error(
      `${NAME}: ${id} is a drive's record; its driver writes its report`,
    );
    return 2;
  }
  const report = closingReportOf(text);
  if (!report.ok) {
    console.error(
      `${NAME}: the report was not recorded: ${report.failure.reason}`,
    );
    return 2;
  }
  if (!recordReport(id, report.value, "agent", root)) {
    console.error(`${NAME}: ${id} is not a launch record with that token`);
    return 2;
  }
  console.log(
    JSON.stringify({
      record: id,
      ...(record.item === null ? { pr: record.pr } : { item: record.item }),
      report: "recorded",
      by: "agent",
      ...(report.value.cause === undefined
        ? {}
        : { cause: report.value.cause }),
    }),
  );
  return 0;
}

/** `<record> <token> <file|->`: the report's text read, then recorded. */
export async function reportFileMain(
  id: string,
  token: string,
  file: string,
): Promise<number> {
  let text: string;
  try {
    text = file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
  } catch (error) {
    console.error(
      `${NAME}: the report could not be read from ${file === "-" ? "standard input" : file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  return reportMain(id, token, text);
}
