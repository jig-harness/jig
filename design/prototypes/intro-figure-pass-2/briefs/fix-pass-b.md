# Fix pass for candidate B: three changes

From the coordinator's render-and-look of the first pass (wide and tall, light).
Fix these three and nothing else. Keep the files, names and formats of the brief.

1. **The item is not on the line.** In every step the item is drawn in an inset
   at the top left of the frame, and only a tiny thing moves on the bench.
   Draw the item itself on the bench at the station that acts, large enough to
   read its form (the issue, the pull request with its comments and marks, the
   checks, the merged form). The inset goes. The scene must fill the frame: in
   the wide frames the line is now under 65 % of the frame's width and its agents
   are about 40 px tall; make them at least 1.5 times larger.
2. **The agents are one body with different tools, and their poses barely
   differ.** In `agents.svg` rest, reach and act look nearly the same for every
   agent. Give at least four of the stations a different kind of body (a gantry
   crawler, a trolley with a boom, a press carriage, a wheeled rover, a probe on
   a tripod...) and make the three poses visibly different: rest = stowed, reach
   = extended toward the item, act = the tool on the item.
3. **Step 8 does not show the wall, and labels collide.** The capacity frame
   shows four small dials in a corner and a label "Usage limit" sitting on an
   agent. Draw the wall across the line (a hatched wall with an issue waiting in
   front of it), the four gauges as objects on the plate, and the dispatcher
   reading them. In every frame "Pick up", "Dispatcher" and "Queue" overlap each
   other or an agent, and the labels in the tall frames float beside the line:
   give each label a short leader to what it names and keep every label clear of
   agents and of other labels.

Report what you changed and anything you expect not to render as intended. Your
own look is not evidence; the coordinator will render again.
