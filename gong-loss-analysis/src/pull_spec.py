"""Single source of truth for Gong request shapes. Verify field names with 00_setup_check.py --probe.
Two tiers, so heavy content is fetched ONLY for calls that matched a cohort deal:
  LIGHT_SELECTOR   -> 01_pull_calls.py  (every call in the window: metadata + parties + CRM context; small payload)
  CONTENT_SELECTOR -> 04_pull_content.py (matched meetings only: Gong brief/topics/trackers/interaction stats)
"""
LIGHT_SELECTOR = {
    "context": "Extended",
    "contextTiming": ["Now", "TimeOfCall"],
    "exposedFields": {"parties": True},
}
CONTENT_SELECTOR = {
    "context": "None",
    "exposedFields": {
        "content": {"structure": False, "topics": True, "trackers": True, "trackerOccurrences": False,
                     "pointsOfInterest": True, "brief": True, "outline": False, "highlights": True,
                     "callOutcome": True, "keyPoints": True},
        "interaction": {"speakers": True, "video": False, "personInteractionStats": True, "questions": True},
        "collaboration": {"publicComments": False},
        "media": False,
    },
}
