"""Restore the v1 flag_submissions table on databases that lost it.

0022 dropped v1 ``flag_submissions`` and 0023 was meant to recreate it, but
its "already cut over" early return also fires on a fresh upgrade (right
after renaming the v2 table), so migrated databases ended up without the
table that ``app.db.models.FlagSubmission`` and the v1 drills/debrief
routers use. Create it when it is missing; do nothing otherwise.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0033_restore_v1_flag_submissions"
down_revision = "0032_drill_invitations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    names = sa.inspect(op.get_bind()).get_table_names()
    if "flag_submissions" in names or "runs" not in names:
        return
    op.create_table(
        "flag_submissions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id", sa.Integer(), sa.ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("flag_id", sa.String(64), nullable=False),
        sa.Column("team", sa.String(16), nullable=False),
        sa.Column("submitted_by", sa.String(64), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("elapsed_seconds", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_flag_submissions_run_id", "flag_submissions", ["run_id"])
    op.create_index("ix_flag_submissions_team", "flag_submissions", ["team"])
    op.create_index(
        "uq_flag_submissions_run_flag_team",
        "flag_submissions",
        ["run_id", "flag_id", "team"],
        unique=True,
    )


def downgrade() -> None:
    # The table belongs to the v1 schema; leave it in place on downgrade.
    pass
