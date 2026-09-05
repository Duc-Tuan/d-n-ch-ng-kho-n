"""Xac nhan doi mat khau nhan vien bang ma gui qua email

Revision ID: 0009
Revises: 0008
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0009'
down_revision: Union[str, None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'staff_password_changes',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
                  autoincrement=True, nullable=False),
        sa.Column('staff_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), nullable=False),
        sa.Column('new_password_hash', sa.String(length=255), nullable=False),
        sa.Column('otp_hash', sa.String(length=64), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('request_ip', sa.String(length=45), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_staff_password_changes_staff_id'),
        'staff_password_changes', ['staff_id'], unique=False,
    )
    op.create_index(
        op.f('ix_staff_password_changes_created_at'),
        'staff_password_changes', ['created_at'], unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_staff_password_changes_created_at'),
                  table_name='staff_password_changes')
    op.drop_index(op.f('ix_staff_password_changes_staff_id'),
                  table_name='staff_password_changes')
    op.drop_table('staff_password_changes')
