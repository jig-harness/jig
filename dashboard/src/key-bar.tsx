/**
 * The keys the focused card answers to, in a bar at the foot of the screen:
 * what j and k landed on, and what o, p, i and c will do there. It floats over
 * the page, so it never moves a card, and it is not read aloud: the card is
 * already named, and Help lists every key.
 */
import { useFocusedCard } from "./keys.ts";

export function KeyBar() {
  const card = useFocusedCard();
  if (card === null) return null;
  return (
    <div className="keyBar" aria-hidden="true">
      <span className="barTarget m">{card.target}</span>
      {card.hints.map((h) => (
        <span className="barKey" key={h.key}>
          <kbd>{h.key}</kbd> {h.does}
        </span>
      ))}
      <span className="barKey mut">
        <kbd>j</kbd> <kbd>k</kbd> move
      </span>
    </div>
  );
}
