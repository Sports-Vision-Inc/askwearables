"""Make the package importable when run as `python3 -m unittest discover sdks/python/tests` from the repo root."""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

OPENAPI = os.path.join(os.path.dirname(ROOT), "openapi.json")
