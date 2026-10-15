"""Add persistent scenario snapshot baselines.

Revision ID: 0031_snapshot_baselines
Revises: 0030_drill_environment_lock
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031_snapshot_baselines"
down_revision = "0030_drill_environment_lock"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "snapshot_baselines" in sa.inspect(bind).get_table_names():
        return
    op.create_table(
        "snapshot_baselines",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scenario_id", sa.Integer(), sa.ForeignKey("scenarios.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("scenario_version", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=64), nullable=False),
        sa.Column("template", sa.String(length=64), nullable=False),
        sa.Column("pve_vmid", sa.BigInteger(), nullable=False),
        sa.Column("pve_node", sa.String(length=64), nullable=False),
        sa.Column("snapshot_name", sa.String(length=40), nullable=False, server_default="clean-baseline"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ready"),
        sa.Column("source_run_id", sa.Integer(), sa.ForeignKey("runs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_snapshot_baselines_scenario_id", "snapshot_baselines", ["scenario_id"])
    op.create_index("ix_snapshot_baselines_status", "snapshot_baselines", ["status"])
    op.create_index("uq_snapshot_baselines_scenario_role", "snapshot_baselines", ["scenario_id", "role"], unique=True)
    op.create_index("uq_snapshot_baselines_vmid", "snapshot_baselines", ["pve_vmid"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    if "snapshot_baselines" in sa.inspect(bind).get_table_names():
        op.drop_table("snapshot_baselines")
