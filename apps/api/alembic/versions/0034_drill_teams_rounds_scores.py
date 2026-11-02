"""Competition teams, rounds and the score ledger.

Adds ``drill_teams``, ``drill_rounds`` and ``drill_score_events``, plus the nullable links
``drill_participants.drill_team_id`` and ``drill_invitations.drill_team_id``. Everything is
additive: drills without teams keep working exactly as before.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0034_drill_teams_rounds_scores"
down_revision = "0033_restore_v1_flag_submissions"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column in {c["name"] for c in inspector.get_columns(table)}


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "drill_teams" not in existing:
        op.create_table(
            "drill_teams",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "drill_id",
                sa.Integer(),
                sa.ForeignKey("drills.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("name", sa.String(64), nullable=False),
            sa.Column("color", sa.String(16)),
            sa.Column("position", sa.Integer(), nullable=False, server_default="1"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("drill_id", "name", name="uq_drill_teams_name"),
            sa.UniqueConstraint("drill_id", "position", name="uq_drill_teams_position"),
        )
    if "drill_rounds" not in existing:
        op.create_table(
            "drill_rounds",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "drill_id",
                sa.Integer(),
                sa.ForeignKey("drills.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("number", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(64), nullable=False),
            sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
            sa.Column("assignments", sa.JSON(), nullable=False),
            sa.Column("started_at", sa.DateTime(timezone=True)),
            sa.Column("ended_at", sa.DateTime(timezone=True)),
            sa.Column("freeze_at", sa.DateTime(timezone=True)),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("drill_id", "number", name="uq_drill_rounds_number"),
        )
    if "drill_score_events" not in existing:
        op.create_table(
            "drill_score_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "drill_id",
                sa.Integer(),
                sa.ForeignKey("drills.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "round_id", sa.Integer(), sa.ForeignKey("drill_rounds.id", ondelete="SET NULL")
            ),
            sa.Column(
                "team_id", sa.Integer(), sa.ForeignKey("drill_teams.id", ondelete="SET NULL")
            ),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
            sa.Column("kind", sa.String(24), nullable=False),
            sa.Column("points", sa.Integer(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False, server_default=""),
            sa.Column("flag_id", sa.Integer()),
            sa.Column("created_by", sa.String(64)),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            "ix_drill_score_events_drill_round", "drill_score_events", ["drill_id", "round_id"]
        )
        op.create_index("ix_drill_score_events_team", "drill_score_events", ["drill_id", "team_id"])
    for table in ("drill_participants", "drill_invitations"):
        if not _has_column(table, "drill_team_id"):
            with op.batch_alter_table(table) as batch:
                batch.add_column(
                    sa.Column(
                        "drill_team_id",
                        sa.Integer(),
                        sa.ForeignKey(
                            "drill_teams.id", ondelete="SET NULL", name=f"fk_{table}_drill_team"
                        ),
                    )
                )


def downgrade() -> None:
    for table in ("drill_invitations", "drill_participants"):
        if _has_column(table, "drill_team_id"):
            with op.batch_alter_table(table) as batch:
                batch.drop_column("drill_team_id")
    for table in ("drill_score_events", "drill_rounds", "drill_teams"):
        if table in sa.inspect(op.get_bind()).get_table_names():
            op.drop_table(table)
