/**
 * The observability port: typed events, metrics and spans
 * ([design/control-plane.md § Observability](../../../design/control-plane.md#observability)).
 *
 * The core emits; the adapter exports (structured logs and the metrics
 * `health` serves, the platform's own logs, OTLP when a collector is set).
 * What telemetry carries is codes, ids, counts, durations, target names
 * and versions, so a field is a string, a number or a boolean: never a
 * request's or a delivery's body, a header, a token or comment text, and a
 * failure travels as its code, never its `reason` or `cause`. A defect is
 * the one exception: its stack goes to the adapter's own error log.
 */
import type { Defect, Outcome } from "../../shared/outcome.ts";
import type { UnitContext } from "./unit.ts";

/** A telemetry field's value: a code, an id, a count, a duration. */
export type Field = string | number | boolean;

/** One typed event: a name the hub's event registry declares, and its fields. */
export interface HubEvent {
  readonly name: string;
  readonly at: number;
  /** The failure's code, when the event reports one. */
  readonly code?: string;
  readonly fields: Readonly<Record<string, Field>>;
}

/** One sample of a metric the hub's metric registry declares. */
export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly at: number;
  readonly labels: Readonly<Record<string, string>>;
}

/** One finished span: what ran, from when to when, and how it ended. */
export interface Span {
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** The failure's code; absent when it succeeded. */
  readonly code?: string;
  readonly fields: Readonly<Record<string, Field>>;
}

/**
 * Emitting never waits: an adapter buffers or drops, and says it dropped
 * through its own metrics. A failed outcome is the export refused, which
 * the core does not retry.
 */
export interface ObservabilityPort {
  event(context: UnitContext, event: HubEvent): Outcome<void>;
  metric(context: UnitContext, sample: MetricSample): Outcome<void>;
  span(context: UnitContext, span: Span): Outcome<void>;
  /** A defect a unit's boundary caught, for the adapter's error log with its stack. */
  defect(context: UnitContext, defect: Defect): Outcome<void>;
}
