"""Add seed snippet storage to PVE runtime config.

Revision ID: 0028_pve_seed_snippet_storage
Revises: 0027_oxblood_link_backfill
Create Date: 2026-09-10
"""
import sqlalchemy as sa
from alembic import op

revision = "0028_pve_seed_snippet_storage"
down_revision = "0027_oxblood_link_backfill"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("pve_config")]
    if "seed_snippet_storage" not in cols:
        op.add_column(
            "pve_config",
            sa.Column(
                "seed_snippet_storage",
                sa.String(length=64),
                nullable=False,
                server_default="local",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    cols = [c["name"] for c in sa.inspect(bind).get_columns("pve_config")]
    if "seed_snippet_storage" in cols:
        op.drop_column("pve_config", "seed_snippet_storage")
