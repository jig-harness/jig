/**
 * `jig dispatch line --json`: the newest tick's line, printed as the one JSON
 * document the dashboard's `GET /state` answers with for the same database
 * (`stateAnswer` in `lib/line-store.ts`), so a reader beside the dispatcher
 * (an editor's plugin, a status bar) never opens the state database itself.
 * It only reads: it takes no tick lock and never creates the database, and
 * with no database or no line yet it prints the answer whose `line` is `null`.
 */
import { ExitError } from "../shared/cli.ts";
import { stateAnswer } from "./lib/line-store.ts";
import { stateRoot } from "./receipts.ts";

/** Exit when the stored line cannot be read. */
const LINE_UNREADABLE_EXIT = 1;

export interface LineOptions {
  root?: string;
  /** The clock `now` reads; the real one unless a check holds it still. */
  nowMs?: number;
  print?: (text: string) => void;
}

/** Print the `GET /state` answer; a line that does not read is one line on stderr and exit 1. */
export function lineMain(options: LineOptions = {}): number {
  const answer = stateAnswer(
    options.nowMs ?? Date.now(),
    options.root ?? stateRoot(),
  );
  if (!answer.ok)
    throw new ExitError(
      LINE_UNREADABLE_EXIT,
      `jig dispatch line: ${answer.failure.code}: ${answer.failure.reason.replace(/\s+/g, " ")}`,
      { cause: answer.failure.cause },
    );
  (options.print ?? console.log)(JSON.stringify(answer));
  return 0;
}
