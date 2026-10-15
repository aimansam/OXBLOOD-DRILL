"""Drill ORM models — Drill product only (Learn lives in its own repo/DB).

Tables: users (token-sub identity), drills, drill_scenarios, drill_participants,
drill_events (unified exercise timeline), drill_objectives (with status),
drill_flags, drill_announcements, submissions, flag_submissions,
evidence_submissions, report_submissions, submission_attempts, scores, score_history,
first_bloods, benchmarks, benchmark_history, reports, report_findings, evidence.
lab_id / team_id columns are plain-integer history refs (Learn tables removed).
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base class for all ORM models."""
    pass


# ============================================================================
# ENUM TYPES
# ============================================================================

class UserRole(str, enum.Enum):
    STUDENT = "student"
    INSTRUCTOR = "instructor"
    TEAM_LEADER = "team_leader"
    ADMINISTRATOR = "administrator"
    OBSERVER = "observer"


class LabStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
    ARCHIVED = "archived"


class LabDifficulty(str, enum.Enum):
    BEGINNER = "beginner"
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"
    EXPERT = "expert"


class DrillStatus(str, enum.Enum):
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class SubmissionStatus(str, enum.Enum):
    PENDING = "pending"
    CORRECT = "correct"
    INCORRECT = "incorrect"
    PARTIAL = "partial"
    REVIEWED = "reviewed"


class ReportStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    GRADED = "graded"
    APPROVED = "approved"


class SeverityLevel(str, enum.Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFORMATIONAL = "informational"


class EvidenceType(str, enum.Enum):
    SCREENSHOT = "screenshot"
    COMMAND_OUTPUT = "command_output"
    LOG_EXCERPT = "log_excerpt"
    NETWORK_CAPTURE = "network_capture"
    FILE = "file"
    OTHER = "other"


class AuditAction(str, enum.Enum):
    USER_CREATED = "user.created"
    USER_UPDATED = "user.updated"
    USER_DELETED = "user.deleted"
    USER_LOGIN = "user.login"
    USER_LOGOUT = "user.logout"
    LAB_CREATED = "lab.created"
    LAB_UPDATED = "lab.updated"
    LAB_PUBLISHED = "lab.published"
    LAB_ARCHIVED = "lab.archived"
    DRILL_CREATED = "drill.created"
    DRILL_STARTED = "drill.started"
    DRILL_COMPLETED = "drill.completed"
    FLAG_SUBMITTED = "flag.submitted"
    FLAG_CORRECT = "flag.correct"
    FLAG_INCORRECT = "flag.incorrect"
    REPORT_CREATED = "report.created"
    REPORT_SUBMITTED = "report.submitted"
    REPORT_GRADED = "report.graded"
    TEAM_CREATED = "team.created"
    TEAM_UPDATED = "team.updated"
    TEAM_MEMBER_ADDED = "team.member_added"
    TEAM_MEMBER_REMOVED = "team.member_removed"
    SCORE_UPDATED = "score.updated"
    BENCHMARK_CALCULATED = "benchmark.calculated"
    ADMIN_ACTION = "admin.action"


class NotificationType(str, enum.Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    SUCCESS = "success"
    ACHIEVEMENT = "achievement"
    DEADLINE = "deadline"


class LearningPathStatus(str, enum.Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"



# ============================================================================
# MODULE 1: USER MANAGEMENT
# ============================================================================

class User(Base):
    """Main user accounts table."""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sub: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name='user_role', values_callable=lambda x: [e.value for e in x]), nullable=False, default=UserRole.STUDENT)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


    __table_args__ = (
        Index("idx_users_username", "username"),
        Index("idx_users_email", "email"),
        Index("idx_users_role", "role"),
        Index("idx_users_active", "is_active", postgresql_where=text("deleted_at IS NULL")),
    )


class Drill(Base):
    """Cyber drill exercise instances."""
    __tablename__ = "drills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    # Read-only reference to the Learn catalog (Learn DB owns labs).
    # No FK constraint so Learn tables can live in a separate database.
    # New code should use scenario_id (Drill catalog, scenarios table).
    lab_id: Mapped[Optional[int]] = mapped_column(Integer)
    scenario_id: Mapped[Optional[int]] = mapped_column(Integer)
    status: Mapped[DrillStatus] = mapped_column(Enum(DrillStatus, name='drill_status', values_callable=lambda x: [e.value for e in x]), nullable=False, default=DrillStatus.SCHEDULED)
    drill_type: Mapped[str] = mapped_column(String(50), nullable=False, default="individual")
    scheduled_start_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    scheduled_end_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    actual_start_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    actual_end_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    duration_limit_minutes: Mapped[Optional[int]] = mapped_column(Integer)
    max_participants: Mapped[Optional[int]] = mapped_column(Integer)
    rules: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    environment_config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("idx_drills_status", "status"),
        Index("idx_drills_lab", "lab_id"),
        Index("idx_drills_scheduled", "scheduled_start_at"),
    )


class DrillEnvironmentLock(Base):
    """Persistent owner for the single shared cyber-drill environment.

    The lock is deliberately a row rather than an in-process mutex. The API
    can restart without losing ownership, and two API workers cannot both
    start a VLAN/IP-conflicting range.
    """

    __tablename__ = "drill_environment_locks"
    __table_args__ = (
        UniqueConstraint("lock_key", name="uq_drill_environment_locks_key"),
        Index("idx_drill_environment_locks_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lock_key: Mapped[str] = mapped_column(String(32), nullable=False, default="default")
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    owner_sub: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    owner_role: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="released")
    acquired_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    released_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class DrillScenario(Base):
    """Link drills to scenarios with overrides.

    lab_id is a read-only Learn-catalog reference (no FK — Learn DB owns
    labs). scenario_id points at the Drill catalog (scenarios table);
    new links should use scenario_id.
    """
    __tablename__ = "drill_scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    lab_id: Mapped[Optional[int]] = mapped_column(Integer)
    scenario_id: Mapped[Optional[int]] = mapped_column(Integer)
    scenario_config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_drill_scenarios_drill", "drill_id"),
    )


class DrillParticipant(Base):
    """Track users participating in drills."""
    __tablename__ = "drill_participants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    role: Mapped[str] = mapped_column(String(50), nullable=False, default="participant")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="registered")
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("drill_id", "user_id", name="uq_drill_participants"),
    )


class DrillEvent(Base):
    """Unified per-drill exercise timeline.

    One chronological feed for the active view: lifecycle transitions,
    correct flag captures, announcements, and lead notes. Stored
    Drill-side so the portal never stitches audit + announcements
    client-side.
    """
    __tablename__ = "drill_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    detail: Mapped[Optional[str]] = mapped_column(Text)
    side: Mapped[Optional[str]] = mapped_column(String(20))
    actor: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_drill_events_drill", "drill_id"),
        Index("idx_drill_events_kind", "kind"),
    )


class DrillObjective(Base):
    """Objectives specific to drill instances.

    lab_objective_id is a read-only Learn-catalog reference (no FK — Learn
    DB owns lab_objectives). New objectives are Drill-native.
    """
    __tablename__ = "drill_objectives"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    lab_objective_id: Mapped[Optional[int]] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    side: Mapped[Optional[str]] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class DrillFlag(Base):
    """Drill-native flags (owned by the Drill DB).

    Replaces the Learn LabFlag dependency for flag submit: a DrillFlag
    belongs to a drill (+ optional objective) and carries the secret value,
    points, and decay window. Learn lab_flags stay in the Learn DB.
    """
    __tablename__ = "drill_flags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    objective_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drill_objectives.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="flag")
    value: Mapped[str] = mapped_column(String(255), nullable=False)
    points: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    decay_window_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=1800)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        Index("idx_drill_flags_drill", "drill_id"),
    )


class DrillAnnouncement(Base):
    """Announcements for drills."""
    __tablename__ = "drill_announcements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    published_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ============================================================================
# MODULE 5: SUBMISSION SYSTEM
# ============================================================================

class Submission(Base):
    """Parent table for all submission types."""
    __tablename__ = "submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"))
    lab_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; labs table removed
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    submission_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[SubmissionStatus] = mapped_column(Enum(SubmissionStatus, name='submission_status', values_callable=lambda x: [e.value for e in x]), nullable=False, default=SubmissionStatus.PENDING)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    review_notes: Mapped[Optional[str]] = mapped_column(Text)


class FlagSubmission(Base):
    """Flag capture attempts (Drill v2; v1 runs use models.flag_submissions)."""
    __tablename__ = "drill_flag_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(Integer, ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False)
    lab_flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("drill_flags.id", ondelete="CASCADE"), nullable=False)
    flag_value: Mapped[str] = mapped_column(String(255), nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    points_earned: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    time_decay_factor: Mapped[float] = mapped_column(Numeric(3, 2), nullable=False, default=1.00)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    hints_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint("submission_id", "lab_flag_id", name="uq_flag_submissions"),
    )


class EvidenceSubmission(Base):
    """Evidence file submissions."""
    __tablename__ = "evidence_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(Integer, ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False)
    objective_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drill_objectives.id", ondelete="SET NULL"))
    evidence_type: Mapped[EvidenceType] = mapped_column(Enum(EvidenceType, name='evidence_type', values_callable=lambda x: [e.value for e in x]), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(String(100))
    description: Mapped[Optional[str]] = mapped_column(Text)
    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class ReportSubmission(Base):
    """Report submissions."""
    __tablename__ = "report_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    submission_id: Mapped[int] = mapped_column(Integer, ForeignKey("submissions.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    file_path: Mapped[Optional[str]] = mapped_column(String(500))
    word_count: Mapped[Optional[int]] = mapped_column(Integer)
    quality_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    grade: Mapped[Optional[str]] = mapped_column(String(10))


class SubmissionAttempt(Base):
    """Track all flag submission attempts (Drill-native drill_flags)."""
    __tablename__ = "submission_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    lab_flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("drill_flags.id", ondelete="CASCADE"), nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    flag_value: Mapped[str] = mapped_column(String(255), nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    ip_address: Mapped[Optional[str]] = mapped_column(String(45))

    __table_args__ = (
        UniqueConstraint("user_id", "lab_flag_id", "attempt_number", name="uq_submission_attempts"),
    )



# ============================================================================
# MODULE 6: SCORING SYSTEM
# ============================================================================

class Score(Base):
    """Current scores for users/teams in drills."""
    __tablename__ = "scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"))
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    total_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    flags_captured: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    objectives_completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    hints_used: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    penalty_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    time_bonus_points: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_blood_bonus: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_time_seconds: Mapped[Optional[int]] = mapped_column(Integer)
    rank_position: Mapped[Optional[int]] = mapped_column(Integer)
    last_updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "drill_id", name="uq_scores_user_drill"),
        UniqueConstraint("team_id", "drill_id", name="uq_scores_team_drill"),
    )


class ScoreHistory(Base):
    """Detailed score changes over time."""
    __tablename__ = "score_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"))
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    points_change: Mapped[int] = mapped_column(Integer, nullable=False)
    previous_total: Mapped[int] = mapped_column(Integer, nullable=False)
    new_total: Mapped[int] = mapped_column(Integer, nullable=False)
    details: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class FirstBlood(Base):
    """Track first capture of each flag per drill."""
    __tablename__ = "first_bloods"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[int] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"), nullable=False)
    lab_flag_id: Mapped[int] = mapped_column(Integer, ForeignKey("drill_flags.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("drill_id", "lab_flag_id", name="uq_first_bloods"),
    )


# ============================================================================
# MODULE 7: BENCHMARKING SYSTEM
# ============================================================================

class Benchmark(Base):
    """Skill benchmark scores for users."""
    __tablename__ = "benchmarks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    overall_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    offensive_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    defensive_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    web_exploitation_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    network_exploitation_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    active_directory_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    linux_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    windows_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    forensics_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    reporting_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    total_drills_completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_flags_captured: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    average_completion_time_seconds: Mapped[Optional[int]] = mapped_column(Integer)
    last_calculated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class BenchmarkHistory(Base):
    """Score progression over time."""
    __tablename__ = "benchmark_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drills.id", ondelete="SET NULL"))
    overall_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    offensive_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    defensive_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    web_exploitation_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    network_exploitation_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    active_directory_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    linux_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    windows_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    forensics_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    reporting_score: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    calculated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ============================================================================
# MODULE 8: REPORTING SYSTEM
# ============================================================================

class Report(Base):
    """After-action reports and assessments."""
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    drill_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("drills.id", ondelete="CASCADE"))
    user_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    team_id: Mapped[Optional[int]] = mapped_column(Integer)  # history ref; teams table removed
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[ReportStatus] = mapped_column(Enum(ReportStatus, name='report_status', values_callable=lambda x: [e.value for e in x]), nullable=False, default=ReportStatus.DRAFT)
    report_type: Mapped[str] = mapped_column(String(50), nullable=False, default="after_action")
    quality_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    grade: Mapped[Optional[str]] = mapped_column(String(10))
    word_count: Mapped[Optional[int]] = mapped_column(Integer)
    file_path: Mapped[Optional[str]] = mapped_column(String(500))
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    graded_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    graded_by: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    instructor_feedback: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class ReportFinding(Base):
    """Individual findings within reports."""
    __tablename__ = "report_findings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    report_id: Mapped[int] = mapped_column(Integer, ForeignKey("reports.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[SeverityLevel] = mapped_column(Enum(SeverityLevel, name='severity_level', values_callable=lambda x: [e.value for e in x]), nullable=False)
    category: Mapped[Optional[str]] = mapped_column(String(50))
    evidence: Mapped[Optional[str]] = mapped_column(Text)
    impact: Mapped[Optional[str]] = mapped_column(Text)
    recommendation: Mapped[Optional[str]] = mapped_column(Text)
    cvss_score: Mapped[Optional[float]] = mapped_column(Numeric(3, 1))
    cwe_id: Mapped[Optional[str]] = mapped_column(String(20))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Evidence(Base):
    """Evidence files for findings."""
    __tablename__ = "evidence"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    finding_id: Mapped[int] = mapped_column(Integer, ForeignKey("report_findings.id", ondelete="CASCADE"), nullable=False)
    evidence_type: Mapped[EvidenceType] = mapped_column(Enum(EvidenceType, name='evidence_type', values_callable=lambda x: [e.value for e in x]), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(String(100))
    description: Mapped[Optional[str]] = mapped_column(Text)
    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ============================================================================
# MODULE 9: LEARNING PATH SYSTEM
# ============================================================================
