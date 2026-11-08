"""Self-made py spider that always fails, for crash-isolation assertions.

Used by tests/e2e/p1.py: one broken site must not take down the other sources
or the adapter.
"""


class Spider:
    def __init__(self, ext):
        raise RuntimeError("broken py spider: intentional failure")

    def homeContent(self, filter):  # noqa: A002 - never reached
        return {}
