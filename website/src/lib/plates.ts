/**
 * Every drawn plate under public/plates/ and its width to height ratio.
 * `Plate.astro` draws them; a new plate is added here.
 */
export const PLATES = {
  "jig-still": 0.9,
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
