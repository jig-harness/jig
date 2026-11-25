/**
 * The process adapter's serving port: binds the three listeners the
 * settings name (`listeners.ts`), each with its own handler, and holds
 * them until the serving context's signal aborts. `/v1/` binds each of its
 * loopback and private-network addresses, never every interface; the
 * webhook listener binds its own address; the feed binds its Unix socket,
 * or loopback with the front's secret.
 */
import { readFileSync } from "node:fs";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { HubPorts } from "../core/ports.ts";
import type { ServingPort } from "../core/serving.ts";
import {
  type BoundListener,
  type ListenerSpec,
  startListener,
} from "./listeners.ts";
import type { HubSettings } from "./settings.ts";

/** The group id of `name`, from the group database. */
export function groupId(
  name: string,
  readGroups: () => string = () => readFileSync("/etc/group", "utf8"),
): Outcome<number, "unavailable"> {
  const text = attempt("unavailable", "cannot read /etc/group", readGroups);
  if (!text.ok) return text;
  for (const line of text.value.split("\n")) {
    const [group, , id] = line.split(":");
    if (group === name && id !== undefined && /^\d+$/.test(id))
      return ok(Number(id));
  }
  return failed("unavailable", `no group named ${name} in /etc/group`);
}

/** The listeners the settings name, without their handlers yet. */
export function listenerBinds(
  settings: Pick<HubSettings, "host" | "webhooks" | "feed">,
): Outcome<Omit<ListenerSpec, "handler">[], "unavailable"> {
  const specs: Omit<ListenerSpec, "handler">[] = settings.host.map(
    (address) => ({
      name: "host" as const,
      bind: { hostname: address.host, port: address.port },
    }),
  );
  specs.push({
    name: "webhook",
    bind: { hostname: settings.webhooks.host, port: settings.webhooks.port },
  });
  const { feed } = settings;
  if ("socket" in feed) {
    const gid = feed.group === null ? ok(null) : groupId(feed.group);
    if (!gid.ok) return gid;
    specs.push({ name: "feed", bind: { unix: feed.socket, gid: gid.value } });
  } else
    specs.push({
      name: "feed",
      bind: { hostname: feed.listen.host, port: feed.listen.port },
      secret: feed.secret,
    });
  return ok(specs);
}

/**
 * The serving port over the settings' listeners. `onBound` hears what was
 * bound once every listener is up; a listener that cannot bind stops the
 * ones already up and fails `unavailable`.
 */
export function processServing(
  settings: Pick<HubSettings, "host" | "webhooks" | "feed">,
  ports: Pick<HubPorts, "clock" | "observability">,
  onBound: (listeners: readonly BoundListener[]) => void,
): ServingPort {
  return {
    serve: async (context, handlers) => {
      const binds = listenerBinds(settings);
      if (!binds.ok) return binds;
      const bound: BoundListener[] = [];
      const stopAll = () =>
        Promise.all(bound.map((listener) => listener.stop()));
      for (const bind of binds.value) {
        const started = startListener(
          ports,
          { ...bind, handler: handlers[bind.name] },
          context.signal,
        );
        if (!started.ok) {
          await stopAll();
          return started;
        }
        bound.push(started.value);
      }
      onBound(bound);
      if (!context.signal.aborted)
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      await stopAll();
      return ok(undefined);
    },
  };
}
