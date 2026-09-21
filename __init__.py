"""Provider Usage: agent-side entry point.

Unified Hermes plugin:

- ``desktop/plugin.js``: the desktop status-bar UI half.
- ``dashboard/plugin_api.py``: backend router (mounted at
  ``/api/plugins/provider-usage/``); reads local provider credentials
  read-only and serves one aggregate usage payload.

The agent side intentionally registers nothing; this module exists so the
package is a well-formed Hermes plugin.
"""


def register(ctx):
    """Inert by design: all functionality lives in the desktop and dashboard halves."""
    return None
