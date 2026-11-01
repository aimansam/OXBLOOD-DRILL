"""One-use invitation links for scheduled drill participants."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0032_drill_invitations"
down_revision = "0031_snapshot_baselines"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "drill_invitations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "drill_id", sa.Integer(), sa.ForeignKey("drills.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("redeemed_at", sa.DateTime(timezone=True)),
        sa.Column("redeemed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_drill_invitations_drill_id", "drill_invitations", ["drill_id"])


def downgrade() -> None:
    op.drop_table("drill_invitations")
