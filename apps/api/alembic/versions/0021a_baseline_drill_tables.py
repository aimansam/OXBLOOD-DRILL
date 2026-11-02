"""Baseline for the drill (v2) tables.

The drill tables (``drills``, ``scores``, ``submissions``, ...) were created
outside the migration chain (a hand-applied schema), so a database built only
from migrations never had them, and later migrations that reference ``drills``
failed on a fresh Postgres. Create whichever are missing, early in the chain;
tables that already exist are left untouched, so live installs (already past
this revision) are unaffected.

Revision ID: 0021a_baseline_drill_tables
Revises: 0021_audit_run_timeout
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0021a_baseline_drill_tables"
down_revision = "0021_audit_run_timeout"
branch_labels = None
depends_on = None

_TABLES = (
    "benchmarks",
    "drills",
    "benchmark_history",
    "drill_announcements",
    "drill_objectives",
    "drill_participants",
    "drill_scenarios",
    "reports",
    "score_history",
    "scores",
    "submissions",
    "drill_flags",
    "evidence_submissions",
    "report_findings",
    "report_submissions",
    "drill_flag_submissions",
    "evidence",
    "first_bloods",
    "submission_attempts",
)

_ENUMS = {
    "drill_status": ("scheduled", "active", "paused", "completed", "cancelled"),
    "evidence_type": (
        "screenshot",
        "command_output",
        "log_excerpt",
        "network_capture",
        "file",
        "other",
    ),
    "report_status": ("draft", "submitted", "under_review", "graded", "approved"),
    "severity_level": ("critical", "high", "medium", "low", "informational"),
    "submission_status": ("pending", "correct", "incorrect", "partial", "reviewed"),
}


def _enum(*values: str, name: str) -> sa.Enum | postgresql.ENUM:
    """PG enums are created once up front, so columns must not re-create them."""
    if op.get_bind().dialect.name == "postgresql":
        return postgresql.ENUM(*values, name=name, create_type=False)
    return sa.Enum(*values, name=name)


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if bind.dialect.name == "postgresql":
        for name, values in _ENUMS.items():
            postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)

    if "benchmarks" not in existing:
        op.create_table(
            "benchmarks",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("overall_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("offensive_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("defensive_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("web_exploitation_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column(
                "network_exploitation_score", sa.Numeric(precision=5, scale=2), nullable=False
            ),
            sa.Column("active_directory_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("linux_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("windows_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("forensics_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("reporting_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("total_drills_completed", sa.Integer(), nullable=False),
            sa.Column("total_flags_captured", sa.Integer(), nullable=False),
            sa.Column("average_completion_time_seconds", sa.Integer(), nullable=True),
            sa.Column(
                "last_calculated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_benchmarks_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_benchmarks")),
            sa.UniqueConstraint("user_id", name=op.f("uq_benchmarks_user_id")),
        )

    if "drills" not in existing:
        op.create_table(
            "drills",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("lab_id", sa.Integer(), nullable=True),
            sa.Column("scenario_id", sa.Integer(), nullable=True),
            sa.Column(
                "status",
                _enum(
                    "scheduled", "active", "paused", "completed", "cancelled", name="drill_status"
                ),
                nullable=False,
            ),
            sa.Column("drill_type", sa.String(length=50), nullable=False),
            sa.Column("scheduled_start_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("scheduled_end_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("actual_start_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("actual_end_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("duration_limit_minutes", sa.Integer(), nullable=True),
            sa.Column("max_participants", sa.Integer(), nullable=True),
            sa.Column("rules", sa.JSON(), nullable=False),
            sa.Column("environment_config", sa.JSON(), nullable=False),
            sa.Column("created_by", sa.Integer(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(
                ["created_by"],
                ["users.id"],
                name=op.f("fk_drills_created_by_users"),
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drills")),
        )
        op.create_index("idx_drills_lab", "drills", ["lab_id"], unique=False)
        op.create_index("idx_drills_scheduled", "drills", ["scheduled_start_at"], unique=False)
        op.create_index("idx_drills_status", "drills", ["status"], unique=False)

    if "benchmark_history" not in existing:
        op.create_table(
            "benchmark_history",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("overall_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("offensive_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("defensive_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("web_exploitation_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column(
                "network_exploitation_score", sa.Numeric(precision=5, scale=2), nullable=False
            ),
            sa.Column("active_directory_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("linux_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("windows_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("forensics_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column("reporting_score", sa.Numeric(precision=5, scale=2), nullable=False),
            sa.Column(
                "calculated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_benchmark_history_drill_id_drills"),
                ondelete="SET NULL",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_benchmark_history_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_benchmark_history")),
        )

    if "drill_announcements" not in existing:
        op.create_table(
            "drill_announcements",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("priority", sa.String(length=20), nullable=False),
            sa.Column("published_by", sa.Integer(), nullable=True),
            sa.Column(
                "published_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_drill_announcements_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["published_by"],
                ["users.id"],
                name=op.f("fk_drill_announcements_published_by_users"),
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_announcements")),
        )

    if "drill_objectives" not in existing:
        op.create_table(
            "drill_objectives",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("lab_objective_id", sa.Integer(), nullable=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("points", sa.Integer(), nullable=False),
            sa.Column("side", sa.String(length=20), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_drill_objectives_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_objectives")),
        )

    if "drill_participants" not in existing:
        op.create_table(
            "drill_participants",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column("role", sa.String(length=50), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column(
                "joined_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_drill_participants_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_drill_participants_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_participants")),
            sa.UniqueConstraint("drill_id", "user_id", name="uq_drill_participants"),
        )

    if "drill_scenarios" not in existing:
        op.create_table(
            "drill_scenarios",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("lab_id", sa.Integer(), nullable=True),
            sa.Column("scenario_id", sa.Integer(), nullable=True),
            sa.Column("scenario_config", sa.JSON(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_drill_scenarios_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_scenarios")),
        )
        op.create_index("idx_drill_scenarios_drill", "drill_scenarios", ["drill_id"], unique=False)

    if "reports" not in existing:
        op.create_table(
            "reports",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column(
                "status",
                _enum(
                    "draft", "submitted", "under_review", "graded", "approved", name="report_status"
                ),
                nullable=False,
            ),
            sa.Column("report_type", sa.String(length=50), nullable=False),
            sa.Column("quality_score", sa.Numeric(precision=5, scale=2), nullable=True),
            sa.Column("grade", sa.String(length=10), nullable=True),
            sa.Column("word_count", sa.Integer(), nullable=True),
            sa.Column("file_path", sa.String(length=500), nullable=True),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("graded_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("graded_by", sa.Integer(), nullable=True),
            sa.Column("instructor_feedback", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_reports_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["graded_by"],
                ["users.id"],
                name=op.f("fk_reports_graded_by_users"),
                ondelete="SET NULL",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_reports_user_id_users"),
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_reports")),
        )

    if "score_history" not in existing:
        op.create_table(
            "score_history",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column("action", sa.String(length=50), nullable=False),
            sa.Column("points_change", sa.Integer(), nullable=False),
            sa.Column("previous_total", sa.Integer(), nullable=False),
            sa.Column("new_total", sa.Integer(), nullable=False),
            sa.Column("details", sa.JSON(), nullable=False),
            sa.Column(
                "recorded_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_score_history_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_score_history_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_score_history")),
        )

    if "scores" not in existing:
        op.create_table(
            "scores",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column("total_points", sa.Integer(), nullable=False),
            sa.Column("flags_captured", sa.Integer(), nullable=False),
            sa.Column("objectives_completed", sa.Integer(), nullable=False),
            sa.Column("hints_used", sa.Integer(), nullable=False),
            sa.Column("penalty_points", sa.Integer(), nullable=False),
            sa.Column("time_bonus_points", sa.Integer(), nullable=False),
            sa.Column("first_blood_bonus", sa.Integer(), nullable=False),
            sa.Column("completion_time_seconds", sa.Integer(), nullable=True),
            sa.Column("rank_position", sa.Integer(), nullable=True),
            sa.Column(
                "last_updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_scores_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"], ["users.id"], name=op.f("fk_scores_user_id_users"), ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_scores")),
            sa.UniqueConstraint("team_id", "drill_id", name="uq_scores_team_drill"),
            sa.UniqueConstraint("user_id", "drill_id", name="uq_scores_user_drill"),
        )

    if "submissions" not in existing:
        op.create_table(
            "submissions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=True),
            sa.Column("lab_id", sa.Integer(), nullable=True),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column("submission_type", sa.String(length=50), nullable=False),
            sa.Column(
                "status",
                _enum(
                    "pending",
                    "correct",
                    "incorrect",
                    "partial",
                    "reviewed",
                    name="submission_status",
                ),
                nullable=False,
            ),
            sa.Column(
                "submitted_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("reviewed_by", sa.Integer(), nullable=True),
            sa.Column("review_notes", sa.Text(), nullable=True),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_submissions_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["reviewed_by"],
                ["users.id"],
                name=op.f("fk_submissions_reviewed_by_users"),
                ondelete="SET NULL",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_submissions_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_submissions")),
        )

    if "drill_flags" not in existing:
        op.create_table(
            "drill_flags",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("objective_id", sa.Integer(), nullable=True),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("value", sa.String(length=255), nullable=False),
            sa.Column("points", sa.Integer(), nullable=False),
            sa.Column("decay_window_seconds", sa.Integer(), nullable=False),
            sa.Column("sort_order", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_drill_flags_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["objective_id"],
                ["drill_objectives.id"],
                name=op.f("fk_drill_flags_objective_id_drill_objectives"),
                ondelete="SET NULL",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_flags")),
        )
        op.create_index("idx_drill_flags_drill", "drill_flags", ["drill_id"], unique=False)

    if "evidence_submissions" not in existing:
        op.create_table(
            "evidence_submissions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("submission_id", sa.Integer(), nullable=False),
            sa.Column("objective_id", sa.Integer(), nullable=True),
            sa.Column(
                "evidence_type",
                _enum(
                    "screenshot",
                    "command_output",
                    "log_excerpt",
                    "network_capture",
                    "file",
                    "other",
                    name="evidence_type",
                ),
                nullable=False,
            ),
            sa.Column("file_path", sa.String(length=500), nullable=False),
            sa.Column("file_size", sa.BigInteger(), nullable=False),
            sa.Column("mime_type", sa.String(length=100), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(
                ["objective_id"],
                ["drill_objectives.id"],
                name=op.f("fk_evidence_submissions_objective_id_drill_objectives"),
                ondelete="SET NULL",
            ),
            sa.ForeignKeyConstraint(
                ["submission_id"],
                ["submissions.id"],
                name=op.f("fk_evidence_submissions_submission_id_submissions"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_evidence_submissions")),
        )

    if "report_findings" not in existing:
        op.create_table(
            "report_findings",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("report_id", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("description", sa.Text(), nullable=False),
            sa.Column(
                "severity",
                _enum("critical", "high", "medium", "low", "informational", name="severity_level"),
                nullable=False,
            ),
            sa.Column("category", sa.String(length=50), nullable=True),
            sa.Column("evidence", sa.Text(), nullable=True),
            sa.Column("impact", sa.Text(), nullable=True),
            sa.Column("recommendation", sa.Text(), nullable=True),
            sa.Column("cvss_score", sa.Numeric(precision=3, scale=1), nullable=True),
            sa.Column("cwe_id", sa.String(length=20), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["report_id"],
                ["reports.id"],
                name=op.f("fk_report_findings_report_id_reports"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_report_findings")),
        )

    if "report_submissions" not in existing:
        op.create_table(
            "report_submissions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("submission_id", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=255), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("file_path", sa.String(length=500), nullable=True),
            sa.Column("word_count", sa.Integer(), nullable=True),
            sa.Column("quality_score", sa.Numeric(precision=5, scale=2), nullable=True),
            sa.Column("grade", sa.String(length=10), nullable=True),
            sa.ForeignKeyConstraint(
                ["submission_id"],
                ["submissions.id"],
                name=op.f("fk_report_submissions_submission_id_submissions"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_report_submissions")),
        )

    if "drill_flag_submissions" not in existing:
        op.create_table(
            "drill_flag_submissions",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("submission_id", sa.Integer(), nullable=False),
            sa.Column("lab_flag_id", sa.Integer(), nullable=False),
            sa.Column("flag_value", sa.String(length=255), nullable=False),
            sa.Column("is_correct", sa.Boolean(), nullable=False),
            sa.Column("points_earned", sa.Integer(), nullable=False),
            sa.Column("time_decay_factor", sa.Numeric(precision=3, scale=2), nullable=False),
            sa.Column("attempt_number", sa.Integer(), nullable=False),
            sa.Column("hints_used", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["lab_flag_id"],
                ["drill_flags.id"],
                name=op.f("fk_drill_flag_submissions_lab_flag_id_drill_flags"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["submission_id"],
                ["submissions.id"],
                name=op.f("fk_drill_flag_submissions_submission_id_submissions"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_drill_flag_submissions")),
            sa.UniqueConstraint("submission_id", "lab_flag_id", name="uq_flag_submissions"),
        )

    if "evidence" not in existing:
        op.create_table(
            "evidence",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("finding_id", sa.Integer(), nullable=False),
            sa.Column(
                "evidence_type",
                _enum(
                    "screenshot",
                    "command_output",
                    "log_excerpt",
                    "network_capture",
                    "file",
                    "other",
                    name="evidence_type",
                ),
                nullable=False,
            ),
            sa.Column("file_path", sa.String(length=500), nullable=False),
            sa.Column("file_size", sa.BigInteger(), nullable=False),
            sa.Column("mime_type", sa.String(length=100), nullable=True),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["finding_id"],
                ["report_findings.id"],
                name=op.f("fk_evidence_finding_id_report_findings"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_evidence")),
        )

    if "first_bloods" not in existing:
        op.create_table(
            "first_bloods",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("drill_id", sa.Integer(), nullable=False),
            sa.Column("lab_flag_id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("team_id", sa.Integer(), nullable=True),
            sa.Column(
                "captured_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["drill_id"],
                ["drills.id"],
                name=op.f("fk_first_bloods_drill_id_drills"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["lab_flag_id"],
                ["drill_flags.id"],
                name=op.f("fk_first_bloods_lab_flag_id_drill_flags"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_first_bloods_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_first_bloods")),
            sa.UniqueConstraint("drill_id", "lab_flag_id", name="uq_first_bloods"),
        )

    if "submission_attempts" not in existing:
        op.create_table(
            "submission_attempts",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("lab_flag_id", sa.Integer(), nullable=False),
            sa.Column("attempt_number", sa.Integer(), nullable=False),
            sa.Column("flag_value", sa.String(length=255), nullable=False),
            sa.Column("is_correct", sa.Boolean(), nullable=False),
            sa.Column(
                "submitted_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("ip_address", sa.String(length=45), nullable=True),
            sa.ForeignKeyConstraint(
                ["lab_flag_id"],
                ["drill_flags.id"],
                name=op.f("fk_submission_attempts_lab_flag_id_drill_flags"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                name=op.f("fk_submission_attempts_user_id_users"),
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f("pk_submission_attempts")),
            sa.UniqueConstraint(
                "user_id", "lab_flag_id", "attempt_number", name="uq_submission_attempts"
            ),
        )


def downgrade() -> None:
    # Drop what this revision manages, newest dependency first. Like the other
    # drill migrations, downgrading past it removes the drill tables.
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    for name in reversed(_TABLES):
        if name in existing:
            op.drop_table(name)
    if bind.dialect.name == "postgresql":
        for name in _ENUMS:
            postgresql.ENUM(name=name).drop(bind, checkfirst=True)
