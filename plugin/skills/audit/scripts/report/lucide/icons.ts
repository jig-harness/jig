/**
 * The Lucide icons the audit sheet draws, vendored: Lucide 1.33.0
 * (https://lucide.dev), ISC licence, with the icons Lucide took from Feather
 * under the MIT licence; both notices are in LICENSE in this directory. Keep
 * it with this file.
 *
 * Each drawing is Lucide's own, unchanged: the elements of one icon on its
 * 24 × 24 grid. The sheet defines each icon once, as a symbol in a hidden
 * sprite at the top of the page, and every use points at it inside the same
 * file, so drawing an icon loads nothing. Lucide's stroke (the current text
 * colour, width 2, round caps and joins) is set by the sheet's stylesheet.
 */

/** Lucide's drawing of each icon the sheet uses, by Lucide's name. */
const DRAWINGS = {
  "circle-dashed":
    '<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>',
  "file-text":
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  "shield-check":
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  "circle-slash":
    '<circle cx="12" cy="12" r="10"/><line x1="9" x2="15" y1="15" y2="9"/>',
  "circle-question-mark":
    '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
} as const;

export type IconName = keyof typeof DRAWINGS;

const symbolId = (name: IconName) => `lc-${name}`;

/** The hidden sprite: every icon once, as a symbol the uses point at. */
export function iconSprite(): string {
  const symbols = (Object.keys(DRAWINGS) as IconName[])
    .map(
      (name) =>
        `<symbol id="${symbolId(name)}" viewBox="0 0 24 24">${DRAWINGS[name]}</symbol>`,
    )
    .join("");
  return `<svg class="sprite" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

/** One icon, drawn from the sprite. Decorative: the text beside it, or its container's label, names it. */
export const icon = (name: IconName) =>
  `<svg class="ic" aria-hidden="true"><use href="#${symbolId(name)}"/></svg>`;
