"""Separate matches: ``drill_teams.match_number`` and ``drill_team_flags``.

Teams that share a match number play on the same range copy. ``drill_team_flags`` holds the flag
value each team must find in each round when matches run on separate copies. Additive.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0037_matches"
down_revision = "0036_baseline_instance"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "match_number" not in {c["name"] for c in inspector.get_columns("drill_teams")}:
        with op.batch_alter_table("drill_teams") as batch:
            batch.add_column(
                sa.Column("match_number", sa.Integer(), nullable=False, server_default="1")
            )
    if "drill_team_flags" not in inspector.get_table_names():
        op.create_table(
            "drill_team_flags",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "drill_id",
                sa.Integer(),
                sa.ForeignKey("drills.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("round_number", sa.Integer(), nullable=False),
            sa.Column(
                "team_id",
                sa.Integer(),
                sa.ForeignKey("drill_teams.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("flag_name", sa.String(255), nullable=False),
            sa.Column("value", sa.String(255), nullable=False),
            sa.UniqueConstraint(
                "drill_id", "round_number", "team_id", "flag_name", name="uq_drill_team_flags_key"
            ),
        )
        op.create_index(
            "idx_drill_team_flags_value",
            "drill_team_flags",
            ["drill_id", "round_number", "value"],
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "drill_team_flags" in inspector.get_table_names():
        op.drop_index("idx_drill_team_flags_value", table_name="drill_team_flags")
        op.drop_table("drill_team_flags")
    if "match_number" in {c["name"] for c in inspector.get_columns("drill_teams")}:
        with op.batch_alter_table("drill_teams") as batch:
            batch.drop_column("match_number")
