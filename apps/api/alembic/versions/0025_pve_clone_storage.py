"""Add clone storage to PVE runtime config.

Revision ID: 0025_pve_clone_storage
Revises: 0024_exercise_timeline
Create Date: 2026-09-09
"""

import sqlalchemy as sa
from alembic import op

revision = "0025_pve_clone_storage"
down_revision = "0024_exercise_timeline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("pve_config")]
    if "clone_storage" not in cols:
        op.add_column(
            "pve_config",
            sa.Column(
                "clone_storage",
                sa.String(length=64),
                nullable=False,
                server_default="local-lvm",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("pve_config")]
    if "clone_storage" in cols:
        op.drop_column("pve_config", "clone_storage")
