"""Add the persistent single-environment drill lock.

Revision ID: 0030_drill_environment_lock
Revises: 0029_run_timeout_min
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0030_drill_environment_lock"
down_revision = "0029_run_timeout_min"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "drill_environment_locks" not in inspector.get_table_names():
        op.create_table(
            "drill_environment_locks",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("lock_key", sa.String(length=32), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("owner_sub", sa.String(length=64), nullable=True),
            sa.Column("owner_role", sa.String(length=32), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="released"),
            sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("lock_key", name="uq_drill_environment_locks_key"),
        )
        op.create_index("idx_drill_environment_locks_status", "drill_environment_locks", ["status"])
    op.execute(
        sa.text(
            "INSERT INTO drill_environment_locks (lock_key, status) "
            "SELECT 'default', 'released' WHERE NOT EXISTS "
            "(SELECT 1 FROM drill_environment_locks WHERE lock_key = 'default')"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    if "drill_environment_locks" in sa.inspect(bind).get_table_names():
        op.drop_index("idx_drill_environment_locks_status", table_name="drill_environment_locks")
        op.drop_table("drill_environment_locks")
