"""Add run.timeout to audit_action enum

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-01

"""
from alembic import op

revision = '0021_audit_run_timeout'
down_revision = '0020_audit_run_extended'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add 'run.timeout' to the audit_action enum
    try:
        _is_pg = op.get_bind().dialect.name == 'postgresql'
    except Exception:
        _is_pg = True
    if _is_pg:
        op.execute("ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'run.timeout'")


def downgrade() -> None:
    # Cannot remove values from an enum in PostgreSQL
    pass
