/**
 * The process adapter's serving port: binds the three listeners the
 * settings name (`listeners.ts`), each with its own handler, and holds
 * them until the serving context's signal aborts. `/v1/` binds each of its
 * loopback and private-network addresses, never every interface; the
 * webhook listener binds its own address; the feed binds its Unix socket,
 * in the directory the host side made for it (`host-paths.ts`), or loopback
 * with the front's secret.
 */
import { ok, type Outcome } from "../../shared/outcome.ts";
import type { HubPorts } from "../core/ports.ts";
import type { ServingPort } from "../core/serving.ts";
import {
  type BoundListener,
  type ListenerSpec,
  startListener,
} from "./listeners.ts";
import type { HubSettings } from "./settings.ts";

/** The listeners the settings name, without their handlers yet. */
function listenerBinds(
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
  if ("socket" in feed)
    specs.push({
      name: "feed",
      bind: { unix: feed.socket, open: feed.group !== null },
    });
  else
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
