"""media_assets — ảnh nhúng trong bài viết

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-01
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0008'
down_revision: Union[str, None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'media_assets',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
        sa.Column('stored_name', sa.String(length=255), nullable=False),
        sa.Column('original_name', sa.String(length=255), nullable=False),
        sa.Column('mime_type', sa.String(length=100), nullable=False),
        sa.Column('file_size', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
        sa.Column('width', sa.Integer(), nullable=True),
        sa.Column('height', sa.Integer(), nullable=True),
        sa.Column('alt_text', sa.String(length=255), nullable=True),
        sa.Column('uploaded_by', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('stored_name', name='uq_media_stored_name'),
    )
    op.create_index('ix_media_assets_stored_name', 'media_assets', ['stored_name'])
    op.create_index('ix_media_assets_uploaded_by', 'media_assets', ['uploaded_by'])
    op.create_index('ix_media_assets_is_active', 'media_assets', ['is_active'])


def downgrade() -> None:
    op.drop_index('ix_media_assets_is_active', table_name='media_assets')
    op.drop_index('ix_media_assets_uploaded_by', table_name='media_assets')
    op.drop_index('ix_media_assets_stored_name', table_name='media_assets')
    op.drop_table('media_assets')
