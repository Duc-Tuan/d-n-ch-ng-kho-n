"""tien trinh keo tin theo tung nguon

Revision ID: 0014
Revises: 0013
Create Date: 2026-09-01

Them hai cot tren `news_sources` de man quan tri theo doi duoc mot luot keo dang chay:

* `last_started_at` — moc bat dau luot gan nhat. Ca cac nguon trong cung mot luot duoc dong
  **cung mot moc**, nen giao dien nhan ra dau la mot me de tinh "xong may tren tong so may".
* `last_added` — so tin them duoc rieng o luot gan nhat. `item_count` van la tong cong don.

Cot `last_status` khong doi kieu, chi nhan them hai gia tri `PENDING` va `RUNNING`.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0014'
down_revision: Union[str, None] = '0013'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('news_sources', sa.Column('last_started_at', sa.DateTime(), nullable=True))
    op.add_column(
        'news_sources',
        sa.Column('last_added', sa.Integer(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('news_sources', 'last_added')
    op.drop_column('news_sources', 'last_started_at')
