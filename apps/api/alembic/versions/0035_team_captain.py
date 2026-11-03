"""Team captain.

Adds ``drill_teams.captain_user_id``: the member who submits Blue evidence answers. Nullable and
additive; a team without a captain keeps equal rights for everyone.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0035_team_captain"
down_revision = "0034_drill_teams_rounds_scores"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return column in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if _has_column("drill_teams", "captain_user_id"):
        return
    with op.batch_alter_table("drill_teams") as batch:
        batch.add_column(sa.Column("captain_user_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_drill_teams_captain_user_id",
            "users",
            ["captain_user_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    if not _has_column("drill_teams", "captain_user_id"):
        return
    with op.batch_alter_table("drill_teams") as batch:
        batch.drop_constraint("fk_drill_teams_captain_user_id", type_="foreignkey")
        batch.drop_column("captain_user_id")
