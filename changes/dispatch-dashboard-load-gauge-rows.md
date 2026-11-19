---
release: minor
---

### Changed

- The dispatch dashboard's Running view shows every load gauge against its
  own line, with nothing to open. The headline names the load factor and the
  gauge that binds ("Load 150%, processors binds"), with one sentence saying
  the figure is the fullest gauge against its own line, not a sum. Under it
  each gauge has a row: its icon and name, a bar from 0 to 150% with its line
  marked at 100%, its percent, and what it read with its line. A gauge past
  its line turns the fill past the line to the alarm colour and shows an
  "over its line" warning, the gauge that binds is bold with a "binds" tag,
  and a gauge the host could not read shows an empty dashed bar and why. The
  launches the load held or would have held and each kind's memory
  reservation sit under the gauges in one fold titled with its count ("Would
  have held 2 launches · reservations"). On a phone what a gauge read moves
  under its bar.
