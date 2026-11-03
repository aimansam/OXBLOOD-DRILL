"""Range copies: ``snapshot_baselines.instance``.

A match copy of a scenario needs its own VMs and snapshots, so a baseline is unique per
(scenario, instance, role). Existing rows become instance 1.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0036_baseline_instance"
down_revision = "0035_team_captain"
branch_labels = None
depends_on = None

OLD = "uq_snapshot_baselines_scenario_role"
NEW = "uq_snapshot_baselines_scenario_instance_role"


def _indexes() -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes("snapshot_baselines")}


def _has_instance() -> bool:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("snapshot_baselines")}
    return "instance" in cols


def upgrade() -> None:
    if not _has_instance():
        with op.batch_alter_table("snapshot_baselines") as batch:
            batch.add_column(
                sa.Column("instance", sa.Integer(), nullable=False, server_default="1")
            )
    if OLD in _indexes():
        op.drop_index(OLD, table_name="snapshot_baselines")
    if NEW not in _indexes():
        op.create_index(NEW, "snapshot_baselines", ["scenario_id", "instance", "role"], unique=True)


def downgrade() -> None:
    if NEW in _indexes():
        op.drop_index(NEW, table_name="snapshot_baselines")
    if OLD not in _indexes():
        op.create_index(OLD, "snapshot_baselines", ["scenario_id", "role"], unique=True)
    if _has_instance():
        with op.batch_alter_table("snapshot_baselines") as batch:
            batch.drop_column("instance")
