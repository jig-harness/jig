#!/usr/bin/env bash
# ^apps/.*$ is behaviorally identical to the supported directory form
# ^apps/.* — a greedy .* already consumes to the end of the string, so a
# trailing $ after it adds no constraint. This must normalize and pass the
# same way ^apps/.* does, not be treated as a distinct or rejected form.
CODE_PATH_RE='^apps/.*$'
