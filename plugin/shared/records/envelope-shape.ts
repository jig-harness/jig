/** The envelope's structural fields; registry checks and calendar-time checks stay at the codec boundary. */
import { s } from "../shapes.ts";
import type { RecordKind } from "./registry.ts";
import { WRITER_SHAPE } from "./writer-shape.ts";

export const ENVELOPE_SHAPES = {
  kind: s.string(),
  v: s.integer({ minimum: 1 }),
  key: s.string(),
  writer: WRITER_SHAPE,
  at: s.string({
    pattern:
      "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
  }),
  generation: s.optional(s.integer({ minimum: 0 })),
};

/** The envelope of one registered kind, including the versions and keys it accepts. */
export function envelopeShape(kind: RecordKind) {
  return s.object({
    ...ENVELOPE_SHAPES,
    kind: s.literal(kind.name),
    v: s.integer({ minimum: 1, maximum: kind.version }),
    key: s.string({ pattern: kind.key?.source ?? "(?!)" }),
  });
}

/** Common structure only: a kind's versions and key grammar belong to its own contract. */
export const ENVELOPE_SHAPE = s.object(ENVELOPE_SHAPES);
