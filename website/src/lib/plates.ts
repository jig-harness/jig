/**
 * Every drawn plate under public/plates/ and its width to height ratio.
 * `Plate.astro` draws them; a new plate is added here.
 */
export const PLATES = {
  jig: 1.79,
  "jig-1": 1.79,
  "jig-2": 1.79,
  "jig-3": 1.79,
  "jig-4": 1.79,
  "jig-5": 1.79,
  "jig-6": 1.79,
  "jig-7": 1.79,
  "jig-8": 1.79,
  hall: 1.79,
  map: 1,
  gauge: 1.79,
  catalog: 1,
  drafting: 1.79,
  line: 3.03,
  flywheel: 1.79,
  lever: 1.79,
  slab: 1.79,
  engine: 1.79,
  toolwall: 1.79,
  theodolite: 1,
  crate: 1,
  sieves: 1,
  ratchet: 1,
  ledger: 1,
  pantograph: 1,
  stepladder: 1,
  spindle: 1,
  bays: 1,
  stencils: 1,
  scraper: 1,
  wrenches: 1,
  numberer: 1.79,
} as const;

export type PlateName = keyof typeof PLATES;

/**
 * The home page's jig, as the frames of one sequence: the exploded assembly
 * first, then the parts seating and the clamp closing, played by scrolling
 * (`PlateSequence.astro`). One frame stands alone as the still plate.
 */
export const JIG_FRAMES: readonly PlateName[] = [
  "jig",
  "jig-1",
  "jig-2",
  "jig-3",
  "jig-4",
  "jig-5",
  "jig-6",
  "jig-7",
  "jig-8",
];
