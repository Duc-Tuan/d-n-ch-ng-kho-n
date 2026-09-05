"""analysis_runs + daily_analyses — phan tich hang ngay cho analyst duyet

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-20
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0011'
down_revision: Union[str, None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PK = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    op.create_table(
        'analysis_runs',
        sa.Column('id', PK, nullable=False),
        sa.Column('run_date', sa.Date(), nullable=False),
        sa.Column('status', sa.String(length=15), nullable=False, server_default='RUNNING'),
        sa.Column('trigger', sa.String(length=20), nullable=False, server_default='scheduler'),
        sa.Column('strategies_total', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('items_total', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('items_done', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('items_failed', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('items_skipped', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('summary', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_analysis_runs_run_date', 'analysis_runs', ['run_date'])
    op.create_index('ix_analysis_runs_status', 'analysis_runs', ['status'])
    op.create_index('ix_analysis_runs_created_at', 'analysis_runs', ['created_at'])

    op.create_table(
        'daily_analyses',
        sa.Column('id', PK, nullable=False),
        sa.Column('run_id', PK, nullable=False),
        sa.Column('run_date', sa.Date(), nullable=False),
        sa.Column('strategy_id', PK, nullable=False),
        sa.Column('symbol', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=10), nullable=False),
        sa.Column('status', sa.String(length=15), nullable=False, server_default='PENDING'),

        sa.Column('has_setup', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('direction', sa.String(length=4), nullable=True),
        sa.Column('entry_price', sa.Numeric(18, 4), nullable=True),
        sa.Column('sl', sa.Numeric(18, 4), nullable=True),
        sa.Column('tp', sa.Numeric(18, 4), nullable=True),
        sa.Column('confidence', sa.String(length=10), nullable=True),

        # BR-848 — ba cột nội bộ, không endpoint nào phía khách được trả về.
        sa.Column('rationale', sa.Text(), nullable=True),
        sa.Column('evidence', sa.JSON(), nullable=True),
        sa.Column('raw_response', sa.JSON(), nullable=True),

        sa.Column('public_title', sa.String(length=255), nullable=True),
        sa.Column('public_summary', sa.Text(), nullable=True),

        sa.Column('reviewed_by', PK, nullable=True),
        sa.Column('reviewed_at', sa.DateTime(), nullable=True),
        sa.Column('reject_reason', sa.String(length=255), nullable=True),
        sa.Column('published_at', sa.DateTime(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_signal_id', PK, nullable=True),

        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),

        sa.ForeignKeyConstraint(['run_id'], ['analysis_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['strategy_id'], ['strategies.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_signal_id'], ['signals.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('run_id', 'strategy_id', 'symbol', name='uq_analysis_run_item'),
    )
    op.create_index('ix_daily_analyses_run_id', 'daily_analyses', ['run_id'])
    op.create_index('ix_daily_analyses_run_date', 'daily_analyses', ['run_date'])
    op.create_index('ix_daily_analyses_strategy_id', 'daily_analyses', ['strategy_id'])
    op.create_index('ix_daily_analyses_symbol', 'daily_analyses', ['symbol'])
    op.create_index('ix_daily_analyses_source', 'daily_analyses', ['source'])
    op.create_index('ix_daily_analyses_status', 'daily_analyses', ['status'])
    op.create_index('ix_daily_analyses_published_at', 'daily_analyses', ['published_at'])
    op.create_index('ix_daily_analyses_created_at', 'daily_analyses', ['created_at'])
    op.create_index(
        'ix_analysis_date_strategy_symbol', 'daily_analyses',
        ['run_date', 'strategy_id', 'symbol'],
    )
    op.create_index('ix_analysis_status_published', 'daily_analyses', ['status', 'published_at'])

    # Cache toan van tai lieu chien luoc — boc mot lan, dung lai cho moi lo.
    op.add_column('strategy_kb_docs', sa.Column('extracted_text', sa.Text(), nullable=True))
    op.add_column('strategy_kb_docs', sa.Column('extracted_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column('strategy_kb_docs', 'extracted_at')
    op.drop_column('strategy_kb_docs', 'extracted_text')
    op.drop_table('daily_analyses')
    op.drop_table('analysis_runs')
