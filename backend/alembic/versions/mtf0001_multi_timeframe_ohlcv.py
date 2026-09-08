"""Dong bo da khung thoi gian: ohlcv_bars + symbol_timeframe_sync

Revision ID: mtf0001
Revises: 0015
Create Date: 2026-09-08

KHONG danh so 0016. CSDL dang chay da dung 0016/0017/0018 cho tinh nang "master brain" — nhung
file migration do khong nam trong repo nay (`alembic current` bao "Can't locate revision 0018").
Lay so 0016 la tao ra hai revision trung id, va alembic se hong han khi hai nhanh gap nhau.

Revision nay vi vay la mot **nhanh rieng** moc tu 0015. Alembic chap nhan nhieu head; khi nhanh
brain duoc dua tro lai repo thi ca hai cung ton tai, `alembic upgrade heads` chay du ca hai.

Truoc thay doi nay he thong chi co mot khung: nen ngay o `ohlcv_daily`. Bieu do khach hang vi
the chi ve duoc mot thu duy nhat, trong khi moi phan mem phan tich deu cho doi khung.

Hai bang moi, va **khong dong nao cua `ohlcv_daily` bi cham toi**:

* `ohlcv_bars` — nen cua cac khung khac ngay (1m, 5m, 15m, 30m, 1h). Nen ngay o nguyen cho cu
  vi do la nguon su that cua chien luoc, backtest va phan tich AI; don no sang bang moi la viet
  lai nua he thong ma khong duoc them gi.
* `symbol_timeframe_sync` — moc dong bo gan nhat cua tung cap (ma, khung). Mot ma bay gio co
  nhieu moc chu khong con mot, nen `symbols.last_ohlcv_date` khong con du de biet khung nao
  dang thieu.

Cac khung 3m, 2h, 4h, 1W, 1M **khong** co bang: chung duoc gop tu khung nho hon ngay luc doc.
Ly do o docstring `app.services.market_data.timeframes` — nha cung cap khong phuc vu 240/W/M,
va nen gop luon khop voi nen goc ma nguoi dung dang nhin.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'mtf0001'
down_revision: Union[str, None] = '0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ohlcv_bars',
        sa.Column('symbol', sa.String(length=20), nullable=False),
        sa.Column('timeframe', sa.String(length=8), nullable=False),
        sa.Column('ts', sa.DateTime(), nullable=False),
        sa.Column('open', sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column('high', sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column('low', sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column('close', sa.Numeric(precision=18, scale=4), nullable=False),
        sa.Column('volume', sa.BigInteger(), nullable=False),
        sa.Column('source', sa.String(length=30), nullable=False),
        sa.Column(
            'id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            autoincrement=True,
            nullable=False,
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('symbol', 'timeframe', 'ts', name='uq_ohlcv_bar'),
    )
    op.create_index(
        'ix_ohlcv_bar_symbol_tf_ts', 'ohlcv_bars', ['symbol', 'timeframe', 'ts'], unique=False
    )
    # Don du lieu qua han chay `DELETE ... WHERE timeframe = ? AND ts < ?`. Khong co index nay
    # thi moi lan don la mot lan quet toan bang.
    op.create_index('ix_ohlcv_bar_tf_ts', 'ohlcv_bars', ['timeframe', 'ts'], unique=False)

    op.create_table(
        'symbol_timeframe_sync',
        sa.Column('symbol', sa.String(length=20), nullable=False),
        sa.Column('timeframe', sa.String(length=8), nullable=False),
        sa.Column('last_ts', sa.DateTime(), nullable=True),
        sa.Column('last_synced_at', sa.DateTime(), nullable=True),
        sa.Column('last_error', sa.String(length=255), nullable=True),
        sa.Column(
            'id',
            sa.BigInteger().with_variant(sa.Integer(), 'sqlite'),
            autoincrement=True,
            nullable=False,
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('symbol', 'timeframe', name='uq_symbol_timeframe_sync'),
    )


def downgrade() -> None:
    op.drop_table('symbol_timeframe_sync')
    op.drop_index('ix_ohlcv_bar_tf_ts', table_name='ohlcv_bars')
    op.drop_index('ix_ohlcv_bar_symbol_tf_ts', table_name='ohlcv_bars')
    op.drop_table('ohlcv_bars')
