"""Database connectivity (lazy engines: Drill + Learn)."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.core.config import settings

_engine: AsyncEngine | None = None
_learn_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    """Drill product engine (DIVIDE_DB_URL)."""
    global _engine
    if _engine is None:
        _engine = create_async_engine(settings.db_url, echo=settings.db_echo, future=True)
    return _engine


def get_learn_engine() -> AsyncEngine:
    """Learn product engine (DIVIDE_LEARN_DB_URL, falls back to Drill engine).

    Back-compat: while Learn shares the Drill DB, both return the same
    engine. Once DIVIDE_LEARN_DB_URL is set, Learn routers talk to their
    own Postgres database and Learn tables can be dropped from Drill.
    """
    global _learn_engine
    if _learn_engine is None:
        if settings.learn_db_url:
            _learn_engine = create_async_engine(
                settings.learn_db_url, echo=settings.learn_db_echo, future=True
            )
        else:
            _learn_engine = get_engine()
    return _learn_engine


async def ping_db() -> None:
    from sqlalchemy import text

    engine = get_engine()
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
