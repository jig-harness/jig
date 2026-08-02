#!/usr/bin/env bash
# A paths: key with separation whitespace before the colon (paths :) is
# valid YAML and decodes to the same key as the tight-colon form — the
# scanner must still recognize it as the area's paths declaration, not
# silently skip the whole area as though it never declared one.
CODE_PATH_RE='^apps/'
