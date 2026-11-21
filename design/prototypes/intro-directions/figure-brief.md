# Brief for the next session: the figure and step 3

Ophir's verdict of 2026-11-21 on the first figure, in his words, then what each
point asks for. The next session draws the figure again in the same style
(isometric engraving, ink on warm paper, hatching, one green; a motion-kit scene
on the isometric kit) and rewrites step 3's copy. It does not reopen the picked
layout ([README.md](README.md)).

> I think having the line shown as a loop is misleading. Followup does go to
> pickup, but it constitutes the minority of pickups (I hope). The queue for
> pickup is missing. I'd like to have a good representation of how an issue
> turns into a PR (we start out with an issue, it then gets a PR, then the PR
> gets comments + build status, then all turn green, then the PR gets merged
> etc). The item (simply represented as a box right now) is morphing and its
> state is important to the process.

> The wall: "two slots per account" etc. — don't mention exact numbers and
> don't mention multiple-account support at all. This concept should just focus
> on how Jig takes capacity into account: token budgets, memory, `CPU`, disk,
> rate limits etc.

## What the figure must change

1. **The line is not a loop.** Draw seven stations in order, from Pick up to
   Follow up. Follow up reaches Pick up as a short side feed, not a closed track.
   It is the minority path, so it is drawn lighter than the main line. Ophir
   hopes most pickups come from elsewhere; check the claim against the
   dispatcher's records before the page states a proportion, and state none
   unless a check derives it.
2. **Draw the pickup queue.** Items wait in front of Pick up. The queue is
   where work enters; the dispatcher takes from it as capacity allows.
3. **The item morphs.** The box becomes a drawing whose form shows its state, in
   this order: an issue; an issue with a pull request; the pull request with
   review comments and build status; the pull request with every check green;
   merged. The next session settles the form of each (for example a card, a
   sheet with comment marks, a sheet with check marks, a stamped sheet). Each
   state must read in greyscale: shape and mark, not hue.
4. **A person's moments stay distinct.** The merge, and the answer to a parked
   question, keep the person's mark from the first figure (the green solid with
   a figure on it). An agent never draws that mark.
5. **Same style, same kit.** The gate passes every scene rule. Settled steps
   only, no loop, no ambient motion, at most 12 seconds and 8 as the target.
   Both wide and tall layouts, as before.

## What step 3 becomes

Step 3 is no longer "Two slots per account, and the wall." The wall is how the
dispatcher takes capacity into account. Rules:

- No exact number: no count of slots, minutes or limits.
- No mention of more than one account.
- Capacity is the subject: token budgets, memory, processor load, disk and
  rate limits, as far as each is true.

What is verified in the checkout, to write against (check again at the build):

| Signal | Where | Status |
|--------|-------|--------|
| Processor load and free memory of the host | `plugin/shared/host-load.ts`, read by the resource lock and the dispatcher's load factor | read today |
| A usage limit, the wall, after which an account is left out of every launch | GLOSSARY.md, "Wall" | read today |
| A cap on sessions at once | GLOSSARY.md, "Slot" | read today; do not state the count |
| Disk | not found in `plugin/dispatch` or `plugin/shared` in the first search | unverified: find it or leave it out |
| A token budget as such | not found as a separate signal; the usage limit is the nearest | unverified: find it or leave it out |
| Rate limits of a tracker or forge | `design/outbound-calls.md`, the shared budget | read today |

A claim the checkout does not support stays out of the copy until it does, as
the capability table requires
([design/website.md](../../website.md#capability-placement-and-claim-status)).
The planned mark on step 2 ("Machinery ships. Running unattended is planned.")
stays.

## Open in the copy

The headline, the checkable sentence, steps 1, 2, 4 and 5 and the close are as
in [briefs/brief.md](briefs/brief.md). Step 1 says "Seven stations, run as a
loop." and "The follow-up sends what the merge owes back to the first." Both
need rewording once the line is not a loop; the follow-up still reaches pickup,
as a side path.
