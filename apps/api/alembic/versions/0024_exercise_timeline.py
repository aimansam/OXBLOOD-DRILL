"""Exercise-timeline + briefing migration (0024).

Revision ID: 0024
down_revision: 0023_drill_flag_submissions

- drill_objectives.status (pending/in-progress/completed), default pending.
- drill_events table: unified per-drill timeline (lifecycle, submissions,
  announcements, lead notes). Lets the portal render one chronological
  exercise feed instead of stitching audit + announcements client-side.
"""
from alembic import op
import sqlalchemy as sa


revision = '0024_exercise_timeline'
down_revision = '0023_drill_flag_submissions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    names = sa.inspect(bind).get_table_names()
    if 'drill_objectives' in names:
        cols = [c['name'] for c in sa.inspect(bind).get_columns('drill_objectives')]
        if 'status' not in cols:
            op.add_column(
                'drill_objectives',
                sa.Column('status', sa.String(20), nullable=False, server_default='pending'),
            )
    if 'drill_events' not in names:
        op.create_table(
            'drill_events',
            sa.Column('id', sa.Integer(), primary_key=True),
            sa.Column('drill_id', sa.Integer(), sa.ForeignKey('drills.id', ondelete='CASCADE'), nullable=False),
            sa.Column('kind', sa.String(40), nullable=False),
            sa.Column('title', sa.String(255), nullable=False),
            sa.Column('detail', sa.Text(), nullable=True),
            sa.Column('side', sa.String(20), nullable=True),
            sa.Column('actor', sa.String(255), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Index('idx_drill_events_drill', 'drill_id'),
            sa.Index('idx_drill_events_kind', 'kind'),
        )


def downgrade() -> None:
    op.drop_table('drill_events')
    bind = op.get_bind()
    names = sa.inspect(bind).get_table_names()
    if 'drill_objectives' in names:
        cols = [c['name'] for c in sa.inspect(bind).get_columns('drill_objectives')]
        if 'status' in cols:
            op.drop_column('drill_objectives', 'status')
