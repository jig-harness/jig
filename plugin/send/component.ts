/**
 * `jig send` as a command of the `jig` command: it runs and exits, with no
 * job for a timer and nothing to install, so the lifecycle verbs never act
 * on it (`runtime/component.ts`, `CommandComponent`).
 */
import type { CommandComponent } from "../runtime/component.ts";
import { type SendArguments, sendCommand, sendMain } from "./cli.ts";

export const sendComponent: CommandComponent<SendArguments> = {
  name: "send",
  command: sendCommand,
  main: (args) => sendMain(args),
};
