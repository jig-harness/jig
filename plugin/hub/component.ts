/**
 * `jig hub` as a command of the `jig` command: the hub's verbs (`serve`,
 * `status`) join it as they are built; until then it prints its help and
 * exits 0. It runs and exits, with nothing to install, so the lifecycle
 * verbs never act on it (`runtime/component.ts`, `CommandComponent`).
 *
 * The command lives outside `core/`: it uses the command-line library,
 * and the core stays free of anything bound to one runtime
 * (`scripts/check-portability.ts`).
 */
import type { CommandComponent } from "../runtime/component.ts";
import {
  command,
  type InferValue,
  message,
  object,
  runParser,
} from "../shared/vendor/optique.mjs";

const hubCommand = command("hub", object({}), {
  brief: message`The hub, an optional shared control plane for many hosts' dispatchers.`,
  description: message`The hub keeps one view of the forge and the tracker for every host enrolled in it. Its commands come in later releases; for now this prints this help. See design/control-plane.md in Jig's repository.`,
});

type HubArguments = InferValue<typeof hubCommand>;

/** Prints `jig hub --help` and answers its exit code. */
function printHelp(): number {
  const shown = runParser(hubCommand, "jig", ["hub", "--help"], {
    help: { option: true, onShow: (code: number) => code },
  });
  return typeof shown === "number" ? shown : 0;
}

export const hubComponent: CommandComponent<HubArguments> = {
  name: "hub",
  command: hubCommand,
  main: async () => printHelp(),
};
