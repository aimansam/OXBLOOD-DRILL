"""Rename oxblood flag_submissions to drill_flag_submissions.

Revision ID: 0023
down_revision: 0022

v1 models.flag_submissions (run_id, flag_id, team) and the oxblood v2
model shared one table name; 0022's drop/recreate destroyed whichever
came first. This gives the v2 table its own name and re-points its FK
at drill_flags (Learn lab_flags are gone from Drill).
"""
import sqlalchemy as sa
from alembic import op

revision = '0023_drill_flag_submissions'
down_revision = '0022_update_flag_submissions_v2'
branch_labels = None
depends_on = None


def upgrade() -> None:
    names = sa.inspect(op.get_bind()).get_table_names()
    if 'flag_submissions' in names and 'drill_flag_submissions' not in names:
        # Upgraded DB where 0022 already recreated the v2 table.
        op.rename_table('flag_submissions', 'drill_flag_submissions')
    elif 'flag_submissions' in names and 'drill_flag_submissions' in names:
        # Live Drill DB already renamed by hand (cutover) — nothing to do.
        pass
    # v1's table was dropped by 0022 on upgraded DBs — recreate it so v1
    # drills keep working. On fresh installs 0005 already created it.
    names = sa.inspect(op.get_bind()).get_table_names()
    # Live Drill DB already cut over: drill_flag_submissions exists with
    # data and v1 flag_submissions was dropped by the purge. Alembic's
    # version table may still sit at 0022 — stamp 0023 without DDL.
    if 'drill_flag_submissions' in names and 'flag_submissions' not in names:
        return
    if 'flag_submissions' not in names and 'runs' in names:
        op.create_table(
            'flag_submissions',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('run_id', sa.Integer(), sa.ForeignKey('runs.id', ondelete='CASCADE'), nullable=False),
            sa.Column('flag_id', sa.String(64), nullable=False),
            sa.Column('team', sa.String(16), nullable=False),
            sa.Column('submitted_by', sa.String(64), nullable=False),
            sa.Column('captured_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('points', sa.Integer(), nullable=False),
            sa.Column('elapsed_seconds', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.UniqueConstraint('run_id', 'flag_id', 'team', name='uq_flag_submissions_run_flag_team'),
        )
        op.create_index('ix_flag_submissions_run_id', 'flag_submissions', ['run_id'])
        op.create_index('ix_flag_submissions_team', 'flag_submissions', ['team'])


def downgrade() -> None:
    names = sa.inspect(op.get_bind()).get_table_names()
    if 'flag_submissions' in names:
        op.drop_table('flag_submissions')
    if 'drill_flag_submissions' in names:
        op.rename_table('drill_flag_submissions', 'flag_submissions')
