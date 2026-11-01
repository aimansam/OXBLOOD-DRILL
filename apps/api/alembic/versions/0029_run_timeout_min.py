"""Persist the resolved run watchdog duration.

Revision ID: 0029_run_timeout_min
Revises: 0028_pve_seed_snippet_storage
Create Date: 2026-09-22
"""

import sqlalchemy as sa
from alembic import op

revision = "0029_run_timeout_min"
down_revision = "0028_pve_seed_snippet_storage"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("runs")]
    if "timeout_min" not in cols:
        op.add_column("runs", sa.Column("timeout_min", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("runs")]
    if "timeout_min" in cols:
        op.drop_column("runs", "timeout_min")
