"""Backfill OxBlood drill scenario link rows.

Revision ID: 0027_oxblood_link_backfill
Revises: 0026_oxblood_runtime_fix
Create Date: 2026-09-10
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0027_oxblood_link_backfill"
down_revision = "0026_oxblood_runtime_fix"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()
    if "drills" not in tables or "drill_scenarios" not in tables:
        return

    drill_cols = {c["name"] for c in inspector.get_columns("drills")}
    link_cols = {c["name"] for c in inspector.get_columns("drill_scenarios")}
    required_link_cols = {"drill_id", "scenario_id", "scenario_config", "is_active"}
    if "scenario_id" not in drill_cols or not required_link_cols.issubset(link_cols):
        return

    empty_config = "'{}'::json" if bind.dialect.name == "postgresql" else "'{}'"
    op.execute(
        sa.text(
            "INSERT INTO drill_scenarios "
            "(drill_id, scenario_id, scenario_config, is_active) "
            f"SELECT d.id, d.scenario_id, {empty_config}, true "
            "FROM drills d "
            "WHERE d.scenario_id IS NOT NULL "
            "AND NOT EXISTS ("
            "  SELECT 1 FROM drill_scenarios ds "
            "  WHERE ds.drill_id = d.id "
            "  AND ds.scenario_id = d.scenario_id"
            ")"
        )
    )


def downgrade() -> None:
    # Data backfill only. Keep links; deleting them would remove user-visible
    # scenario associations for existing drills.
    pass
