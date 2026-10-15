"""Repair OxBlood scenario links and flag audit enum.

Revision ID: 0026_oxblood_runtime_fix
Revises: 0025_pve_clone_storage
Create Date: 2026-09-10
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0026_oxblood_runtime_fix"
down_revision = "0025_pve_clone_storage"
branch_labels = None
depends_on = None


def _safe_add_audit_action(enum_value: str) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    try:
        op.execute(sa.text(f"ALTER TYPE audit_action ADD VALUE '{enum_value}'"))
    except Exception:  # noqa: BLE001
        # Postgres before v15 has no portable IF NOT EXISTS here; the
        # expected re-run failure is DuplicateObject, and leaving the value
        # present is exactly the desired end state.
        pass


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = inspector.get_table_names()

    _safe_add_audit_action("flag.planted")

    if "drill_scenarios" in tables:
        cols = {c["name"] for c in inspector.get_columns("drill_scenarios")}
        if "scenario_id" not in cols:
            op.add_column(
                "drill_scenarios",
                sa.Column("scenario_id", sa.Integer(), nullable=True),
            )
            cols.add("scenario_id")
        if "drills" in tables:
            drill_cols = {c["name"] for c in inspector.get_columns("drills")}
            required_link_cols = {
                "drill_id",
                "scenario_id",
                "scenario_config",
                "is_active",
            }
            if "scenario_id" in drill_cols and required_link_cols.issubset(cols):
                if bind.dialect.name == "postgresql":
                    empty_config = "'{}'::json"
                else:
                    empty_config = "'{}'"
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
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "drill_scenarios" in inspector.get_table_names():
        cols = {c["name"] for c in inspector.get_columns("drill_scenarios")}
        if "scenario_id" in cols:
            op.drop_column("drill_scenarios", "scenario_id")
    # No-op for audit_action: Postgres does not support dropping enum values
    # safely while data may reference them.
