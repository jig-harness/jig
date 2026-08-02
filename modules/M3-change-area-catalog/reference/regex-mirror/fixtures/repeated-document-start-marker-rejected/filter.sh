#!/usr/bin/env bash
# Two consecutive --- markers with nothing of substance between them are
# still a genuine second document, even though no real content appeared
# before the second one. Ruby's Psych.safe_load loads only the first,
# empty document as nil (verified directly), discarding the real areas:
# content just as completely as if real prose had come between the
# markers. Must be a hard error, not tolerated as a single leading marker.
CODE_PATH_RE='^apps/'
