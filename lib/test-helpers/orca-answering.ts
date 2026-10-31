import { Defect } from "../../plugin/shared/errors.ts";
import type { OrcaRunner } from "../../plugin/shared/orca.ts";

/**
 * An `OrcaRunner` that answers each Orca call from a table keyed by the
 * call's arguments joined with spaces, records the keys it was asked and the
 * executable each call named, and throws on a call the table does not hold.
 */
export function orcaAnswering(answers: Record<string, string>) {
  const calls: string[] = [];
  const commands: string[] = [];
  const runner: OrcaRunner = async (command, args) => {
    commands.push(command);
    const key = args.join(" ");
    calls.push(key);
    const stdout = answers[key];
    if (stdout === undefined) throw new Defect(`unexpected call: ${key}`);
    return { code: stdout.includes('"ok":true') ? 0 : 1, stdout, stderr: "" };
  };
  return { calls, commands, runner };
}
