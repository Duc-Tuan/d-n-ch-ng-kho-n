"""phan tich theo yeu cau + tin tuc dan nguon + strategies.kind

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-31

Khong DROP hai bang cua co che phan tich hang ngay (`analysis_runs`, `daily_analyses`): du lieu
lich su van con gia tri tra cuu, va khong con dong ma nao doc chung nua nen giu lai la vo hai.
Muon don han thi xoa tay sau khi da doi chieu.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0012'
down_revision: Union[str, None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PK = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    # ---------- strategies.kind ----------
    op.add_column(
        'strategies',
        sa.Column('kind', sa.String(length=10), nullable=False, server_default='RULE'),
    )
    op.create_index('ix_strategies_kind', 'strategies', ['kind'])

    # Chien luoc dang co tai lieu dinh kem thi thuoc loai DOCUMENT — dung dung nhanh ma
    # `job_ai_analysis` cu da chon, nen du lieu sau khi nang cap chay giong het truoc do.
    op.execute(
        """
        UPDATE strategies
           SET kind = 'DOCUMENT'
         WHERE id IN (
               SELECT strategy_id FROM strategy_kb_docs
         )
        """
    )

    # ---------- documents.owner_user_id ----------
    # Tai lieu khach tu tai len cho chien luoc ca nhan. NULL = kho chung nhu truoc.
    op.add_column('documents', sa.Column('owner_user_id', PK, nullable=True))
    op.create_index('ix_documents_owner_user_id', 'documents', ['owner_user_id'])

    # ---------- phan tich theo yeu cau ----------
    op.create_table(
        'symbol_analyses',
        sa.Column('id', PK, nullable=False),
        sa.Column('analysis_date', sa.Date(), nullable=False),
        sa.Column('strategy_id', PK, nullable=False),
        sa.Column('symbol', sa.String(length=20), nullable=False),
        sa.Column('source', sa.String(length=10), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False, server_default='QUEUED'),
        sa.Column('requested_by', PK, nullable=True),
        sa.Column('view_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.Column('title', sa.String(length=255), nullable=True),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('rationale', sa.Text(), nullable=True),
        sa.Column('evidence', sa.JSON(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(['strategy_id'], ['strategies.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('analysis_date', 'strategy_id', 'symbol',
                            name='uq_symbol_analysis_day'),
    )
    op.create_index('ix_symbol_analyses_analysis_date', 'symbol_analyses', ['analysis_date'])
    op.create_index('ix_symbol_analyses_strategy_id', 'symbol_analyses', ['strategy_id'])
    op.create_index('ix_symbol_analyses_symbol', 'symbol_analyses', ['symbol'])
    op.create_index('ix_symbol_analyses_source', 'symbol_analyses', ['source'])
    op.create_index('ix_symbol_analyses_status', 'symbol_analyses', ['status'])
    op.create_index('ix_symbol_analyses_requested_by', 'symbol_analyses', ['requested_by'])
    op.create_index('ix_symbol_analysis_lookup', 'symbol_analyses',
                    ['strategy_id', 'symbol', 'analysis_date'])
    op.create_index('ix_symbol_analysis_status', 'symbol_analyses', ['status', 'created_at'])

    op.create_table(
        'symbol_analysis_setups',
        sa.Column('id', PK, nullable=False),
        sa.Column('analysis_id', PK, nullable=False),
        sa.Column('direction', sa.String(length=4), nullable=False),
        sa.Column('entry_price', sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column('sl', sa.Numeric(precision=18, scale=4), nullable=True),
        sa.Column('tp', sa.Numeric(precision=18, scale=4), nullable=True),
        sa.Column('confidence', sa.String(length=10), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['analysis_id'], ['symbol_analyses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_symbol_analysis_setups_analysis_id', 'symbol_analysis_setups',
                    ['analysis_id'])

    op.create_table(
        'analysis_quota_usage',
        sa.Column('id', PK, nullable=False),
        sa.Column('user_id', PK, nullable=False),
        sa.Column('usage_date', sa.Date(), nullable=False),
        sa.Column('analysis_id', PK, nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_analysis_quota_usage_user_id', 'analysis_quota_usage', ['user_id'])
    op.create_index('ix_analysis_quota_usage_usage_date', 'analysis_quota_usage', ['usage_date'])
    op.create_index('ix_analysis_quota_usage_analysis_id', 'analysis_quota_usage', ['analysis_id'])
    op.create_index('ix_quota_user_date', 'analysis_quota_usage', ['user_id', 'usage_date'])

    # ---------- tin tuc dan nguon ----------
    op.create_table(
        'news_items',
        sa.Column('id', PK, nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('url', sa.String(length=1000), nullable=False),
        sa.Column('source_name', sa.String(length=120), nullable=True),
        sa.Column('published_at', sa.DateTime(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('click_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', PK, nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_news_items_source_name', 'news_items', ['source_name'])
    op.create_index('ix_news_items_published_at', 'news_items', ['published_at'])
    op.create_index('ix_news_items_is_active', 'news_items', ['is_active'])
    op.create_index('ix_news_active_order', 'news_items',
                    ['is_active', 'sort_order', 'published_at'])


def downgrade() -> None:
    op.drop_table('news_items')
    op.drop_table('analysis_quota_usage')
    op.drop_table('symbol_analysis_setups')
    op.drop_table('symbol_analyses')
    op.drop_index('ix_documents_owner_user_id', table_name='documents')
    op.drop_column('documents', 'owner_user_id')
    op.drop_index('ix_strategies_kind', table_name='strategies')
    op.drop_column('strategies', 'kind')
