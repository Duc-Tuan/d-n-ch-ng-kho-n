"""strategy rules_json — bộ lọc máy chạy được

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-01
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = '0007'
down_revision: Union[str, None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Cho phép NULL: chiến lược thủ công (analyst tự phát tín hiệu) không có bộ lọc máy chạy.
    op.add_column(
        'strategies',
        sa.Column(
            'rules_json',
            sa.JSON().with_variant(mysql.JSON(), 'mysql'),
            nullable=True,
            comment='Bộ lọc điều kiện cho máy chạy chiến lược',
        ),
    )


def downgrade() -> None:
    op.drop_column('strategies', 'rules_json')
