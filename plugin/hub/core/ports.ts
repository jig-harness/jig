/**
 * Everything the hub's portable core asks of its platform, as one object
 * an adapter builds and hands to the core
 * ([design/control-plane.md § The portable core and its adapters](../../../design/control-plane.md#the-portable-core-and-its-adapters)).
 *
 * Every port method takes the calling unit's `UnitContext` first, so one
 * signal and one deadline reach every call a unit makes, and returns an
 * `Outcome` (or a promise of one): a port's implementation turns what its
 * platform throws into a failure, and anything else it throws is a defect
 * the unit's boundary catches. The clock is injected beside the ports, so
 * the core reads no global time.
 *
 * `scripts/check-portability.ts` holds the core and every module it
 * imports to the portability rules: no `bun:` or `node:` module, no
 * package, no runtime global (`Bun`, `process`, `Deno`).
 */
import type { Clock } from "../../shared/clock.ts";
import type { ObservabilityPort } from "./observability.ts";
import type { OutboundPort } from "./outbound.ts";
import type { SchedulingPort } from "./scheduling.ts";
import type { ServingPort } from "./serving.ts";
import type { StoragePort } from "./storage.ts";

export interface HubPorts {
  readonly storage: StoragePort;
  readonly serving: ServingPort;
  readonly scheduling: SchedulingPort;
  readonly outbound: OutboundPort;
  readonly observability: ObservabilityPort;
  /** Epoch milliseconds; the adapter's clock, a test's pinned one. */
  readonly clock: Pick<Clock, "now">;
}
