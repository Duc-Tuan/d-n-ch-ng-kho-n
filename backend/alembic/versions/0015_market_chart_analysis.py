"""phan tich theo bieu do (chi bao) tren man bang gia

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-03

Nut Phan tich o man bang gia dung lai chinh bang `symbol_analyses`, chu khong dung mot bang
rieng: hai loai phan tich cho ra **cung mot hinh dang ket qua** (tieu de, ban tin, ly do, kich
ban vao lenh), va tach bang se phai nhan doi ca worker, ca MCP tool, ca schema, ca giao dien.

Ba thay doi, deu la them/noi long — khong dong nao cua co che cu doi nghia:

* `strategy_id` cho phep NULL: phan tich theo bieu do khong gan voi chien luoc nao.
* `context`: chup lai bo chi bao dang bat tren bieu do (ten, tham so, gia tri gan nhat).
* `context_key`: van tay cua `context` de bam lai cung mot bo trong ngay thi doc lai ban cu.

Rang buoc `uq_symbol_analysis_day` giu nguyen. No van chan chay trung cho phan tich theo chien
luoc; con voi `strategy_id` NULL thi SQL coi moi NULL la khac nhau nen no khong chan gi — dung
nhu mong muon, vi moi bo chi bao la mot ban phan tich rieng.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '0015'
down_revision: Union[str, None] = '0014'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PK = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')


def upgrade() -> None:
    op.alter_column('symbol_analyses', 'strategy_id', existing_type=PK, nullable=True)
    op.add_column('symbol_analyses', sa.Column('context', sa.JSON(), nullable=True))
    op.add_column('symbol_analyses', sa.Column('context_key', sa.String(length=64), nullable=True))
    op.create_index('ix_symbol_analyses_context_key', 'symbol_analyses', ['context_key'])


def downgrade() -> None:
    # Xoa cac ban phan tich theo bieu do TRUOC khi siet lai cot: chung co `strategy_id` NULL nen
    # de nguyen thi lenh ALTER se hong giua chung, va bang mac ket o trang thai nua voi.
    op.execute('DELETE FROM symbol_analyses WHERE strategy_id IS NULL')
    op.drop_index('ix_symbol_analyses_context_key', table_name='symbol_analyses')
    op.drop_column('symbol_analyses', 'context_key')
    op.drop_column('symbol_analyses', 'context')
    op.alter_column('symbol_analyses', 'strategy_id', existing_type=PK, nullable=False)
