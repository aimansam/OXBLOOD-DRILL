"""Alembic environment.

Loads DB URL from the live Settings (so production migrations respect
DIVIDE_DB_URL), and uses our SQLAlchemy metadata as the autogenerate target.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool
from sqlalchemy.engine import make_url

from app.core.config import get_settings
from app.db.base import Base
from app.db import models  # noqa: F401  — registers all tables on Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Use the installed synchronous driver explicitly; SQLAlchemy's PostgreSQL
# default driver may change independently of the image's installed packages.
settings = get_settings()
sync_url = make_url(settings.db_url)
if sync_url.drivername in {"postgresql", "postgresql+asyncpg"}:
    sync_url = sync_url.set(drivername="postgresql+psycopg2")
elif sync_url.drivername == "sqlite+aiosqlite":
    sync_url = sync_url.set(drivername="sqlite")
config.set_main_option("sqlalchemy.url", sync_url.render_as_string(hide_password=False).replace("%", "%%"))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
