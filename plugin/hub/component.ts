/**
 * `jig hub` as a component of the `jig` command: its own command
 * (`jig hub`, `jig hub serve`), its resident job and the lifecycle verbs'
 * install, uninstall, status, doctor and receipts
 * ([design/control-plane.md § Where it lives](../../design/control-plane.md#where-it-lives)).
 *
 * Its opt-in is the hub's settings file and an install run as the hub's
 * own OS user, so a bare `jig install` or `jig run` never includes it;
 * `jig install hub` names it. `jig hub` alone prints its help. The host
 * protocol's verbs join `hubCommand`'s `or(…)` as they are built.
 *
 * The command lives outside `core/`: it uses the command-line library,
 * and the core stays free of anything bound to one runtime
 * (`scripts/check-portability.ts`).
 */
import { userInfo } from "node:os";
import type { Component } from "../runtime/component.ts";
import { scheduledStatus } from "../runtime/job-status.ts";
import { pathValue } from "../shared/command-line.ts";
import {
  command,
  constant,
  type InferValue,
  message,
  object,
  option,
  optional,
  or,
  runParser,
  withDefault,
} from "../shared/vendor/optique.mjs";
import { serveForeground, serveScheduled } from "./process/command.ts";
import { hubDoctorChecks, systemDoctorProbes } from "./process/doctor.ts";
import { dispatcherReason, hubJobSpec, installHub } from "./process/install.ts";

const serve = command(
  "serve",
  object({
    action: constant("serve"),
    settings: optional(
      option("--settings", pathValue, {
        description: message`The hub's settings file. Without it, ~/.jig/hub/settings.yaml.`,
      }),
    ),
    scheduled: option("--scheduled", {
      description: message`What the resident job runs: the hub as jig install hub recorded, in its image or this process, until its settings or the installed copy change.`,
    }),
  }),
  {
    brief: message`Run the hub: its listeners, its timers and its worker, until stopped.`,
    description: message`Listens for the host protocol under /v1/ on loopback and the private network's addresses only, for webhooks under /webhooks/ on an address of its own, and for the feed on a Unix socket or loopback with the front's secret, as the settings file says. Refuses a settings file or database directory another user can read.`,
  },
);

export const hubCommand = command(
  "hub",
  withDefault(or(serve), { action: "help" as const }),
  {
    brief: message`The hub, an optional shared control plane for many hosts' dispatchers.`,
    description: message`The hub keeps one view of the forge and the tracker for every host enrolled in it. jig install hub installs jig hub serve as a resident job of the hub's own OS user; jig doctor hub checks its user, file modes and interfaces. See plugin/hub/README.md.`,
  },
);

type HubArguments = InferValue<typeof hubCommand>;

/** Prints `jig hub --help` and answers its exit code. */
function printHelp(): number {
  const shown = runParser(hubCommand, "jig", ["hub", "--help"], {
    help: { option: true, onShow: (code: number) => code },
  });
  return typeof shown === "number" ? shown : 0;
}

export const hubComponent: Component<HubArguments> = {
  name: "hub",
  command: hubCommand,
  main: async (args, script) => {
    if (args.action === "help") return printHelp();
    return args.scheduled
      ? serveScheduled(script)
      : serveForeground(args.settings);
  },
  job: hubJobSpec,
  missingOptIn: () =>
    "the hub runs under an OS user of its own: as that user, write its settings file, then run jig install hub (plugin/hub/README.md)",
  install: (request) =>
    installHub({
      confirm: request.confirm,
      remove: false,
      script: request.script,
    }),
  uninstall: (request) =>
    installHub({
      confirm: request.confirm,
      remove: true,
      script: request.script,
    }),
  status: () => scheduledStatus("hub", hubJobSpec(), null),
  doctor: () => {
    const info = userInfo();
    return hubDoctorChecks(
      systemDoctorProbes(
        { uid: info.uid, user: info.username },
        dispatcherReason,
      ),
    );
  },
  receipts: () => {
    console.log(
      "The hub keeps no receipts; its log is the resident job's (journalctl --user -u jig-hub.service).",
    );
    return 0;
  },
};
