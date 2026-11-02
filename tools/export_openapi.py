#!/usr/bin/env python3
"""Write the API's OpenAPI document to apps/web/openapi.json (stable key order).

The web client's types are generated from this file, so CI regenerates it and
fails on a diff: an API change that affects the UI must update the file.

    python3 tools/export_openapi.py            # write
    python3 tools/export_openapi.py --check    # exit 1 if the file is out of date
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "apps" / "web" / "openapi.json"


def render() -> str:
    # Importing the app must not need a database or Redis.
    os.environ.setdefault("DIVIDE_DB_URL", "sqlite+aiosqlite:///:memory:")
    sys.path.insert(0, str(REPO / "apps" / "api"))
    from app.main import app

    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if the file differs")
    args = parser.parse_args()
    text = render()
    if args.check:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"{OUT.relative_to(REPO)} is out of date; run tools/export_openapi.py")
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(REPO)} ({len(text) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
