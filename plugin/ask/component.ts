/**
 * `jig ask` as a command of the `jig` command: it runs and exits, with no
 * job for a timer and nothing to install, so the lifecycle verbs never act
 * on it (`runtime/component.ts`, `CommandComponent`).
 */
import type { CommandComponent } from "../runtime/component.ts";
import { type AskArguments, askCommand, askMain } from "./cli.ts";

export const askComponent: CommandComponent<AskArguments> = {
  name: "ask",
  command: askCommand,
  main: (args) => askMain(args),
};
