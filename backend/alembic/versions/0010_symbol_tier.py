"""Them cot tier cho danh muc ma (A/B/C)

Revision ID: 0010
Revises: 0009
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0010'
down_revision: Union[str, None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('symbols', sa.Column('tier', sa.String(length=1), nullable=True))
    op.create_index(op.f('ix_symbols_tier'), 'symbols', ['tier'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_symbols_tier'), table_name='symbols')
    op.drop_column('symbols', 'tier')
