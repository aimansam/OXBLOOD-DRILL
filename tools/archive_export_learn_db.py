"""Export Learn-owned tables from the Drill DB into a fresh Learn DB.

Usage (inside the api container, Drill DB reachable):
  DIVIDE_DB_URL=postgresql+asyncpg://... \\
  DIVIDE_LEARN_DB_URL=postgresql+asyncpg://... \\
    python tools/export_learn_db.py

Copies, in FK-safe order:
  users, user_profiles, sessions, password_reset_tokens,
  user_activity_logs, badges, user_badges, teams, team_memberships,
  team_invitations, team_statistics, lab_categories, tags, labs,
  lab_tags, target_machines, lab_objectives, lab_flags, lab_hints,
  lab_files, learning_paths, learning_path_modules, learning_path_labs,
  user_learning_progress, lab_skills, system_notifications,
  user_notifications, platform_settings

Drill-owned tables (drills, submissions, scores, reports, ...) are NOT
copied. drills.lab_id keeps its integer value as a read-only reference.
Idempotent: re-running upserts by primary key (Postgres ON CONFLICT
DO NOTHING). Verify row counts match before pointing Learn at the new DB.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

LEARN_TABLES = [
    "users",
    "user_profiles",
    "sessions",
    "password_reset_tokens",
    "user_activity_logs",
    "badges",
    "user_badges",
    "teams",
    "team_memberships",
    "team_invitations",
    "team_statistics",
    "lab_categories",
    "tags",
    "labs",
    "lab_tags",
    "target_machines",
    "lab_objectives",
    "lab_flags",
    "lab_hints",
    "lab_files",
    "learning_paths",
    "learning_path_modules",
    "learning_path_labs",
    "user_learning_progress",
    "lab_skills",
    "system_notifications",
    "user_notifications",
    "platform_settings",
]


def _sync_url(url: str) -> str:
    return url.replace("+asyncpg", "").replace("+aiosqlite", "")


async def main() -> int:
    try:
        from sqlalchemy import MetaData, text
        from sqlalchemy.ext.asyncio import create_async_engine
    except ImportError:
        print("sqlalchemy[asyncio] + asyncpg required", file=sys.stderr)
        return 2

    src = os.environ.get("DIVIDE_DB_URL")
    dst = os.environ.get("DIVIDE_LEARN_DB_URL")
    if not src or not dst:
        print("Set DIVIDE_DB_URL and DIVIDE_LEARN_DB_URL", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(description="Export Learn tables to Learn DB")
    parser.add_argument("--dry-run", action="store_true", help="print row counts only")
    args = parser.parse_args()

    src_eng = create_async_engine(src, future=True)
    dst_eng = create_async_engine(dst, future=True)
    try:
        async with src_eng.connect() as sconn, dst_eng.connect() as dconn:
            # Create Learn tables on target from shared metadata (Learn subset).
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))
            from app.db.models_oxblood import Base as OxBase  # noqa: E402

            learn_meta = MetaData()
            for t in LEARN_TABLES:
                if t in OxBase.metadata.tables:
                    OxBase.metadata.tables[t].to_metadata(learn_meta)
            await dconn.run_sync(learn_meta.create_all)
            await dconn.commit()

            counts: dict[str, int] = {}
            for t in LEARN_TABLES:
                r = await sconn.execute(text(f'SELECT COUNT(*) FROM \"{t}\"'))
                counts[t] = r.scalar() or 0
            print("source counts:")
            for t, c in counts.items():
                print(f"  {t}: {c}")
            if args.dry_run:
                return 0
            for t in LEARN_TABLES:
                # Chunked copy via server-side read + executemany insert.
                res = await sconn.execute(text(f'SELECT * FROM \"{t}\"'))
                rows = res.mappings().all()
                if not rows:
                    continue
                cols = list(rows[0].keys())
                collist = ", ".join(f'\"{c}\"' for c in cols)
                placeholders = ", ".join(f":{c}" for c in cols)
                # ON CONFLICT DO NOTHING needs a PK; fall back to plain insert
                # if the table lacks one (none of the Learn tables do).
                await dconn.execute(text("SELECT 1"))
                for i in range(0, len(rows), 500):
                    chunk = [dict(r) for r in rows[i : i + 500]]
                    await dconn.execute(
                        text(
                            f'INSERT INTO \"{t}\" ({collist}) VALUES ({placeholders}) '
                            f"ON CONFLICT DO NOTHING"
                        ),
                        chunk,
                    )
                await dconn.commit()
                print(f"copied {t}: {len(rows)} rows")
            return 0
    finally:
        await src_eng.dispose()
        await dst_eng.dispose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
