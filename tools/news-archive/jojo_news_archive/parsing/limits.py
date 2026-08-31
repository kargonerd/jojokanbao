"""Publisher-neutral parser thresholds.

Keeping these values outside the parser engine lets source strategies share
the defaults without importing the orchestration pipeline.
"""

MINIMUM_BODY_CHARACTERS = 100
MINIMUM_SYNDICATED_BODY_CHARACTERS = 400
